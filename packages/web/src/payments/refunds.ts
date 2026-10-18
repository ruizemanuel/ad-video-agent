// Refunding an order that was not delivered. A refund on Celo cannot be taken back, so it is the amount the order paid,
// in the token it paid, to the address that paid it, and an order has one at most that has not failed: the transaction is
// signed and kept before it goes out (prepareRefund); those bytes, never signed anew, are what goes to the node
// (broadcastRefund, run with maxRetries = 0; sent again by a later call, they still pay once: one nonce, one hash); and
// its hash says what became of it (confirmRefund). Only a refund that can never be mined (its nonce went to another
// transaction) is given up on, and only then is another signed. A refund past the daily cap, that the wallet cannot pay,
// or whose gas would cost too much leaves the order `refund_failed`, where its status and the cron's log show it.
import { keccak256, type Hex } from 'viem';
import { FeeTooHigh, InsufficientBalance, type OrderStore, type PreparedRefund, type RefundPort, type RefundReceipt, type RefundRecord } from '../ports';

/**
 * Why no refund was prepared. `refund-daily-cap`, `insufficient_balance` and `fee_too_high` leave the order
 * `refund_failed`; a refund that failed is not tried again on its own, and says why again. `not-refundable`: the order is
 * not one to refund (it was never paid, or was delivered, or does not exist), and it is left as it was.
 */
export type RefundFailure = { failed: string };

export type RefundDeps = {
  store: Pick<OrderStore, 'getOrder' | 'transition' | 'getRefund' | 'insertRefund' | 'updateRefund' | 'refundsSince'>;
  refunds: RefundPort;
  /** REFUND_DAILY_CAP_USD: what may be refunded in a UTC day, every order together. */
  dailyCapUsd: number;
};

export type BroadcastRefundDeps = { store: Pick<OrderStore, 'getRefund' | 'updateRefund'>; refunds: Pick<RefundPort, 'broadcast'> };

export type ConfirmRefundDeps = {
  store: Pick<OrderStore, 'getRefund' | 'updateRefund' | 'transition' | 'getOrder'>;
  refunds: Pick<RefundPort, 'receipt' | 'dead'>;
};

/**
 * - `confirmed`: mined, and the order is `refunded`.
 * - `confirmed-unapplied`: mined, but the order was not `refunding` (the flow gave up on it before it landed), so it was
 *   left as it was: its caller decides.
 * - `reverted`: mined without moving money; the order is `refund_failed`.
 * - `pending`: not mined yet (and it still can be), not signed yet, or the chain could not be read.
 * - `dead`: it can never be mined: given up on, and `prepareRefund` signs a fresh one.
 */
export type ConfirmResult = 'confirmed' | 'confirmed-unapplied' | 'reverted' | 'pending' | 'dead';

/** Dollars in millionths. A 6-decimal stablecoin's atomic unit is one of them, and whole numbers compare exactly. */
const micros = (usd: number): number => Math.round(usd * 1e6);

const startOfUtcDay = (at: Date): Date => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

/**
 * Signs the order's refund and keeps it, without sending it. The order moves to `refunding` first (from `paid` or
 * `running`, with `reason` as why it failed), and only then are the cap, the gas and the balance checked. An order that
 * already has a refund gets that one back, whatever became of it, unless it was given up on as dead: nothing is signed
 * while a refund of the order can still be mined.
 *
 * It throws only when something failed before anything was signed (the chain could not be read, the store did not
 * answer): the order is then left `refunding`, and running it again goes on from there.
 */
export async function prepareRefund(orderId: string, reason: string, deps: RefundDeps): Promise<RefundRecord | RefundFailure> {
  const { store, refunds, dailyCapUsd } = deps;
  const existing = await store.getRefund(orderId);
  if (existing !== null && existing.status !== 'failed') return existing;

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
    if (kept !== null && kept.status !== 'failed') return kept;
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
    if (error instanceof FeeTooHigh) return fail('fee_too_high');
    throw error;
  }

  // In place of a refund given up on, if there is one; never next to one that can still be mined.
  const refund: RefundRecord = { orderId, ...request, status: 'prepared', reason, rawTx: signed.rawTx, txHash: signed.hash };
  if (await store.insertRefund(refund)) return refund;
  // Another call kept its refund first: that one is the order's, and this one is never sent.
  const kept = await store.getRefund(orderId);
  if (kept === null) throw new Error('The order has a refund that cannot be read.');
  return kept;
}

/**
 * Hands the order's kept refund to the node: the bytes that were signed, checked against their hash, never signed anew.
 * A later call hands the same bytes again (a send that died before the node took them would otherwise never land), and
 * they still pay once. A refund that was mined, or given up on, is not sent. The refund is marked `broadcast` before the
 * bytes first leave. `broadcast`: the node took them (or they are mined). `uncertain`: they may or may not be on their way.
 * It never tries twice itself.
 */
export async function broadcastRefund(orderId: string, deps: BroadcastRefundDeps): Promise<'broadcast' | 'uncertain'> {
  const { store, refunds } = deps;
  const refund = await store.getRefund(orderId);
  if (refund === null || refund.rawTx === null || refund.txHash === null) throw new Error('The order has no signed refund to broadcast.');
  if (refund.status === 'confirmed' || refund.status === 'reverted') return 'broadcast';
  // Its nonce went to another transaction: a fresh refund takes its place.
  if (refund.status === 'failed') return 'uncertain';

  // The store keeps what prepare gave: hex.
  const rawTx = refund.rawTx as Hex;
  if (keccak256(rawTx).toLowerCase() !== refund.txHash.toLowerCase()) throw new Error("The kept refund's bytes do not match its hash: they are not sent.");
  if (refund.status === 'prepared') await store.updateRefund(orderId, { status: 'broadcast' });
  try {
    await refunds.broadcast(rawTx);
    return 'broadcast';
  } catch (error) {
    // No answer says what the node did with them: the hash will. The adapter's errors carry neither the URL nor the bytes.
    console.error('[refund_broadcast_uncertain]', orderId, messageOf(error));
    return 'uncertain';
  }
}

/**
 * Looks the order's refund up on the chain, and sends nothing. Mined, it moves the order from `refunding` to `refunded`;
 * mined and reverted (no money moved, the fee was paid), to `refund_failed`. Not mined, it is given up on (marked
 * `failed`, the order left `refunding`) only if it can never be: its nonce went to another transaction.
 */
export async function confirmRefund(orderId: string, deps: ConfirmRefundDeps): Promise<ConfirmResult> {
  const { store, refunds } = deps;
  const refund = await store.getRefund(orderId);
  if (refund === null || refund.rawTx === null || refund.txHash === null) return 'pending';
  if (refund.status === 'failed') return 'dead';

  let answer: RefundReceipt;
  let dead = false;
  try {
    answer = await refunds.receipt(refund.txHash as Hex);
    // `dead` reads the receipt again after the nonce, so one mined in between is not taken for dead.
    if (answer === 'pending') dead = await refunds.dead(refund.rawTx as Hex);
  } catch (error) {
    console.error('[refund_receipt_unread]', orderId, messageOf(error));
    return 'pending';
  }

  if (answer === 'success') {
    await store.updateRefund(orderId, { status: 'confirmed' });
    if (await store.transition(orderId, 'refunded')) return 'confirmed';
    return (await store.getOrder(orderId))?.status === 'refunded' ? 'confirmed' : 'confirmed-unapplied';
  }
  if (answer === 'reverted') {
    await store.updateRefund(orderId, { status: 'reverted' });
    await store.transition(orderId, 'refund_failed', { failureReason: 'refund-reverted' });
    return 'reverted';
  }
  if (!dead) return 'pending';
  await store.updateRefund(orderId, { status: 'failed' });
  // Its hash, kept in the log: the store keeps the refund that takes its place.
  console.error('[refund_dead]', orderId, refund.txHash);
  return 'dead';
}
