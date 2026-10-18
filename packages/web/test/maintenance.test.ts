import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { start } from 'workflow/api';
import { FakeBuy } from '../src/adapters/fake/buy';
import { FileBlob } from '../src/adapters/fake/blob';
import { FakeRefunds } from '../src/adapters/fake/refunds';
import { FileStore } from '../src/adapters/fake/store';
import { setCronDeps } from '../src/app/api/cron/deps';
import { GET as cleanupRoute } from '../src/app/api/cron/cleanup/route';
import { GET as reconcileRoute } from '../src/app/api/cron/reconcile/route';
import { cleanup } from '../src/maintenance/cleanup';
import { reconcile } from '../src/maintenance/reconcile';
import { broadcastRefund, prepareRefund } from '../src/payments/refunds';
import { TOKENS } from '../src/payments/x402';
import type { Order } from '../src/ports';
import { orderWorkflow } from '../src/workflows/order';
import { config } from '../vercel';

vi.mock('workflow/api', () => ({ start: vi.fn(async () => ({ runId: 'wrun_test' })) }));

const CRON_SECRET = 'c'.repeat(40);
const PAYTO = `0x${'1'.repeat(40)}`;
// The routes read their settings the way the service does: from the environment, once.
vi.stubEnv('AD_AGENT_ADAPTERS', 'fake');
vi.stubEnv('PAYTO_ADDRESS', PAYTO);
vi.stubEnv('LINK_SIGNING_SECRET', 's'.repeat(40));
vi.stubEnv('CRON_SECRET', CRON_SECRET);

const PAYER = '0x1234567890AbcdEF1234567890aBcdef12345678';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const dirs: string[] = [];
let store: FileStore;
let blob: FileBlob;
let buy: FakeBuy;
let refunds: FakeRefunds;

beforeEach(async () => {
  vi.clearAllMocks();
  const dir = await mkdtemp(join(tmpdir(), 'maintenance-'));
  dirs.push(dir);
  store = new FileStore(dir);
  blob = new FileBlob(dir);
  buy = new FakeBuy();
  refunds = new FakeRefunds();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setCronDeps(undefined);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A moment `ms` after the real one: the orders are made in real time, and the jobs are told what time it is. */
const after = (ms: number): Date => new Date(Date.now() + ms);
const unixSeconds = (at: Date): bigint => BigInt(Math.floor(at.getTime() / 1000));

let counter = 0;
/** An order waiting for its settlement. Its authorization is valid until `validBefore` (unix seconds). */
async function awaiting(validBefore: bigint): Promise<Order> {
  const { order } = await store.createOrder({
    request: { url: 'https://example.com', audio: 'music' },
    network: 'eip155:42220',
    asset: TOKENS.USDT.address,
    payer: PAYER,
    amount: 5_000_000n,
    nonce: `0x${(++counter).toString(16).padStart(64, '0')}`,
    validAfter: 0n,
    validBefore,
  });
  return order;
}

/** An order the facilitator settled, which waits for its run. */
async function paid(): Promise<Order> {
  const order = await awaiting(unixSeconds(after(5 * MINUTE)));
  await store.transition(order.id, 'paid', { settleTx: `0x${'ef'.repeat(32)}` });
  return (await store.getOrder(order.id)) as Order;
}

/** An order that has been delivered, with a file in the blob store. */
async function delivered(): Promise<Order> {
  const order = await paid();
  await store.transition(order.id, 'running');
  await blob.put(`orders/${order.id}/out/hook-a-9x16.mp4`, 'video', 'video/mp4');
  await blob.put(`orders/${order.id}/capture.json`, '{}', 'application/json');
  await store.transition(order.id, 'delivered');
  return (await store.getOrder(order.id)) as Order;
}

/** What reconcile runs on: the service's wallet is where the payments go. */
const deps = (chain: FakeBuy = buy) => ({ store, buy: chain, refunds, payTo: PAYTO });
const statusOf = async (order: Order) => (await store.getOrder(order.id))!.status;
/** Orders made in the same millisecond have no fixed order between them. */
const sorted = (ids: string[]): string[] => [...ids].sort();

describe('reconcile: orders waiting for their settlement', () => {
  it('starts an order the facilitator settled but never reported', async () => {
    const order = await awaiting(unixSeconds(after(10 * MINUTE)));
    buy.settlement(order.nonce, 'settled');

    const now = after(6 * MINUTE);
    expect(await reconcile(deps(), now)).toEqual({ started: [order.id], unpaid: [], refundFailed: [] });

    // It asked about this very authorization.
    expect(buy.settlementQueries).toEqual([
      {
        asset: order.asset,
        authorization: { from: PAYER, nonce: order.nonce, validAfter: '0', validBefore: order.validBefore.toString() },
        // It asks whether the service was paid, not only whether the nonce was spent.
        to: PAYTO,
        value: 5_000_000n,
      },
    ]);
    // The settlement was found on the chain, so the transaction is not known.
    expect(await store.getOrder(order.id)).toMatchObject({ status: 'paid', settleTx: null, runId: 'wrun_test', steps: { payment: 'done' } });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(orderWorkflow, [order.id]);
  });

  it('leaves an order alone while it is younger than 5 minutes, and does not ask the chain', async () => {
    const order = await awaiting(unixSeconds(after(10 * MINUTE)));
    buy.settlement(order.nonce, 'settled');

    expect(await reconcile(deps(), after(4 * MINUTE))).toEqual({ started: [], unpaid: [], refundFailed: [] });
    expect(buy.settlementQueries).toEqual([]);
    expect(await statusOf(order)).toBe('awaiting_settlement');
    expect(start).not.toHaveBeenCalled();
  });

  it('marks unpaid an unsettled authorization well past validBefore', async () => {
    const now = after(6 * MINUTE);
    const order = await awaiting(unixSeconds(now) - 3600n);
    buy.settlement(order.nonce, 'unsettled');

    expect(await reconcile(deps(), now)).toEqual({ started: [], unpaid: [order.id], refundFailed: [] });
    expect(await statusOf(order)).toBe('unpaid');
    expect(start).not.toHaveBeenCalled();
  });

  it('marks unpaid a full minute after validBefore, when even a server clock running ahead of the chain is past it', async () => {
    const now = after(6 * MINUTE);
    const order = await awaiting(unixSeconds(now) - 60n);
    buy.settlement(order.nonce, 'unsettled');

    expect((await reconcile(deps(), now)).unpaid).toEqual([order.id]);
  });

  it('leaves an unsettled authorization alone in the minute after validBefore: the chain may not be there yet', async () => {
    const now = after(6 * MINUTE);
    const order = await awaiting(unixSeconds(now) - 59n);
    buy.settlement(order.nonce, 'unsettled');

    expect(await reconcile(deps(), now)).toEqual({ started: [], unpaid: [], refundFailed: [] });
    expect(await statusOf(order)).toBe('awaiting_settlement');
  });

  it('leaves an unsettled authorization alone while it can still settle', async () => {
    const now = after(6 * MINUTE);
    const order = await awaiting(unixSeconds(now) + 1n);
    buy.settlement(order.nonce, 'unsettled');

    expect(await reconcile(deps(), now)).toEqual({ started: [], unpaid: [], refundFailed: [] });
    expect(await statusOf(order)).toBe('awaiting_settlement');
  });

  it('leaves unknown settlements alone, even past validBefore', async () => {
    const now = after(6 * MINUTE);
    const order = await awaiting(unixSeconds(now) - 3600n);
    buy.settlement(order.nonce, 'unknown');

    expect(await reconcile(deps(), now)).toEqual({ started: [], unpaid: [], refundFailed: [] });
    expect(await statusOf(order)).toBe('awaiting_settlement');
    expect(start).not.toHaveBeenCalled();
  });

  it('does not report as started an order another call has just paid', async () => {
    const order = await awaiting(unixSeconds(after(10 * MINUTE)));
    buy.settlement(order.nonce, 'settled');
    // The route's own settlement lands while the chain is being asked: it pays the order and starts its run.
    const slow = new FakeBuy();
    slow.authorizationSettled = async (input) => {
      await store.transition(order.id, 'paid');
      await store.setRunId(order.id, 'wrun_route');
      return buy.authorizationSettled(input);
    };

    expect(await reconcile(deps(slow), after(6 * MINUTE))).toEqual({ started: [], unpaid: [], refundFailed: [] });
    expect(start).not.toHaveBeenCalled();
  });

  it('does not mark unpaid an order that was paid while the chain was being asked', async () => {
    const now = after(6 * MINUTE);
    const order = await awaiting(unixSeconds(now) - 3600n);
    const slow = new FakeBuy();
    slow.authorizationSettled = async () => {
      await store.transition(order.id, 'paid');
      await store.setRunId(order.id, 'wrun_route');
      return 'unsettled';
    };

    expect((await reconcile(deps(slow), now)).unpaid).toEqual([]);
    expect(await statusOf(order)).toBe('paid');
  });

  it('goes on with the other orders when the chain cannot be asked about one', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = await awaiting(unixSeconds(after(10 * MINUTE)));
    const fine = await awaiting(unixSeconds(after(10 * MINUTE)));
    buy.settlement(broken.nonce, new Error('rpc down'));
    buy.settlement(fine.nonce, 'settled');

    expect(await reconcile(deps(), after(6 * MINUTE))).toEqual({ started: [fine.id], unpaid: [], refundFailed: [] });
    expect(logged).toHaveBeenCalledWith('[reconcile_error]', broken.id, 'rpc down');
    expect(await statusOf(broken)).toBe('awaiting_settlement');
  });
});

describe('reconcile: a nonce spent by another transfer', () => {
  // An EIP-3009 nonce belongs to the payer, whoever the payment is to: between the check and the settlement the payer
  // can spend the same nonce on a transfer of 1 unit to themselves. The settlement then fails and nothing was paid.
  const burn = { to: PAYER, value: 1n };

  it('never starts an order whose nonce was spent on a transfer that did not pay the service', async () => {
    const now = after(6 * MINUTE);
    const order = await awaiting(unixSeconds(now) + 600n);
    buy.consumed(order.nonce, burn);

    expect(await reconcile(deps(), now)).toEqual({ started: [], unpaid: [], refundFailed: [] });
    expect(buy.settlementQueries).toHaveLength(1);
    expect(await statusOf(order)).toBe('awaiting_settlement');
    expect(start).not.toHaveBeenCalled();
  });

  it('gives it up as unpaid once past validBefore, and still starts nothing', async () => {
    const now = after(6 * MINUTE);
    const order = await awaiting(unixSeconds(now) - 3600n);
    buy.consumed(order.nonce, burn);

    expect(await reconcile(deps(), now)).toEqual({ started: [], unpaid: [order.id], refundFailed: [] });
    expect(await statusOf(order)).toBe('unpaid');
    expect(start).not.toHaveBeenCalled();
  });

  it.each([
    ['to the service for less than the price', { to: PAYTO, value: 4_999_999n }],
    ['to another address for the full price', { to: `0x${'9'.repeat(40)}`, value: 5_000_000n }],
  ])('does not take a transfer %s for a payment', async (_label, transfer) => {
    const now = after(6 * MINUTE);
    const order = await awaiting(unixSeconds(now) + 600n);
    buy.consumed(order.nonce, transfer);

    expect((await reconcile(deps(), now)).started).toEqual([]);
    expect(await statusOf(order)).toBe('awaiting_settlement');
  });

  it.each([
    ['the full price', 5_000_000n],
    ['more than the price', 6_000_000n],
  ])('starts the order when the transfer that spent the nonce paid the service %s', async (_label, value) => {
    const now = after(6 * MINUTE);
    const order = await awaiting(unixSeconds(now) + 600n);
    buy.consumed(order.nonce, { to: PAYTO, value });

    expect(await reconcile(deps(), now)).toEqual({ started: [order.id], unpaid: [], refundFailed: [] });
    expect(await statusOf(order)).toBe('paid');
  });
});

describe('reconcile: paid orders without a run', () => {
  it('starts a paid order that has no run after 5 min, once', async () => {
    const order = await paid();

    expect(await reconcile(deps(), after(6 * MINUTE))).toEqual({ started: [order.id], unpaid: [], refundFailed: [] });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(orderWorkflow, [order.id]);
    expect(await store.getOrder(order.id)).toMatchObject({ status: 'paid', runId: 'wrun_test' });

    // It has its run now: the next pass leaves it alone.
    expect((await reconcile(deps(), after(16 * MINUTE))).started).toEqual([]);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('waits 5 minutes from the payment, so it never races a run that is still being started', async () => {
    await paid();

    expect((await reconcile(deps(), after(4 * MINUTE))).started).toEqual([]);
    expect(start).not.toHaveBeenCalled();
  });

  it('leaves alone a paid order that has a run', async () => {
    const order = await paid();
    await store.setRunId(order.id, 'wrun_first');

    expect((await reconcile(deps(), after(6 * MINUTE))).started).toEqual([]);
    expect(start).not.toHaveBeenCalled();
  });

  it('goes on with the other orders when a run cannot be started for one', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const first = await paid();
    const second = await paid();
    vi.mocked(start).mockRejectedValueOnce(new Error('workflow unavailable'));

    expect(await reconcile(deps(), after(6 * MINUTE))).toEqual({ started: [second.id], unpaid: [], refundFailed: [] });
    expect(logged).toHaveBeenCalledWith('[reconcile_error]', first.id, 'workflow unavailable');
    // The failed one has no run, so the next pass tries it again.
    expect((await store.getOrder(first.id))!.runId).toBeNull();
  });
});

describe('reconcile: refund failures', () => {
  async function refundFailed(): Promise<Order> {
    const order = await paid();
    await store.transition(order.id, 'running');
    await store.transition(order.id, 'refunding');
    await store.transition(order.id, 'refund_failed');
    return order;
  }

  it('logs refund failures every run', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const order = await refundFailed();
    const other = await refundFailed();

    const result = await reconcile(deps(), after(MINUTE));
    expect(result).toMatchObject({ started: [], unpaid: [] });
    expect(sorted(result.refundFailed)).toEqual(sorted([order.id, other.id]));
    expect(spy).toHaveBeenCalledWith('[refund_failed]', order.id, null, null);
    expect(spy).toHaveBeenCalledWith('[refund_failed]', other.id, null, null);

    spy.mockClear();
    await reconcile(deps(), after(11 * MINUTE));
    expect(spy).toHaveBeenCalledWith('[refund_failed]', order.id, null, null);
  });

  /** An order whose refund was signed and sent, and that the flow then gave up on before the chain said anything. */
  async function givenUpOn(): Promise<Order> {
    const order = await paid();
    await store.transition(order.id, 'running');
    const refundDeps = { store, refunds, dailyCapUsd: 10 };
    await prepareRefund(order.id, 'render', refundDeps);
    await broadcastRefund(order.id, refundDeps);
    await store.transition(order.id, 'refund_failed', { failureReason: 'refund-unconfirmed' });
    return order;
  }

  it('moves to refunded an order whose refund landed after it was given up on', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const order = await givenUpOn();
    const { txHash } = (await store.getRefund(order.id))!;

    const result = await reconcile(deps(), after(MINUTE));
    expect(result.refundFailed).toEqual([]);
    expect(await statusOf(order)).toBe('refunded');
    expect(await store.getRefund(order.id)).toMatchObject({ status: 'confirmed', txHash });
    expect(spy).toHaveBeenCalledWith('[refund_landed_late]', order.id, txHash);
    expect(spy).not.toHaveBeenCalledWith('[refund_failed]', order.id, expect.anything(), expect.anything());
    // It only looked: the refund was sent once, by the flow.
    expect(refunds.broadcasts).toHaveLength(1);
  });

  it('keeps logging a refund that has not landed, with its status and hash', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const order = await givenUpOn();
    const { txHash } = (await store.getRefund(order.id))!;
    refunds.receiptAnswer = 'pending';

    expect((await reconcile(deps(), after(MINUTE))).refundFailed).toEqual([order.id]);
    expect(await statusOf(order)).toBe('refund_failed');
    expect(spy).toHaveBeenCalledWith('[refund_failed]', order.id, 'broadcast', txHash);
  });

  it('does not look up a refund that already reverted', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const order = await givenUpOn();
    await store.updateRefund(order.id, { status: 'reverted' });
    const { txHash } = (await store.getRefund(order.id))!;

    expect((await reconcile(deps(), after(MINUTE))).refundFailed).toEqual([order.id]);
    expect(refunds.receiptQueries).toEqual([]);
    expect(spy).toHaveBeenCalledWith('[refund_failed]', order.id, 'reverted', txHash);
  });

  it('stays quiet when no refund has failed', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await paid();

    expect((await reconcile(deps(), after(MINUTE))).refundFailed).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('cleanup', () => {
  it('expires orders older than 30 days and deletes their blobs', async () => {
    const old = await delivered();
    const deleteSpy = vi.spyOn(blob, 'deletePrefix');

    expect(await cleanup({ store, blob }, after(31 * DAY))).toEqual({ expired: [old.id] });
    expect(deleteSpy).toHaveBeenCalledWith(`orders/${old.id}/`);
    expect(await statusOf(old)).toBe('expired');
    await expect(blob.get(`orders/${old.id}/out/hook-a-9x16.mp4`)).rejects.toThrow('does not exist');
    await expect(blob.get(`orders/${old.id}/capture.json`)).rejects.toThrow('does not exist');
  });

  it('keeps an order younger than 30 days with its files', async () => {
    const recent = await delivered();

    expect(await cleanup({ store, blob }, after(29 * DAY))).toEqual({ expired: [] });
    expect(await statusOf(recent)).toBe('delivered');
    expect(await blob.get(`orders/${recent.id}/out/hook-a-9x16.mp4`)).toBeInstanceOf(Uint8Array);
  });

  it('expires an unpaid order too', async () => {
    const unpaid = await awaiting(1n);
    await store.transition(unpaid.id, 'unpaid');

    expect(await cleanup({ store, blob }, after(31 * DAY))).toEqual({ expired: [unpaid.id] });
    expect(await statusOf(unpaid)).toBe('expired');
  });

  it('leaves alone an order still being worked on, with its files, and deletes only the files of the one it expires', async () => {
    const old = await delivered();
    const busy = await paid();
    await store.transition(busy.id, 'running');
    await blob.put(`orders/${busy.id}/capture.json`, '{}', 'application/json');

    expect(await cleanup({ store, blob }, after(90 * DAY))).toEqual({ expired: [old.id] });
    expect(await statusOf(busy)).toBe('running');
    expect(await blob.get(`orders/${busy.id}/capture.json`)).toBeInstanceOf(Uint8Array);
  });

  it('keeps the order for the next run when its blobs could not be deleted, and goes on with the others', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stuck = await delivered();
    const fine = await delivered();
    const real = blob.deletePrefix.bind(blob);
    vi.spyOn(blob, 'deletePrefix').mockImplementation(async (prefix) => {
      if (prefix === `orders/${stuck.id}/`) throw new Error('blob store unavailable');
      return real(prefix);
    });

    expect(await cleanup({ store, blob }, after(31 * DAY))).toEqual({ expired: [fine.id] });
    expect(logged).toHaveBeenCalledWith('[cleanup_error]', stuck.id, 'blob store unavailable');
    // Still delivered, so the next run deletes its files again and then expires it.
    expect(await statusOf(stuck)).toBe('delivered');
  });
});

describe('the cron routes', () => {
  const call = (route: typeof reconcileRoute, authorization?: string) =>
    route(new Request('https://ad-video-agent.example.com/api/cron/job', { headers: authorization === undefined ? {} : { authorization } }));

  describe.each([
    ['reconcile', reconcileRoute],
    ['cleanup', cleanupRoute],
  ])('%s', (_name, route) => {
    it.each([
      ['no Authorization header', undefined],
      ['an empty bearer', 'Bearer '],
      ['another secret', `Bearer ${'d'.repeat(40)}`],
      ['the secret without the scheme', CRON_SECRET],
      ['another scheme', `Basic ${CRON_SECRET}`],
      ['the secret and something more', `Bearer ${CRON_SECRET}x`],
    ])('rejects a call with %s', async (_label, authorization) => {
      // No deps are given, and the fake adapters have no folder: a route that built them before checking would fail.
      const res = await call(route, authorization);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
      expect(res.headers.get('cache-control')).toBe('no-store');
    });
  });

  it('rejects cron calls without the CRON_SECRET bearer, and does not run the job', async () => {
    setCronDeps({ store, blob, buy, refunds });
    const old = await delivered();
    vi.useFakeTimers({ toFake: ['Date'], now: after(31 * DAY) });

    expect((await call(cleanupRoute)).status).toBe(401);
    expect((await call(cleanupRoute, 'Bearer wrong')).status).toBe(401);
    expect(await statusOf(old)).toBe('delivered');
  });

  it('runs the reconciliation for the bearer, and answers what it did', async () => {
    setCronDeps({ store, blob, buy, refunds });
    const order = await awaiting(unixSeconds(after(10 * MINUTE)));
    // Settled only if the payment went to PAYTO_ADDRESS, the service's wallet.
    buy.consumed(order.nonce, { to: PAYTO, value: order.amount });
    vi.useFakeTimers({ toFake: ['Date'], now: after(6 * MINUTE) });

    const res = await call(reconcileRoute, `Bearer ${CRON_SECRET}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ started: [order.id], unpaid: [], refundFailed: [] });
    expect(await statusOf(order)).toBe('paid');
  });

  it('runs the cleanup for the bearer, and answers what it did', async () => {
    setCronDeps({ store, blob, buy, refunds });
    const old = await delivered();
    vi.useFakeTimers({ toFake: ['Date'], now: after(31 * DAY) });

    const res = await call(cleanupRoute, `Bearer ${CRON_SECRET}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ expired: [old.id] });
    expect(await statusOf(old)).toBe('expired');
  });
});

describe('the cron schedule', () => {
  it('runs the reconciliation every 10 minutes and the cleanup at 04:00 UTC', () => {
    expect(config.crons).toEqual([
      { path: '/api/cron/reconcile', schedule: '*/10 * * * *' },
      { path: '/api/cron/cleanup', schedule: '0 4 * * *' },
    ]);
  });

  it('points every cron at a route that exists', () => {
    for (const { path } of config.crons ?? []) {
      expect(existsSync(fileURLToPath(new URL(`../src/app${path}/route.ts`, import.meta.url))), path).toBe(true);
    }
  });
});
