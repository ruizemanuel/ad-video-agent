// Refunding an order that was not delivered. A refund on Celo cannot be taken back, so it is the amount the order paid,
// in the token it paid, to the address that paid it, and an order gets one at most: the transaction is signed and kept
// before it goes out (prepareRefund), handed to the node once (broadcastRefund, run with maxRetries = 0), and looked up
// by its hash afterwards (confirmRefund), never sent again. A refund past the daily cap, or that the wallet cannot pay,
// leaves the order `refund_failed`, where its status and the cron's log show it.
import type { Hex } from 'viem';
import { InsufficientBalance, type OrderStore, type PreparedRefund, type RefundPort, type RefundReceipt, type RefundRecord } from '../ports';

/**
 * Why no refund was prepared. `refund-daily-cap` and `insufficient_balance` leave the order `refund_failed`; a refund
 * that failed is not tried again on its own, and says why again. `not-refundable`: the order is not one to refund (it was
 * never paid, or was delivered, or does not exist), and it is left as it was.
 */
export type RefundFailure = { failed: string };

export type RefundDeps = {
  store: Pick<OrderStore, 'getOrder' | 'transition' | 'getRefund' | 'insertRefund' | 'updateRefund' | 'refundsSince'>;
  refunds: RefundPort;
  /** REFUND_DAILY_CAP_USD: what may be refunded in a UTC day, every order together. */
  dailyCapUsd: number;
};

/** Dollars in millionths. A 6-decimal stablecoin's atomic unit is one of them, and whole numbers compare exactly. */
const micros = (usd: number): number => Math.round(usd * 1e6);

const startOfUtcDay = (at: Date): Date => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

/**
 * Signs the order's refund and keeps it, without sending it. The order moves to `refunding` first (from `paid` or
 * `running`, with `reason` as why it failed), and only then are the cap and the balance checked. An order that already
 * has a refund gets that one back, whatever became of it: nothing is signed twice.
 *
 * It throws only when something failed before anything was signed (the chain could not be read, the store did not
 * answer): the order is then left `refunding`, and running it again goes on from there.
 */
export async function prepareRefund(orderId: string, reason: string, deps: RefundDeps): Promise<RefundRecord | RefundFailure> {
  const { store, refunds, dailyCapUsd } = deps;
  const existing = await store.getRefund(orderId);
  if (existing !== null) return existing;

  const order = await store.getOrder(orderId);
  if (order === null) return { failed: 'not-refundable' };
  // A failed refund is tried again by a person, who moves the order back to `refunding` first.
  if (order.status === 'refund_failed') return { failed: order.failureReason ?? 'refund_failed' };
  if (order.status === 'paid' || order.status === 'running') {
    const moved = await store.transition(orderId, 'refunding', { failureReason: reason });
    // Another call moved it first: only `refunding` lets this one go on. Of two calls at once, both may then sign, and
    // only the refund the first one keeps is ever sent (insertRefund, below).
    if (!moved && (await store.getOrder(orderId))?.status !== 'refunding') return { failed: 'not-refundable' };
  } else if (order.status !== 'refunding') {
    return { failed: 'not-refundable' };
  }

  const fail = async (failure: string): Promise<RefundRecord | RefundFailure> => {
    // A call at once for the same order may have kept its refund meanwhile (and counted it in the cap): that one stands.
    const kept = await store.getRefund(orderId);
    if (kept !== null) return kept;
    await store.transition(orderId, 'refund_failed', { failureReason: failure });
    return { failed: failure };
  };

  // Checked at the last moment, with this refund in it. Two refunds of different orders checked at once may both pass:
  // the cap can then be passed by one refund at most.
  const refunded = await store.refundsSince(startOfUtcDay(new Date()));
  if (micros(refunded) + Number(order.amount) > micros(dailyCapUsd)) return fail('refund-daily-cap');

  // Exactly what the order paid, in what it paid, to who paid it: nothing here comes from anywhere else.
  const request = { to: order.payer, asset: order.asset, amount: order.amount };
  let signed: PreparedRefund;
  try {
    signed = await refunds.prepare(request);
  } catch (error) {
    if (error instanceof InsufficientBalance) return fail('insufficient_balance');
    throw error;
  }

  const refund: RefundRecord = { orderId, ...request, status: 'prepared', reason, rawTx: signed.rawTx, txHash: signed.hash };
  if (await store.insertRefund(refund)) return refund;
  // Another call kept its refund first: that one is the order's, and this one is never sent.
  const kept = await store.getRefund(orderId);
  if (kept === null) throw new Error('The order has a refund that cannot be read.');
  return kept;
}

/**
 * Hands the order's signed refund to the node, once. The refund is marked `broadcast` before the bytes leave, so a call
 * after this one (or after it died halfway) never sends them again: it answers `uncertain`, and the hash says the rest.
 * `broadcast`: the node took it (or it is already mined). `uncertain`: it may or may not be on its way.
 */
export async function broadcastRefund(orderId: string, deps: Pick<RefundDeps, 'store' | 'refunds'>): Promise<'broadcast' | 'uncertain'> {
  const { store, refunds } = deps;
  const refund = await store.getRefund(orderId);
  if (refund === null || refund.rawTx === null) throw new Error('The order has no signed refund to broadcast.');
  if (refund.status !== 'prepared') return refund.status === 'confirmed' || refund.status === 'reverted' ? 'broadcast' : 'uncertain';

  await store.updateRefund(orderId, { status: 'broadcast' });
  try {
    // The store keeps what prepare gave: hex.
    await refunds.broadcast(refund.rawTx as Hex);
    return 'broadcast';
  } catch (error) {
    // The bytes were handed over and no answer says what the node did with them. They are fixed (one nonce, one hash),
    // so they could never pay twice; still, they are not sent again: the hash is looked up instead.
    console.error('[refund_broadcast_uncertain]', orderId, messageOf(error));
    return 'uncertain';
  }
}

/**
 * Looks the order's refund up on the chain by its hash, and sends nothing. Mined, it moves the order from `refunding` to
 * `refunded`; mined and reverted (no money moved, the fee was paid), to `refund_failed`. `pending`: not mined, not yet
 * signed, or the chain could not be read.
 */
export async function confirmRefund(orderId: string, deps: Pick<RefundDeps, 'store' | 'refunds'>): Promise<'confirmed' | 'reverted' | 'pending'> {
  const { store, refunds } = deps;
  const refund = await store.getRefund(orderId);
  if (refund === null || refund.txHash === null) return 'pending';

  let answer: RefundReceipt;
  try {
    answer = await refunds.receipt(refund.txHash as Hex);
  } catch (error) {
    console.error('[refund_receipt_unread]', orderId, messageOf(error));
    return 'pending';
  }
  if (answer === 'pending') return 'pending';
  if (answer === 'success') {
    await store.updateRefund(orderId, { status: 'confirmed' });
    await store.transition(orderId, 'refunded');
    return 'confirmed';
  }
  await store.updateRefund(orderId, { status: 'reverted' });
  await store.transition(orderId, 'refund_failed', { failureReason: 'refund-reverted' });
  return 'reverted';
}
