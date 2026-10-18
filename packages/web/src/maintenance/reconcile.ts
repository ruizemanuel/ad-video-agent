// The reconciliation, run by the cron every 10 minutes. It closes what the paying request could not: a settlement
// that landed on chain but was never reported (the facilitator timed out, or the request died), an authorization
// that expired without settling, a paid order whose run never started, a refund that landed after the flow gave up on
// it or stopped watching it (the run died, or the store failed between two writes). It only reads the chain for refunds:
// it never signs nor sends one. It also keeps the refunds that could not be paid in the log, every run, until someone
// pays them by hand.
import { markPaidAndStart, startRun } from '../payments/orders';
import { confirmRefund } from '../payments/refunds';
import { SETTLEMENT_GRACE_SECONDS, type BuyPort, type OrderStore, type RefundPort, type RefundStatus } from '../ports';

const MINUTE_MS = 60_000;
/** How old an order has to be before this looks at it: the request that made it has had time to finish. */
const GRACE_MS = 5 * MINUTE_MS;
/**
 * How long a refund may go without a write before its order, still `refunding`, is taken as left by its run. The flow
 * watches a refund for about 10 minutes (40 looks, 15 s apart): this leaves it well past that.
 */
export const REFUND_WINDOW_MS = 30 * MINUTE_MS;

export type ReconcileDeps = {
  store: Pick<
    OrderStore,
    | 'ordersAwaitingSettlement'
    | 'paidWithoutRun'
    | 'refundFailures'
    | 'stalledRefunds'
    | 'findOrderByPayment'
    | 'getOrder'
    | 'transition'
    | 'setStep'
    | 'setRunId'
    | 'getRefund'
    | 'updateRefund'
    | 'refundsByNonce'
  >;
  buy: Pick<BuyPort, 'authorizationSettled'>;
  /** Only to read the chain: the reconciliation sends no refund. */
  refunds: Pick<RefundPort, 'receipt' | 'nonceUsed' | 'minedSafely'>;
  /** The wallet the payments go to (PAYTO_ADDRESS): a settlement counts only if it paid this one. */
  payTo: string;
};

/** The refunds that may still have landed: sent, or about to be. */
const MAY_HAVE_LANDED: readonly RefundStatus[] = ['prepared', 'broadcast', 'confirmed'];

/** The ids of the orders it started, the ones it gave up as unpaid, and the ones whose refund has failed. */
export type ReconcileResult = { started: string[]; unpaid: string[]; refundFailed: string[] };

/**
 * One order at a time: what goes wrong with one (the chain does not answer, the run does not start) is logged and the
 * order is left as it was, so the next pass tries it again and the rest of this one is not held up.
 */
async function attempt(orderId: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    console.error('[reconcile_error]', orderId, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Whether the refund of an order the flow gave up on landed after all, by its hash: then the order goes back through
 * `refunding` (the only way) to `refunded`. A refund proven dead is given up on here too, for a person to retry.
 */
async function landedLate(orderId: string, deps: Pick<ReconcileDeps, 'store' | 'refunds'>): Promise<boolean> {
  const { store } = deps;
  let landed = false;
  await attempt(orderId, async () => {
    const refund = await store.getRefund(orderId);
    if (refund === null || !MAY_HAVE_LANDED.includes(refund.status)) return;
    if ((await confirmRefund(orderId, deps)) !== 'confirmed-unapplied') return;
    landed = (await store.transition(orderId, 'refunding')) && (await store.transition(orderId, 'refunded'));
    if (landed) console.error('[refund_landed_late]', orderId, refund.txHash);
  });
  return landed;
}

/**
 * An order its run left `refunding`: its refund is looked up by its hash, and the order moved where that says. Mined, it
 * is `refunded` (confirmRefund moves it); reverted, `refund_failed` (confirmRefund too); not mined, or proven dead, it is
 * handed to a person as `refund_failed`, where the pass below keeps looking it up and logging it.
 */
async function settleStalled(orderId: string, deps: Pick<ReconcileDeps, 'store' | 'refunds'>): Promise<void> {
  const { store } = deps;
  await attempt(orderId, async () => {
    const answer = await confirmRefund(orderId, deps);
    if (answer === 'confirmed') {
      console.error('[refund_landed_late]', orderId, (await store.getRefund(orderId))?.txHash ?? null);
    } else if (answer === 'pending' || answer === 'dead') {
      await store.transition(orderId, 'refund_failed', { failureReason: answer === 'dead' ? 'refund-dead' : 'refund-unconfirmed' });
    }
  });
}

export async function reconcile(deps: ReconcileDeps, now: Date): Promise<ReconcileResult> {
  const { store, buy, refunds, payTo } = deps;
  const result: ReconcileResult = { started: [], unpaid: [], refundFailed: [] };
  const olderThan = new Date(now.getTime() - GRACE_MS);
  const nowSeconds = BigInt(Math.floor(now.getTime() / 1000));

  // The client was told its order id and status URL even when the settlement failed or timed out, so an order that
  // settled late is one to run.
  for (const order of await store.ordersAwaitingSettlement(olderThan)) {
    await attempt(order.id, async () => {
      const settlement = await buy.authorizationSettled({
        asset: order.asset,
        authorization: { from: order.payer, nonce: order.nonce, validAfter: order.validAfter.toString(), validBefore: order.validBefore.toString() },
        // Not only that the nonce was spent: that the service got the price. The payer can spend the nonce on a transfer to
        // themselves, which makes the settlement fail while the nonce looks used.
        to: payTo,
        value: order.amount,
      });
      if (settlement === 'settled') {
        // Found on the chain, which does not say which transaction settled it.
        const payment = { asset: order.asset, payer: order.payer, nonce: order.nonce, txHash: null };
        if ((await markPaidAndStart(payment, { store })) === 'started') result.started.push(order.id);
      } else if (settlement === 'unsettled' && nowSeconds >= order.validBefore + SETTLEMENT_GRACE_SECONDS) {
        // The token takes an authorization only before `validBefore`, by the chain's clock (this one may run ahead of it):
        // this one can never settle (nor could one whose nonce went to another transfer). If the order was paid while the
        // chain was being asked, the move is refused and the order stays as it is.
        if (await store.transition(order.id, 'unpaid')) result.unpaid.push(order.id);
      }
      // `unknown`, or `unsettled` while it still can: nothing to do yet.
    });
  }

  // Measured from the payment, so a run that the paying request is still starting is not started twice.
  for (const order of await store.paidWithoutRun(olderThan)) {
    await attempt(order.id, async () => {
      await startRun(order.id, store);
      result.started.push(order.id);
    });
  }

  // Before the refund failures, so an order handed to a person here is in this pass's log.
  for (const order of await store.stalledRefunds(new Date(now.getTime() - REFUND_WINDOW_MS))) {
    await settleStalled(order.id, { store, refunds });
  }

  for (const order of await store.refundFailures()) {
    if (await landedLate(order.id, { store, refunds })) continue;
    // What became of its refund, if it has one: its status and its hash say where to look.
    const refund = await store.getRefund(order.id).catch(() => null);
    console.error('[refund_failed]', order.id, refund?.status ?? null, refund?.txHash ?? null);
    result.refundFailed.push(order.id);
  }
  return result;
}
