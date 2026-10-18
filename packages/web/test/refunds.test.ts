// Refunding an order that was not delivered: the amount it paid, in the token it paid, back to the address that paid it,
// once. The refund is signed and kept before it is broadcast, it is broadcast once, and its hash says whether it landed.
// The daily cap and a wallet without the token fail it where the status shows it. The refunds here are the double's;
// refund-adapter.test.ts signs real ones.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRefunds } from '../src/adapters/fake/refunds';
import { FileStore } from '../src/adapters/fake/store';
import { broadcastRefund, confirmRefund, prepareRefund, type RefundDeps } from '../src/payments/refunds';
import { TOKENS } from '../src/payments/tokens';
import type { Order, OrderStatus, RefundRecord } from '../src/ports';

const PAYER = '0x1234567890AbcdEF1234567890aBcdef12345678';

// How an order gets to each status from `awaiting_settlement`, where it is made.
const PATHS: Partial<Record<OrderStatus, OrderStatus[]>> = {
  awaiting_settlement: [],
  unpaid: ['unpaid'],
  paid: ['paid'],
  running: ['paid', 'running'],
  delivered: ['paid', 'running', 'delivered'],
  refunding: ['paid', 'refunding'],
};

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

let store: FileStore;
let refunds: FakeRefunds;
let deps: RefundDeps;

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'refunds-'));
  dirs.push(dir);
  store = new FileStore(dir);
  refunds = new FakeRefunds();
  deps = { store, refunds, dailyCapUsd: 10 };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** An order of 0.05 (development price) that has got to `status`. */
async function orderIn(status: OrderStatus, p: { amount?: bigint; asset?: string } = {}): Promise<Order> {
  const { order } = await store.createOrder({
    request: { url: 'https://example.com', audio: 'music' },
    network: 'eip155:42220',
    asset: p.asset ?? TOKENS.USDT.address,
    payer: PAYER,
    amount: p.amount ?? 50_000n,
    nonce: `0x${Math.random().toString(16).slice(2).padStart(64, '0')}`,
    validAfter: 0n,
    validBefore: 1_790_000_000n,
  });
  for (const next of PATHS[status] ?? []) expect(await store.transition(order.id, next)).toBe(true);
  return (await store.getOrder(order.id))!;
}

/** Another order's refund, made now, of `amount` atomic units. */
async function refundedElsewhere(amount: bigint): Promise<void> {
  const other = await orderIn('refunding', { amount });
  await store.insertRefund({ orderId: other.id, to: PAYER, asset: TOKENS.USDT.address, amount, status: 'confirmed', reason: 'render', rawTx: '0x01', txHash: `0x${'ab'.repeat(32)}` });
}

/** prepareRefund, which has to give back a refund. */
async function prepared(orderId: string): Promise<RefundRecord> {
  const refund = await prepareRefund(orderId, 'render', deps);
  if ('failed' in refund) throw new Error(`the refund failed: ${refund.failed}`);
  return refund;
}

describe('prepareRefund', () => {
  it.each([TOKENS.USDT.address, TOKENS.USDC.address])('refunds the paid amount, in the paid token (%s), to the payer', async (asset) => {
    const order = await orderIn('running', { asset, amount: 5_000_000n });
    const refund = await prepareRefund(order.id, 'render', deps);
    expect(refunds.lastPrepare).toEqual({ to: order.payer, asset: order.asset, amount: order.amount });
    expect(refund).toEqual({
      orderId: order.id,
      to: order.payer,
      asset: order.asset,
      amount: order.amount,
      status: 'prepared',
      reason: 'render',
      rawTx: refunds.lastPrepared?.rawTx,
      txHash: refunds.lastPrepared?.hash,
    });
  });

  it.each(['paid', 'running'] as const)('moves a %s order to refunding first, with why it failed', async (status) => {
    const order = await orderIn(status);
    await prepareRefund(order.id, 'vm-timeout', deps);
    expect(await store.getOrder(order.id)).toMatchObject({ status: 'refunding', failureReason: 'vm-timeout' });
  });

  it('keeps the signed transaction and its hash before anything is broadcast', async () => {
    const order = await orderIn('running');
    const refund = await prepared(order.id);
    expect(await store.getRefund(order.id)).toEqual(refund);
    expect(refund.rawTx).toMatch(/^0x[0-9a-f]+$/);
    expect(refund.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(refunds.broadcasts).toEqual([]);
  });

  it('never prepares a second refund for the same order', async () => {
    const order = await orderIn('running');
    const first = await prepareRefund(order.id, 'x', deps);
    const second = await prepareRefund(order.id, 'x', deps);
    expect(refunds.prepareCalls).toBe(1);
    expect(second).toEqual(first);
  });

  it('keeps one refund of the two that two calls at once may sign, and gives both the same one', async () => {
    const order = await orderIn('running');
    const [a, b] = await Promise.all([prepareRefund(order.id, 'render', deps), prepareRefund(order.id, 'render', deps)]);
    const kept = await store.getRefund(order.id);
    expect(kept).not.toBeNull();
    expect(a).toEqual(kept);
    expect(b).toEqual(kept);
  });

  it.each(['awaiting_settlement', 'unpaid', 'delivered'] as const)('leaves a %s order alone', async (status) => {
    const order = await orderIn(status);
    expect(await prepareRefund(order.id, 'render', deps)).toEqual({ failed: 'not-refundable' });
    expect(refunds.prepareCalls).toBe(0);
    expect((await store.getOrder(order.id))?.status).toBe(status);
    expect(await store.getRefund(order.id)).toBeNull();
  });

  it('has nothing to refund for an order that does not exist', async () => {
    expect(await prepareRefund('ord_doesnotexist', 'render', deps)).toEqual({ failed: 'not-refundable' });
    expect(refunds.prepareCalls).toBe(0);
  });

  it('fails visibly past the daily refund cap', async () => {
    await refundedElsewhere(9_990_000n);
    const order = await orderIn('running');
    expect(await prepareRefund(order.id, 'render', deps)).toEqual({ failed: 'refund-daily-cap' });
    expect(await store.getOrder(order.id)).toMatchObject({ status: 'refund_failed', failureReason: 'refund-daily-cap' });
    expect(refunds.prepareCalls).toBe(0);
    expect(await store.getRefund(order.id)).toBeNull();
  });

  it('refunds up to the cap itself', async () => {
    await refundedElsewhere(9_950_000n);
    const order = await orderIn('running');
    expect(await prepareRefund(order.id, 'render', deps)).toMatchObject({ status: 'prepared' });
  });

  it('counts what was refunded since the start of the day, UTC', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-17T23:30:00.000Z'));
    await refundedElsewhere(9_990_000n);
    vi.setSystemTime(new Date('2026-10-18T00:30:00.000Z'));
    const order = await orderIn('running');
    expect(await prepareRefund(order.id, 'render', deps)).toMatchObject({ status: 'prepared' });
  });

  it('fails visibly without balance of the paid token', async () => {
    refunds.balance = 49_999n;
    const order = await orderIn('running');
    expect(await prepareRefund(order.id, 'render', deps)).toEqual({ failed: 'insufficient_balance' });
    expect(await store.getOrder(order.id)).toMatchObject({ status: 'refund_failed', failureReason: 'insufficient_balance' });
    expect(await store.getRefund(order.id)).toBeNull();
  });

  it('does not try a failed refund again on its own', async () => {
    refunds.balance = 0n;
    const order = await orderIn('running');
    await prepareRefund(order.id, 'render', deps);
    refunds.balance = 1_000_000_000n;
    expect(await prepareRefund(order.id, 'render', deps)).toEqual({ failed: 'insufficient_balance' });
    expect(refunds.prepareCalls).toBe(1);
    expect((await store.getOrder(order.id))?.status).toBe('refund_failed');
  });

  it('can run again after an error that signed nothing, and goes on from refunding', async () => {
    refunds.prepareError = new Error('the node did not answer');
    const order = await orderIn('running');
    await expect(prepareRefund(order.id, 'render', deps)).rejects.toThrow('the node did not answer');
    expect(await store.getOrder(order.id)).toMatchObject({ status: 'refunding', failureReason: 'render' });
    expect(await store.getRefund(order.id)).toBeNull();

    refunds.prepareError = undefined;
    expect(await prepareRefund(order.id, 'render', deps)).toMatchObject({ status: 'prepared', reason: 'render' });
  });
});

describe('broadcastRefund', () => {
  it('hands the signed bytes to the node once', async () => {
    const order = await orderIn('running');
    const refund = await prepared(order.id);
    expect(await broadcastRefund(order.id, deps)).toBe('broadcast');
    // An earlier call already handed them over: this one does not, and cannot say what came of it.
    expect(await broadcastRefund(order.id, deps)).toBe('uncertain');
    expect(refunds.broadcasts).toEqual([refund.rawTx]);
    expect(await store.getRefund(order.id)).toMatchObject({ status: 'broadcast' });
  });

  it('marks the refund broadcast before the bytes leave, so a send that dies is not sent again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const order = await orderIn('running');
    const refund = await prepared(order.id);
    refunds.broadcastError = new Error('the node did not answer');
    expect(await broadcastRefund(order.id, deps)).toBe('uncertain');
    expect(await store.getRefund(order.id)).toMatchObject({ status: 'broadcast' });
    refunds.broadcastError = undefined;
    expect(await broadcastRefund(order.id, deps)).toBe('uncertain');
    expect(refunds.broadcasts).toEqual([refund.rawTx]);
    expect(console.error).toHaveBeenCalledWith('[refund_broadcast_uncertain]', order.id, 'the node did not answer');
  });

  it('has nothing to broadcast before a refund is signed', async () => {
    const order = await orderIn('running');
    await expect(broadcastRefund(order.id, deps)).rejects.toThrow('no signed refund');
    expect(refunds.broadcasts).toEqual([]);
  });
});

describe('confirmRefund', () => {
  it('confirms by hash after an ambiguous broadcast', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const order = await orderIn('running');
    const refund = await prepared(order.id);
    refunds.broadcastError = new Error('the node did not answer');
    await broadcastRefund(order.id, deps);
    // The node had kept it after all.
    refunds.receiptAnswer = 'success';
    expect(await confirmRefund(order.id, deps)).toBe('confirmed');
    expect((await store.getOrder(order.id))!.status).toBe('refunded');
    expect(await store.getRefund(order.id)).toMatchObject({ status: 'confirmed', txHash: refund.txHash });
    expect(refunds.receiptQueries).toEqual([refund.txHash]);
    // It only reads.
    expect(refunds.broadcasts).toEqual([refund.rawTx]);
  });

  it('marks the order refunded once the transfer is mined', async () => {
    const order = await orderIn('running');
    await prepared(order.id);
    await broadcastRefund(order.id, deps);
    expect(await confirmRefund(order.id, deps)).toBe('confirmed');
    expect((await store.getOrder(order.id))?.status).toBe('refunded');
  });

  it('waits while the chain has no receipt', async () => {
    const order = await orderIn('running');
    await prepared(order.id);
    await broadcastRefund(order.id, deps);
    refunds.receiptAnswer = 'pending';
    expect(await confirmRefund(order.id, deps)).toBe('pending');
    expect((await store.getOrder(order.id))?.status).toBe('refunding');
    expect(await store.getRefund(order.id)).toMatchObject({ status: 'broadcast' });
  });

  it('waits when the chain cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const order = await orderIn('running');
    await prepared(order.id);
    await broadcastRefund(order.id, deps);
    refunds.receiptAnswer = new Error('the node did not answer');
    expect(await confirmRefund(order.id, deps)).toBe('pending');
    expect((await store.getOrder(order.id))?.status).toBe('refunding');
    expect(console.error).toHaveBeenCalledWith('[refund_receipt_unread]', order.id, 'the node did not answer');
  });

  it('fails the order visibly when the transfer reverted', async () => {
    const order = await orderIn('running');
    await prepared(order.id);
    await broadcastRefund(order.id, deps);
    refunds.receiptAnswer = 'reverted';
    expect(await confirmRefund(order.id, deps)).toBe('reverted');
    expect(await store.getOrder(order.id)).toMatchObject({ status: 'refund_failed', failureReason: 'refund-reverted' });
    expect(await store.getRefund(order.id)).toMatchObject({ status: 'reverted' });
  });

  it('is pending while there is no signed refund to look for', async () => {
    const order = await orderIn('running');
    expect(await confirmRefund(order.id, deps)).toBe('pending');
    expect(refunds.receiptQueries).toEqual([]);
  });
});
