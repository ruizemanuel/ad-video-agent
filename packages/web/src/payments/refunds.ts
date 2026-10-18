// Refunding an order that was not delivered. A refund on Celo cannot be taken back, so it is the amount the order paid,
// in the token it paid, to the address that paid it, and an order has one at most that has not failed: the transaction is
// signed and kept before it goes out (prepareRefund); those bytes, never signed anew, are what goes to the node
// (broadcastRefund, run with maxRetries = 0; sent again by a later call, they still pay once: one nonce, one hash); and
// its hash says what became of it (confirmRefund). A refund is given up on only on positive evidence that it can never
// be mined (another of our refunds with its nonce is mined in a block that will not be undone), and only then is another
// signed. Every write to a refund is keyed by the hash that was read, so a refund replaced meanwhile is never written
// over. A refund past the daily cap, that the wallet cannot pay, or whose gas would cost too much leaves the order
// `refund_failed`, where its status and the cron's log show it.
import { keccak256, type Hex } from 'viem';
import { FeeTooHigh, InsufficientBalance, type OrderStore, type PreparedRefund, type RefundPort, type RefundReceipt, type RefundRecord } from '../ports';

/**
 * Why no refund was prepared. `refund-daily-cap`, `insufficient_balance` and `fee_too_high` leave the order
 * `refund_failed`; a refund that failed is not tried again on its own, and says why again. `not-refundable`: the order is
 * not one to refund (it was never paid, or was delivered, or does not exist), and it is left as it was.
 */
export type RefundFailure = { failed: string };

export type RefundDeps = {
  store: Pick<OrderStore, 'getOrder' | 'transition' | 'getRefund' | 'insertRefund' | 'updateRefund' | 'refundsSince' | 'refundsByNonce'>;
  refunds: RefundPort;
  /** REFUND_DAILY_CAP_USD: what may be refunded in a UTC day, every order together. */
  dailyCapUsd: number;
};

export type BroadcastRefundDeps = { store: Pick<OrderStore, 'getRefund' | 'updateRefund'>; refunds: Pick<RefundPort, 'broadcast'> };

export type ConfirmRefundDeps = {
  store: Pick<OrderStore, 'getRefund' | 'updateRefund' | 'transition' | 'getOrder' | 'refundsByNonce'>;
  refunds: Pick<RefundPort, 'receipt' | 'nonceUsed' | 'minedSafely'>;
};

/**
 * - `confirmed`: mined, and the order is `refunded`.
 * - `confirmed-unapplied`: mined, but the order was not `refunding` (the flow gave up on it before it landed), so it was
 *   left as it was: its caller decides.
 * - `reverted`: mined without moving money; the order is `refund_failed`.
 * - `pending`: not mined yet (it may still be, or nothing proves it never will), not signed yet, the chain could not be
 *   read, or the refund changed while it was being looked at.
 * - `dead`: it can never be mined: given up on, and `prepareRefund` signs a fresh one.
 */
export type ConfirmResult = 'confirmed' | 'confirmed-unapplied' | 'reverted' | 'pending' | 'dead';

/** Not mined (yet): the only statuses a refund may be marked mined, or given up on, from. */
const UNMINED = ['prepared', 'broadcast'] as const;

/** Dollars in millionths. A 6-decimal stablecoin's atomic unit is one of them, and whole numbers compare exactly. */
const micros = (usd: number): number => Math.round(usd * 1e6);

const startOfUtcDay = (at: Date): Date => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

const same = (a: string | null, b: string): boolean => a?.toLowerCase() === b.toLowerCase();

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

  // In place of a refund given up on, if there is one; never next to one that can still be mined. When another call kept
  // its refund first, that one is the order's, and this one is never sent. Either way the store says which refund is the
  // order's now, and what it replaced.
  await store.insertRefund({ orderId, ...request, status: 'prepared', reason, rawTx: signed.rawTx, txHash: signed.hash, nonce: signed.nonce });
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
  // Its nonce went to another of our refunds: a fresh refund takes its place.
  if (refund.status === 'failed') return 'uncertain';

  // The store keeps what prepare gave: hex.
  const rawTx = refund.rawTx as Hex;
  if (keccak256(rawTx).toLowerCase() !== refund.txHash.toLowerCase()) throw new Error("The kept refund's bytes do not match its hash: they are not sent.");
  // Changed since it was read (replaced, given up on): nothing is sent, and the next call reads it again.
  if (refund.status === 'prepared' && !(await store.updateRefund(orderId, refund.txHash, { status: 'broadcast' }, ['prepared']))) return 'uncertain';
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
 * Positive evidence that the refund can never be mined: another of our kept refunds signed with its nonce is mined in a
 * block at or below the safe head. A nonce used by anything else proves nothing here (a node behind may simply not have
 * this refund's receipt yet), and is left to a person. The chain's nonce is only a filter, read before the store.
 */
async function provenDead(refund: RefundRecord, deps: ConfirmRefundDeps): Promise<boolean> {
  const { store, refunds } = deps;
  if (refund.nonce === null || refund.txHash === null) return false;
  if (!(await refunds.nonceUsed(refund.nonce))) return false;
  for (const other of await store.refundsByNonce(refund.nonce)) {
    if (other.txHash === null || same(other.txHash, refund.txHash)) continue;
    if (await refunds.minedSafely(other.txHash as Hex)) return true;
  }
  return false;
}

/** The order of a mined refund moved to `refunded`, from `refunding`; reported when it was somewhere else. */
async function refunded(orderId: string, store: ConfirmRefundDeps['store']): Promise<'confirmed' | 'confirmed-unapplied'> {
  if (await store.transition(orderId, 'refunded')) return 'confirmed';
  return (await store.getOrder(orderId))?.status === 'refunded' ? 'confirmed' : 'confirmed-unapplied';
}

/**
 * Looks the order's refund up on the chain, and sends nothing. Mined, it moves the order from `refunding` to `refunded`;
 * mined and reverted (no money moved, the fee was paid), to `refund_failed`. A refund already seen mined is not looked up
 * again: a node behind could say otherwise. Not mined, it is given up on (marked `failed`, the order left `refunding`)
 * only on positive evidence that it can never be (see provenDead).
 */
export async function confirmRefund(orderId: string, deps: ConfirmRefundDeps): Promise<ConfirmResult> {
  const { store, refunds } = deps;
  const refund = await store.getRefund(orderId);
  if (refund === null || refund.rawTx === null || refund.txHash === null) return 'pending';
  switch (refund.status) {
    case 'failed':
      return 'dead';
    case 'confirmed':
      return refunded(orderId, store);
    case 'reverted':
      await store.transition(orderId, 'refund_failed', { failureReason: 'refund-reverted' });
      return 'reverted';
  }

  const hash = refund.txHash;
  let answer: RefundReceipt;
  let dead = false;
  try {
    answer = await refunds.receipt(hash as Hex);
    if (answer === 'pending') dead = await provenDead(refund, deps);
  } catch (error) {
    console.error('[refund_receipt_unread]', orderId, messageOf(error));
    return 'pending';
  }

  // Each write holds only while the refund is the one that was read, and not yet mined: otherwise nothing is decided.
  if (answer === 'success') {
    if (!(await store.updateRefund(orderId, hash, { status: 'confirmed' }, UNMINED))) return 'pending';
    return refunded(orderId, store);
  }
  if (answer === 'reverted') {
    if (!(await store.updateRefund(orderId, hash, { status: 'reverted' }, UNMINED))) return 'pending';
    await store.transition(orderId, 'refund_failed', { failureReason: 'refund-reverted' });
    return 'reverted';
  }
  if (!dead || !(await store.updateRefund(orderId, hash, { status: 'failed' }, UNMINED))) return 'pending';
  // Its hash, kept in the log too: the refund that takes its place keeps it as the one it replaced.
  console.error('[refund_dead]', orderId, hash);
  return 'dead';
}
