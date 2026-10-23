// Paying buy for an order's VM. A payment on Celo cannot be taken back, so an order pays for its VM at most once and
// never more than VM_MAX_ATOMIC: the intent is written before anything is quoted, the authorization before it goes out,
// and a payment whose outcome is not clear is looked up on the chain (resolveVmPayment), never paid again. The step that
// calls payForVm runs with maxRetries = 0, and an attempt after the first one does not pay either.
import { SETTLEMENT_GRACE_SECONDS, type BuyPort, type OrderStore, type RentVmResult, type SettlementVerdict, type VmPaymentOutcome } from '../ports';

export const VM_URL = 'https://usebuy.ai/google/vm';
/** buy quoted the e2-medium at 67011 atomic units of USDT on 17/10: the cap leaves a little room, and no more. */
export const VM_MAX_ATOMIC = 70_000n;
export const VM_MACHINE_TYPE = 'e2-medium';

/** The order's VM payment, in the store. */
export const vmPaymentKey = (orderId: string): string => `${orderId}:vm`;

/**
 * - `paid`: buy served the VM. `pollUrl` is its tracking URL, when buy gave one.
 * - `rejected`: nothing was paid, and `reason` says why (`daily-cap`, a buy error code such as `amount_exceeds_max`…).
 * - `uncertain`: the money may have moved. `resolveVmPayment` tells, from the chain; paying again never does. `pollUrl`
 *   is there when buy gave one: it cannot be had again, and the flow's step keeps what this returns when the store fails.
 */
export type PayResult =
  | { status: 'paid'; pollUrl: string | null }
  | { status: 'rejected'; reason: string }
  | { status: 'uncertain'; reason: string; pollUrl?: string };

export type VmPaymentDeps = {
  store: Pick<OrderStore, 'insertPaymentIntent' | 'updatePayment' | 'addCost' | 'buySpendSince'>;
  buy: Pick<BuyPort, 'rentVm'>;
  /** BUY_DAILY_CAP_USD: what buy may cost in a UTC day, every order together. */
  dailyCapUsd: number;
};

/** Dollars in millionths. A 6-decimal stablecoin's atomic unit is one of them, and whole numbers compare exactly. */
const micros = (usd: number): number => Math.round(usd * 1e6);

const DAY_MS = 24 * 60 * 60 * 1000;

export const startOfUtcDay = (at: Date): Date => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

/** The seconds from `at` to the next UTC day, when the daily buy cap starts again. */
export const secondsToNextUtcDay = (at: Date): number => Math.ceil((startOfUtcDay(at).getTime() + DAY_MS - at.getTime()) / 1000);

export type VmCapacityDeps = {
  store: Pick<OrderStore, 'buySpendSince' | 'paidWithoutVmPaymentSince'>;
  /** BUY_DAILY_CAP_USD. */
  dailyCapUsd: number;
};

/**
 * Whether today's buy cap has room for the VM of one more order: what buy was paid since the UTC day began, plus
 * VM_MAX_ATOMIC for each order paid today whose VM payment is still to come and one more for the new order, is within
 * the cap. It is asked before an order is taken, so that no order is paid only to be refunded at its VM for the cap
 * (which payForVm still checks, at the last moment). A store that fails to answer throws: that is never room.
 */
export async function hasVmCapacity({ store, dailyCapUsd }: VmCapacityDeps, now: Date): Promise<boolean> {
  const today = startOfUtcDay(now);
  const [spent, waiting] = await Promise.all([store.buySpendSince(today), store.paidWithoutVmPaymentSince(today)]);
  return micros(spent) + Number(VM_MAX_ATOMIC) * (waiting + 1) <= micros(dailyCapUsd);
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

export async function payForVm(input: { orderId: string; script: string; attempt: number }, deps: VmPaymentDeps): Promise<PayResult> {
  const { orderId, script, attempt } = input;
  const { store, buy, dailyCapUsd } = deps;
  // The step runs once. If the platform runs it again anyway, the first attempt may have paid: that is for the chain to say.
  if (attempt > 1) return { status: 'uncertain', reason: 'retry-attempt' };

  const key = vmPaymentKey(orderId);
  // First of all, before a quote: of two tries for the same order, only the one that writes the intent goes on.
  if (!(await store.insertPaymentIntent({ key, orderId, kind: 'vm', maxAtomic: VM_MAX_ATOMIC }))) {
    return { status: 'uncertain', reason: 'intent-exists' };
  }

  // What the hooks learn. `sent` is true from the moment the payment may have gone out.
  const seen: { sent: boolean; refusal?: string; outcome?: VmPaymentOutcome; txHash?: string; pollUrl: string | null } = { sent: false, pollUrl: null };

  // Writes how it ended, with what is known of the answer (a write in onPayment may have failed), and answers even if
  // this write fails too: the poll URL then lives on in the result.
  const end = async (status: 'rejected' | 'uncertain', reason: string): Promise<PayResult> => {
    const { outcome, txHash, pollUrl } = seen;
    try {
      await store.updatePayment(key, { status, reason, outcome, txHash, pollUrl: pollUrl ?? undefined });
    } catch (error) {
      // Neither the URL nor the store's message (which may quote the values it was writing).
      console.error('[vm_payment_unrecorded]', orderId, status, error instanceof Error ? error.name : typeof error);
    }
    if (status === 'rejected') return { status, reason };
    return pollUrl === null ? { status, reason } : { status, reason, pollUrl };
  };

  let result: RentVmResult;
  try {
    result = await buy.rentVm({
      body: { script, machineType: VM_MACHINE_TYPE },
      maxAtomic: VM_MAX_ATOMIC,
      beforePayment: async ({ asset, amount, payTo, authorization }) => {
        // Checked at the last moment, against the cap the payment could reach.
        const spent = await store.buySpendSince(startOfUtcDay(new Date()));
        if (micros(spent) + Number(VM_MAX_ATOMIC) > micros(dailyCapUsd)) {
          seen.refusal = 'daily-cap';
          throw new Error('The daily buy cap would be passed.');
        }
        // Written before it goes out, so an answer that never comes can still be looked up on the chain. And counted
        // now: from here on the money may move, whatever buy answers. buy is paid in USDT, 6 decimals: atomic/1e6 dollars.
        await store.updatePayment(key, { asset, amount, payTo, authorization });
        await store.addCost(orderId, 'buy:vm', Number(amount) / 1e6, 'buy');
        seen.sent = true;
      },
      onPayment: async ({ asset, amount, payTo, authorization, outcome, txHash, poll }) => {
        // Kept in memory first, so that a write that fails loses none of it.
        Object.assign(seen, { outcome, txHash, pollUrl: poll ?? null });
        const unseen = !seen.sent;
        seen.sent = true;
        await store.updatePayment(key, { status: outcome === 'confirmed' ? 'paid' : 'uncertain', outcome, txHash, pollUrl: poll, asset, amount, payTo, authorization });
        // A payment that went out without beforePayment (an adapter that did not see it go): it counts all the same.
        if (unseen) await store.addCost(orderId, 'buy:vm', Number(amount) / 1e6, 'buy');
      },
    });
  } catch (error) {
    // Only a hook throws out of rentVm: before the payment went out, nothing was paid; after, it may have been.
    return end(seen.sent ? 'uncertain' : 'rejected', messageOf(error));
  }

  if (result.outcome === 'confirmed') return { status: 'paid', pollUrl: seen.pollUrl };
  if (result.outcome === 'not_paid' && !seen.sent) return end('rejected', seen.refusal ?? result.reason ?? 'not-paid');
  return end('uncertain', result.reason ?? result.outcome);
}

export type ResolveVmPaymentDeps = {
  store: Pick<OrderStore, 'getPayment' | 'updatePayment'>;
  buy: Pick<BuyPort, 'authorizationSettled'>;
};

/**
 * Whether buy got paid for the order's VM. `settled` and `unsettled` are final and written to the payment; `unknown`
 * is not (the chain could not be read, or the payment may still land), and leaves it as it was.
 */
export async function resolveVmPayment(orderId: string, deps: ResolveVmPaymentDeps): Promise<SettlementVerdict> {
  const { store, buy } = deps;
  const key = vmPaymentKey(orderId);
  const payment = await store.getPayment(key);
  // The intent comes before anything is signed: without one, nothing was.
  if (payment === null) return 'unsettled';
  switch (payment.status) {
    // buy served the VM, or the chain already said it was paid.
    case 'paid':
    case 'settled':
      return 'settled';
    // It never went out, or the chain already said it can never land.
    case 'rejected':
    case 'unsettled':
      return 'unsettled';
  }

  const { asset, amount, payTo, authorization } = payment;
  // An intent without its authorization: not signed yet, so not on the chain, but it may still be on its way.
  if (asset === null || amount === null || payTo === null || authorization === null) return 'unknown';

  // Whether buy's wallet got the quoted amount with this authorization: not only whether its nonce was spent.
  const answer = await buy.authorizationSettled({ asset, authorization, to: payTo, value: amount });
  if (answer === 'settled') {
    await store.updatePayment(key, { status: 'settled' });
    return 'settled';
  }
  // The token takes an authorization until validBefore, by the chain's clock: only the chain says it can no longer
  // settle (`unsettled`; `pending` while it still can), and this clock must be past it too, by the grace minute it may
  // be ahead by.
  if (answer === 'unsettled' && BigInt(Math.floor(Date.now() / 1000)) >= BigInt(authorization.validBefore) + SETTLEMENT_GRACE_SECONDS) {
    await store.updatePayment(key, { status: 'unsettled' });
    return 'unsettled';
  }
  return 'unknown';
}
