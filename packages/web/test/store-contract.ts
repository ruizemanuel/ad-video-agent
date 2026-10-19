// One suite for every OrderStore: the Postgres one and its file-backed twin must answer alike.
import { beforeEach, describe, expect, it } from 'vitest';
import type { NewOrder, Order, OrderStatus, OrderStore, PrecheckResult, StepName } from '../src/ports';

const USDT = '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e';
const USDC = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C';
const PAYER = '0x1234567890AbcdEF1234567890aBcdef12345678';
const NONCE = `0x${'AB'.repeat(32)}`;
/** The wallet buy's quote says to pay. */
const BUY_PAY_TO = '0x20faAca5F980E29639A0FCC6dcA6988E18ed333B';

let counter = 0;
const uniqueNonce = () => `0x${(++counter).toString(16).padStart(64, '0')}`;
const minutes = (n: number) => n * 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);

// The same payment, every time: what a client that posts twice with one signature sends.
const newOrder = (over: Partial<NewOrder> = {}): NewOrder => ({
  request: { url: 'https://example.com', audio: 'music' },
  network: 'eip155:42220',
  asset: USDT,
  payer: PAYER,
  amount: 5_000_000n,
  nonce: NONCE,
  validAfter: 0n,
  validBefore: 1_790_000_000n,
  ...over,
});

const ALL_STATUSES: OrderStatus[] = [
  'awaiting_settlement',
  'paid',
  'running',
  'delivered',
  'unpaid',
  'refunding',
  'refunded',
  'refund_failed',
  'expired',
];

// How an order gets to each status, using only allowed transitions.
const ROUTE: Record<OrderStatus, OrderStatus[]> = {
  awaiting_settlement: [],
  paid: ['paid'],
  running: ['paid', 'running'],
  delivered: ['paid', 'running', 'delivered'],
  unpaid: ['unpaid'],
  refunding: ['paid', 'refunding'],
  refunded: ['paid', 'refunding', 'refunded'],
  refund_failed: ['paid', 'refunding', 'refund_failed'],
  expired: ['unpaid', 'expired'],
};

// The state machine of the plan, written out on purpose: it is the only list of what may happen.
const ALLOWED: [OrderStatus, OrderStatus][] = [
  ['awaiting_settlement', 'paid'],
  ['awaiting_settlement', 'unpaid'],
  ['paid', 'running'],
  ['paid', 'refunding'],
  ['running', 'delivered'],
  ['running', 'refunding'],
  ['refunding', 'refunded'],
  ['refunding', 'refund_failed'],
  ['refund_failed', 'refunding'],
  ['delivered', 'expired'],
  ['refunded', 'expired'],
  ['unpaid', 'expired'],
];

export function describeStoreContract(name: string, make: () => Promise<OrderStore>): void {
  describe(`${name} (OrderStore contract)`, () => {
    let s: OrderStore;

    beforeEach(async () => {
      s = await make();
    });

    const create = async (over: Partial<NewOrder> = {}): Promise<Order> => (await s.createOrder(newOrder({ nonce: uniqueNonce(), ...over }))).order;
    const orderIn = async (status: OrderStatus, over: Partial<NewOrder> = {}): Promise<Order> => {
      const order = await create(over);
      for (const step of ROUTE[status]) expect(await s.transition(order.id, step)).toBe(true);
      return order;
    };
    const task = (orderId: string, over: Partial<Parameters<OrderStore['enqueueTask']>[0]> = {}) => ({
      orderId,
      kind: 'capture' as const,
      round: 0,
      input: { url: 'https://example.com' },
      hookToken: `vmtask:${orderId}:capture:0`,
      ...over,
    });
    const intent = (orderId: string) => ({ key: `${orderId}:vm`, orderId, kind: 'vm' as const, maxAtomic: 70_000n });
    const refund = (orderId: string, over: Partial<Parameters<OrderStore['insertRefund']>[0]> = {}) => ({
      orderId,
      to: PAYER,
      asset: USDT,
      amount: 50_000n,
      status: 'prepared' as const,
      reason: 'render',
      rawTx: '0xraw',
      txHash: '0xhash',
      nonce: 7,
      signer: '0xsigner',
      ...over,
    });

    describe('orders', () => {
      it('creates an order awaiting settlement, with everything the payment says', async () => {
        const { order, created } = await s.createOrder(newOrder({ request: { url: 'https://example.com', brief: 'Launch week', extraUrls: ['https://example.com/app'], audio: 'none' } }));
        expect(created).toBe(true);
        expect(order).toEqual({
          id: expect.stringMatching(/^ord_[a-z2-7]{24}$/),
          status: 'awaiting_settlement',
          request: { url: 'https://example.com', brief: 'Launch week', extraUrls: ['https://example.com/app'], audio: 'none' },
          network: 'eip155:42220',
          asset: USDT,
          payer: PAYER,
          amount: 5_000_000n,
          nonce: NONCE,
          validAfter: 0n,
          validBefore: 1_790_000_000n,
          settleTx: null,
          runId: null,
          steps: {},
          deliverables: [],
          warnings: [],
          failureReason: null,
          vmTokenHash: null,
          vmTokenExpiresAt: null,
          createdAt: expect.any(Date),
          paidAt: null,
          deliveredAt: null,
        });
        expect(Math.abs(order.createdAt.getTime() - Date.now())).toBeLessThan(minutes(1));
        expect(await s.getOrder(order.id)).toEqual(order);
      });

      it('returns the same order for the same payment', async () => {
        const a = await s.createOrder(newOrder()),
          b = await s.createOrder(newOrder());
        expect([a.created, b.created]).toEqual([true, false]);
        expect(b.order.id).toBe(a.order.id);
      });

      it('sees the same payment through another spelling of the address and the nonce', async () => {
        const a = await s.createOrder(newOrder());
        const b = await s.createOrder(newOrder({ asset: USDT.toLowerCase(), payer: PAYER.toLowerCase(), nonce: NONCE.toLowerCase() }));
        expect(b.created).toBe(false);
        expect(b.order.id).toBe(a.order.id);
        expect(b.order.payer).toBe(PAYER);
      });

      it('makes a new order for another nonce, another payer or another token', async () => {
        const ids = new Set<string>();
        for (const over of [{}, { nonce: uniqueNonce() }, { payer: `0x${'9'.repeat(40)}` }, { asset: USDC }]) {
          const { order, created } = await s.createOrder(newOrder(over));
          expect(created).toBe(true);
          ids.add(order.id);
        }
        expect(ids.size).toBe(4);
      });

      it('finds an order by its payment, whatever the case', async () => {
        const { order } = await s.createOrder(newOrder());
        expect((await s.findOrderByPayment(USDT, PAYER, NONCE))?.id).toBe(order.id);
        expect((await s.findOrderByPayment(USDT.toLowerCase(), PAYER.toLowerCase(), NONCE.toLowerCase()))?.id).toBe(order.id);
        expect(await s.findOrderByPayment(USDC, PAYER, NONCE)).toBeNull();
        expect(await s.findOrderByPayment(USDT, PAYER, uniqueNonce())).toBeNull();
      });

      it('answers null for an order that does not exist', async () => {
        expect(await s.getOrder('ord_doesnotexist')).toBeNull();
      });

      it('keeps amounts and times that need all 256 bits', async () => {
        const { order } = await s.createOrder(newOrder({ nonce: uniqueNonce(), amount: 2n ** 255n, validAfter: 1n, validBefore: 2n ** 256n - 1n }));
        expect(await s.getOrder(order.id)).toMatchObject({ amount: 2n ** 255n, validAfter: 1n, validBefore: 2n ** 256n - 1n });
      });

      it('rejects two orders for one payment when asked at the same time', async () => {
        const results = await Promise.all([s.createOrder(newOrder()), s.createOrder(newOrder()), s.createOrder(newOrder())]);
        expect(results.filter((r) => r.created)).toHaveLength(1);
        expect(new Set(results.map((r) => r.order.id)).size).toBe(1);
      });
    });

    describe('transitions', () => {
      it('only allows the listed transitions', async () => {
        const { order } = await s.createOrder(newOrder());
        const id = order.id;
        expect(await s.transition(id, 'paid')).toBe(true);
        expect(await s.transition(id, 'awaiting_settlement')).toBe(false);
      });

      it('allows exactly the transitions of the plan, between every pair of statuses', async () => {
        for (const from of ALL_STATUSES) {
          for (const to of ALL_STATUSES) {
            const order = await orderIn(from);
            const allowed = ALLOWED.some(([a, b]) => a === from && b === to);
            expect(await s.transition(order.id, to), `${from} -> ${to}`).toBe(allowed);
            expect((await s.getOrder(order.id))?.status, `${from} -> ${to}`).toBe(allowed ? to : from);
          }
        }
      });

      it('can retry a failed refund', async () => {
        const order = await orderIn('refund_failed');
        expect(await s.transition(order.id, 'refunding')).toBe(true);
        expect(await s.transition(order.id, 'refunded')).toBe(true);
      });

      it('applies the patch together with the transition', async () => {
        const order = await orderIn('awaiting_settlement');
        const paidAt = new Date('2026-10-17T12:00:00.000Z');
        expect(await s.transition(order.id, 'paid', { settleTx: '0xsettle', paidAt })).toBe(true);
        expect(await s.getOrder(order.id)).toMatchObject({ status: 'paid', settleTx: '0xsettle', paidAt });
        expect(await s.transition(order.id, 'running', { runId: 'wrun_1' })).toBe(true);
        expect(await s.transition(order.id, 'refunding', { failureReason: 'render' })).toBe(true);
        expect(await s.getOrder(order.id)).toMatchObject({ status: 'refunding', runId: 'wrun_1', failureReason: 'render' });
      });

      it('leaves the order untouched when the transition is refused', async () => {
        const order = await orderIn('delivered');
        expect(await s.transition(order.id, 'running', { runId: 'wrun_2', failureReason: 'nope' })).toBe(false);
        expect(await s.getOrder(order.id)).toMatchObject({ status: 'delivered', runId: null, failureReason: null });
      });

      it('never lets a patch change the id or the status', async () => {
        const order = await orderIn('awaiting_settlement');
        expect(await s.transition(order.id, 'paid', { id: 'ord_other', status: 'delivered' })).toBe(true);
        expect(await s.getOrder(order.id)).toMatchObject({ id: order.id, status: 'paid' });
        expect(await s.getOrder('ord_other')).toBeNull();
      });

      it('stamps the payment and the delivery when the patch does not', async () => {
        const order = await orderIn('awaiting_settlement');
        await s.transition(order.id, 'paid');
        await s.transition(order.id, 'running');
        expect((await s.getOrder(order.id))?.paidAt).toBeInstanceOf(Date);
        expect((await s.getOrder(order.id))?.deliveredAt).toBeNull();
        await s.transition(order.id, 'delivered');
        const delivered = await s.getOrder(order.id);
        expect(Math.abs((delivered?.deliveredAt?.getTime() ?? 0) - Date.now())).toBeLessThan(minutes(1));
      });

      it('lets only one of several simultaneous transitions to the same status win', async () => {
        const order = await orderIn('paid');
        const results = await Promise.all([s.transition(order.id, 'running'), s.transition(order.id, 'running'), s.transition(order.id, 'running')]);
        expect(results.filter(Boolean)).toHaveLength(1);
      });

      it('refuses a transition for an order that does not exist', async () => {
        expect(await s.transition('ord_doesnotexist', 'paid')).toBe(false);
      });

      it('records the run that was started for a paid order', async () => {
        const order = await orderIn('paid');
        await s.setRunId(order.id, 'wrun_abc');
        expect(await s.getOrder(order.id)).toMatchObject({ status: 'paid', runId: 'wrun_abc' });
      });

      it('records a run id only while the order has none: the first write wins', async () => {
        const order = await orderIn('paid');
        expect(await s.setRunIdIfNone(order.id, 'wrun_first')).toBe(true);
        expect(await s.setRunIdIfNone(order.id, 'wrun_second')).toBe(false);
        expect(await s.getOrder(order.id)).toMatchObject({ status: 'paid', runId: 'wrun_first' });
      });

      it('leaves a run id that setRunId wrote when a conditional write comes after it', async () => {
        const order = await orderIn('paid');
        await s.setRunId(order.id, 'wrun_flow');
        expect(await s.setRunIdIfNone(order.id, 'wrun_reconcile')).toBe(false);
        expect((await s.getOrder(order.id))?.runId).toBe('wrun_flow');
      });

      it('writes one run id when several come at once, and says yes to one only', async () => {
        const order = await orderIn('paid');
        const results = await Promise.all(['wrun_a', 'wrun_b', 'wrun_c'].map((runId) => s.setRunIdIfNone(order.id, runId)));
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(['wrun_a', 'wrun_b', 'wrun_c'][results.indexOf(true)]).toBe((await s.getOrder(order.id))?.runId);
      });

      it('says no to a conditional run id for an order that does not exist', async () => {
        expect(await s.setRunIdIfNone('ord_doesnotexist', 'wrun')).toBe(false);
        expect(await s.getOrder('ord_doesnotexist')).toBeNull();
      });
    });

    describe('steps, warnings and deliverables', () => {
      it('keeps the steps already set when it sets another', async () => {
        const order = await create();
        await s.setStep(order.id, 'payment', 'done');
        await s.setStep(order.id, 'vm', 'running');
        await s.setStep(order.id, 'vm', 'done');
        expect((await s.getOrder(order.id))?.steps).toEqual({ payment: 'done', vm: 'done' });
      });

      it('loses no step when several are set at once', async () => {
        const order = await create();
        const names: StepName[] = ['payment', 'vm', 'capture', 'script', 'music', 'preview', 'review', 'render', 'delivery', 'refund'];
        await Promise.all(names.map((name) => s.setStep(order.id, name, 'running')));
        expect(Object.keys((await s.getOrder(order.id))?.steps ?? {}).sort()).toEqual([...names].sort());
      });

      it('appends warnings, and loses none when they come at once', async () => {
        const order = await create();
        await s.addWarning(order.id, 'first');
        await Promise.all(['a', 'b', 'c', 'd'].map((text) => s.addWarning(order.id, text)));
        const warnings = (await s.getOrder(order.id))?.warnings ?? [];
        expect(warnings[0]).toBe('first');
        expect([...warnings].sort()).toEqual(['a', 'b', 'c', 'd', 'first']);
      });

      it('replaces the deliverables', async () => {
        const order = await create();
        await s.setDeliverables(order.id, [{ name: 'a.mp4', path: `orders/${order.id}/out/a.mp4`, bytes: 10 }]);
        const list = [
          { name: 'hook-a-9x16.mp4', path: `orders/${order.id}/out/hook-a-9x16.mp4`, bytes: 1_000 },
          { name: 'claims.md', path: `orders/${order.id}/out/claims.md`, bytes: 42 },
        ];
        await s.setDeliverables(order.id, list);
        expect((await s.getOrder(order.id))?.deliverables).toEqual(list);
      });

      it('ignores writes for an order that does not exist', async () => {
        await s.setStep('ord_doesnotexist', 'vm', 'done');
        await s.addWarning('ord_doesnotexist', 'x');
        await s.setDeliverables('ord_doesnotexist', []);
        await s.setRunId('ord_doesnotexist', 'wrun');
        expect(await s.setVmToken('ord_doesnotexist', 'hash', ahead(minutes(75)))).toBe(false);
        expect(await s.getOrder('ord_doesnotexist')).toBeNull();
      });
    });

    describe('costs', () => {
      it('sums costs per order and buy spend since a date', async () => {
        const order = await create();
        await s.addCost(order.id, 'buy:vm', 0.067, 'buy');
        await s.addCost(order.id, 'llm:director', 0.2, 'card');
        expect(await s.orderCost(order.id)).toBe(0.267);
        expect(await s.buySpendSince(ago(minutes(1)))).toBe(0.067);
      });

      it('counts a cost only for its own order, and buy spend for all of them', async () => {
        const a = await create(),
          b = await create();
        await s.addCost(a.id, 'buy:vm', 0.067011, 'buy');
        await s.addCost(b.id, 'buy:vm', 0.067011, 'buy');
        await s.addCost(b.id, 'llm:judge', 0.01, 'card');
        expect(await s.orderCost(a.id)).toBe(0.067011);
        expect(await s.orderCost(b.id)).toBe(0.077011);
        expect(await s.buySpendSince(ago(minutes(1)))).toBe(0.134022);
      });

      it('has nothing to sum for an order without costs, and before any date', async () => {
        const order = await create();
        await s.addCost(order.id, 'buy:vm', 0.067, 'buy');
        expect(await s.orderCost('ord_nocosts')).toBe(0);
        expect(await s.buySpendSince(ahead(minutes(1)))).toBe(0);
      });

      it('takes costs that belong to no order, like those of the pre-check', async () => {
        await s.addCost('precheck', 'classify', 0.0004, 'card');
        expect(await s.orderCost('precheck')).toBe(0.0004);
        expect(await s.buySpendSince(ago(minutes(1)))).toBe(0);
      });

      it('sums what the pre-check cost since a date, and no order\'s costs', async () => {
        const order = await create();
        await s.addCost('precheck', 'llm:classify', 0.0004, 'card');
        await s.addCost('precheck', 'llm:classify', 0.0007, 'card');
        await s.addCost(order.id, 'llm:director', 0.2, 'card');
        await s.addCost(order.id, 'buy:vm', 0.067, 'buy');
        expect(await s.precheckSpendSince(ago(minutes(1)))).toBe(0.0011);
        expect(await s.precheckSpendSince(ahead(minutes(1)))).toBe(0);
      });

      it('rounds to the millionth of a dollar, so a sum is the same on every store', async () => {
        const order = await create();
        for (let i = 0; i < 10; i++) await s.addCost(order.id, 'llm:x', 0.1, 'card');
        expect(await s.orderCost(order.id)).toBe(1);
      });

      it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.01])('refuses a cost of %s', async (usd) => {
        const order = await create();
        await expect(s.addCost(order.id, 'llm:x', usd, 'card')).rejects.toThrow();
        expect(await s.orderCost(order.id)).toBe(0);
      });
    });

    describe('payment intents', () => {
      it('inserts a payment intent once', async () => {
        const order = await create();
        const i = intent(order.id);
        expect([await s.insertPaymentIntent(i), await s.insertPaymentIntent(i)]).toEqual([true, false]);
      });

      it('inserts it once even when two tries come at the same time', async () => {
        const order = await create();
        const results = await Promise.all([s.insertPaymentIntent(intent(order.id)), s.insertPaymentIntent(intent(order.id))]);
        expect(results.filter(Boolean)).toHaveLength(1);
      });

      it('starts the record as an intent with nothing paid yet', async () => {
        const order = await create();
        await s.insertPaymentIntent(intent(order.id));
        expect(await s.getPayment(`${order.id}:vm`)).toEqual({
          key: `${order.id}:vm`,
          orderId: order.id,
          kind: 'vm',
          maxAtomic: 70_000n,
          status: 'intent',
          asset: null,
          amount: null,
          payTo: null,
          txHash: null,
          authorization: null,
          pollUrl: null,
          outcome: null,
          reason: null,
        });
      });

      it('updates what the payment turned out to be, keeping the rest', async () => {
        const order = await create();
        await s.insertPaymentIntent(intent(order.id));
        await s.updatePayment(`${order.id}:vm`, { status: 'uncertain', outcome: 'ambiguous', reason: '5xx' });
        await s.updatePayment(`${order.id}:vm`, {
          asset: USDT,
          amount: 67_011n,
          payTo: BUY_PAY_TO,
          txHash: '0xabc',
          authorization: { from: PAYER, nonce: NONCE, validAfter: '0', validBefore: '1790000000' },
          pollUrl: 'https://usebuy.ai/google/vm/abc',
        });
        expect(await s.getPayment(`${order.id}:vm`)).toMatchObject({
          maxAtomic: 70_000n,
          status: 'uncertain',
          outcome: 'ambiguous',
          reason: '5xx',
          asset: USDT,
          amount: 67_011n,
          payTo: BUY_PAY_TO,
          txHash: '0xabc',
          authorization: { from: PAYER, nonce: NONCE, validAfter: '0', validBefore: '1790000000' },
          pollUrl: 'https://usebuy.ai/google/vm/abc',
        });
      });

      it('answers null for a payment that was never intended, and ignores updates to it', async () => {
        expect(await s.getPayment('ord_x:vm')).toBeNull();
        await s.updatePayment('ord_x:vm', { status: 'paid' });
        expect(await s.getPayment('ord_x:vm')).toBeNull();
      });

      it('refuses an intent for an order that does not exist', async () => {
        await expect(s.insertPaymentIntent(intent('ord_doesnotexist'))).rejects.toThrow();
      });
    });

    describe('VM permit', () => {
      it('finds the order that holds a permit by its hash', async () => {
        const order = await create();
        const expiresAt = new Date('2026-10-17T13:15:00.000Z');
        expect(await s.setVmToken(order.id, 'hash-1', expiresAt)).toBe(true);
        expect(await s.orderByVmTokenHash('hash-1')).toMatchObject({ id: order.id, vmTokenHash: 'hash-1', vmTokenExpiresAt: expiresAt });
        expect(await s.orderByVmTokenHash('other-hash')).toBeNull();
      });

      it('keeps the first permit: a second one is not written, and says so, as the paid VM boots with the first', async () => {
        const order = await create();
        const expiresAt = ahead(minutes(75));
        expect(await s.setVmToken(order.id, 'hash-1', expiresAt)).toBe(true);
        expect(await s.setVmToken(order.id, 'hash-2', ahead(minutes(80)))).toBe(false);
        expect(await s.orderByVmTokenHash('hash-2')).toBeNull();
        expect(await s.orderByVmTokenHash('hash-1')).toMatchObject({ id: order.id, vmTokenHash: 'hash-1', vmTokenExpiresAt: expiresAt });
      });

      it('writes the permit of one of two calls at once, and says which', async () => {
        const order = await create();
        const written = await Promise.all(['hash-a', 'hash-b', 'hash-c'].map((hash) => s.setVmToken(order.id, hash, ahead(minutes(75)))));
        expect(written.filter(Boolean)).toHaveLength(1);
        const kept = ['hash-a', 'hash-b', 'hash-c'][written.indexOf(true)] ?? '';
        expect((await s.getOrder(order.id))?.vmTokenHash).toBe(kept);
      });
    });

    describe('VM tasks', () => {
      it('enqueues a pending task', async () => {
        const order = await create();
        const queued = await s.enqueueTask(task(order.id, { kind: 'keyframes', round: 1, input: { edl: { bpm: 112 } }, hookToken: `vmtask:${order.id}:keyframes:1` }));
        expect(queued).toEqual({
          id: expect.any(String),
          orderId: order.id,
          kind: 'keyframes',
          round: 1,
          input: { edl: { bpm: 112 } },
          hookToken: `vmtask:${order.id}:keyframes:1`,
          status: 'pending',
          result: null,
          createdAt: expect.any(Date),
          claimedAt: null,
          finishedAt: null,
        });
        expect(await s.getTask(queued.id)).toEqual(queued);
      });

      it('returns the task already queued under the same hook token, so a retried step queues it once', async () => {
        const order = await create();
        const a = await s.enqueueTask(task(order.id)),
          b = await s.enqueueTask(task(order.id));
        expect(b.id).toBe(a.id);
        expect(await s.claimNextTask(order.id)).not.toBeNull();
        expect(await s.claimNextTask(order.id)).toBeNull();
      });

      it('claims the oldest pending task, and only once under concurrency', async () => {
        const order = await create();
        const id = order.id;
        await s.enqueueTask(task(id));
        const [x, y] = await Promise.all([s.claimNextTask(id), s.claimNextTask(id)]);
        expect([x, y].filter(Boolean)).toHaveLength(1);
      });

      it('claims in the order the tasks were queued', async () => {
        const order = await create();
        await s.enqueueTask(task(order.id));
        await s.enqueueTask(task(order.id, { kind: 'keyframes', hookToken: `vmtask:${order.id}:keyframes:0` }));
        await s.enqueueTask(task(order.id, { kind: 'render', hookToken: `vmtask:${order.id}:render:0` }));
        const claimed = [await s.claimNextTask(order.id), await s.claimNextTask(order.id), await s.claimNextTask(order.id), await s.claimNextTask(order.id)];
        expect(claimed.map((t) => t?.kind ?? null)).toEqual(['capture', 'keyframes', 'render', null]);
      });

      it('marks the claimed task, and never hands out the same one again', async () => {
        const order = await create();
        const queued = await s.enqueueTask(task(order.id));
        const claimed = await s.claimNextTask(order.id);
        expect(claimed).toMatchObject({ id: queued.id, status: 'claimed', claimedAt: expect.any(Date) });
        expect(await s.getTask(queued.id)).toMatchObject({ status: 'claimed' });
        expect(await s.claimNextTask(order.id)).toBeNull();
      });

      it('claims only the tasks of the order it is asked about', async () => {
        const a = await create(),
          b = await create();
        await s.enqueueTask(task(a.id));
        expect(await s.claimNextTask(b.id)).toBeNull();
        expect(await s.claimNextTask(a.id)).not.toBeNull();
      });

      it('finishes a claimed task once', async () => {
        const order = await create();
        const queued = await s.enqueueTask(task(order.id));
        await s.claimNextTask(order.id);
        const tid = queued.id;
        expect(await s.finishTask(tid, true, {})).not.toBeNull();
        expect(await s.finishTask(tid, true, {})).toBeNull();
      });

      it('keeps the result, and tells a task that worked from one that did not', async () => {
        const order = await create();
        const ok = await s.enqueueTask(task(order.id));
        const bad = await s.enqueueTask(task(order.id, { kind: 'render', hookToken: `vmtask:${order.id}:render:0` }));
        await s.claimNextTask(order.id);
        await s.claimNextTask(order.id);
        expect(await s.finishTask(ok.id, true, { ok: true, sections: 4 })).toMatchObject({ status: 'done', result: { ok: true, sections: 4 }, finishedAt: expect.any(Date) });
        expect(await s.finishTask(bad.id, false, { ok: false, code: 'error' })).toMatchObject({ status: 'failed', result: { ok: false, code: 'error' } });
        expect(await s.getTask(ok.id)).toMatchObject({ status: 'done', result: { ok: true, sections: 4 } });
      });

      it('does not finish a task that was never claimed', async () => {
        const order = await create();
        const queued = await s.enqueueTask(task(order.id));
        expect(await s.finishTask(queued.id, true, {})).toBeNull();
        expect(await s.getTask(queued.id)).toMatchObject({ status: 'pending', result: null });
      });

      it('finishes once even when two results arrive at the same time', async () => {
        const order = await create();
        const queued = await s.enqueueTask(task(order.id));
        await s.claimNextTask(order.id);
        const results = await Promise.all([s.finishTask(queued.id, true, { n: 1 }), s.finishTask(queued.id, true, { n: 2 })]);
        expect(results.filter(Boolean)).toHaveLength(1);
      });

      it('answers null for a task that does not exist', async () => {
        expect(await s.getTask('00000000-0000-4000-8000-000000000000')).toBeNull();
        expect(await s.finishTask('00000000-0000-4000-8000-000000000000', true, {})).toBeNull();
      });

      it('refuses a task for an order that does not exist', async () => {
        await expect(s.enqueueTask(task('ord_doesnotexist'))).rejects.toThrow();
      });
    });

    describe('refunds', () => {
      it('inserts a refund once and sums non-failed refunds in USD', async () => {
        const a = await create(),
          b = await create(),
          c = await create();
        expect([await s.insertRefund(refund(a.id)), await s.insertRefund(refund(a.id))]).toEqual([true, false]);
        expect(await s.insertRefund(refund(b.id, { status: 'failed', amount: 70_000n, rawTx: null, txHash: null }))).toBe(true);
        expect(await s.insertRefund(refund(c.id, { status: 'confirmed', amount: 25_000n }))).toBe(true);
        expect(await s.refundsSince(ago(minutes(1)))).toBe(0.075);
        expect(await s.refundsSince(ahead(minutes(1)))).toBe(0);
      });

      it('counts 50000 atomic units as five cents', async () => {
        const order = await create();
        await s.insertRefund(refund(order.id));
        expect(await s.refundsSince(ago(minutes(1)))).toBe(0.05);
      });

      it('gives back what it was given, with no refund replaced', async () => {
        const order = await create();
        await s.insertRefund(refund(order.id));
        expect(await s.getRefund(order.id)).toEqual({
          orderId: order.id,
          to: PAYER,
          asset: USDT,
          amount: 50_000n,
          status: 'prepared',
          reason: 'render',
          rawTx: '0xraw',
          txHash: '0xhash',
          nonce: 7,
          signer: '0xsigner',
          replacedTxHash: null,
        });
        expect(await s.getRefund('ord_norefund')).toBeNull();
      });

      it('updates the refund as it goes, and a failed one stops counting', async () => {
        const order = await create();
        await s.insertRefund(refund(order.id));
        expect(await s.updateRefund(order.id, '0xhash', { status: 'broadcast' })).toBe(true);
        expect(await s.getRefund(order.id)).toMatchObject({ status: 'broadcast', rawTx: '0xraw', txHash: '0xhash' });
        expect(await s.refundsSince(ago(minutes(1)))).toBe(0.05);
        expect(await s.updateRefund(order.id, '0xhash', { status: 'failed', reason: 'reverted' })).toBe(true);
        expect(await s.getRefund(order.id)).toMatchObject({ status: 'failed', reason: 'reverted', amount: 50_000n });
        expect(await s.refundsSince(ago(minutes(1)))).toBe(0);
      });

      it('writes over a refund only while it has the hash the writer read, and from the statuses it names', async () => {
        const order = await create();
        await s.insertRefund(refund(order.id));
        // Another hash: the refund was replaced since the writer read it.
        expect(await s.updateRefund(order.id, '0xother', { status: 'failed' })).toBe(false);
        expect(await s.getRefund(order.id)).toMatchObject({ status: 'prepared' });
        expect(await s.updateRefund(order.id, '0xhash', { status: 'confirmed' }, ['prepared', 'broadcast'])).toBe(true);
        // No longer in one of those statuses: mined, it is never marked failed.
        expect(await s.updateRefund(order.id, '0xhash', { status: 'failed' }, ['prepared', 'broadcast'])).toBe(false);
        expect(await s.getRefund(order.id)).toMatchObject({ status: 'confirmed' });
      });

      it('replaces a failed refund with a new one, and only a failed one, keeping the hash it replaced', async () => {
        const order = await create();
        await s.insertRefund(refund(order.id));
        await s.updateRefund(order.id, '0xhash', { status: 'failed' });
        expect(await s.insertRefund(refund(order.id, { rawTx: '0xraw2', txHash: '0xhash2', reason: 'vm-timeout', nonce: 8 }))).toBe(true);
        expect(await s.getRefund(order.id)).toMatchObject({
          status: 'prepared',
          rawTx: '0xraw2',
          txHash: '0xhash2',
          reason: 'vm-timeout',
          nonce: 8,
          replacedTxHash: '0xhash',
        });
        // A write keyed by the replaced hash finds nothing.
        expect(await s.updateRefund(order.id, '0xhash', { status: 'failed' }, ['prepared', 'broadcast'])).toBe(false);
        expect(await s.insertRefund(refund(order.id, { rawTx: '0xraw3', txHash: '0xhash3' }))).toBe(false);
        expect(await s.getRefund(order.id)).toMatchObject({ txHash: '0xhash2', status: 'prepared' });
        expect(await s.refundsSince(ago(minutes(1)))).toBe(0.05);
      });

      it('lets one of two replacements of a failed refund at once through', async () => {
        const order = await create();
        await s.insertRefund(refund(order.id, { status: 'failed' }));
        const inserted = await Promise.all([s.insertRefund(refund(order.id, { txHash: '0xb' })), s.insertRefund(refund(order.id, { txHash: '0xc' }))]);
        expect(inserted.filter(Boolean)).toHaveLength(1);
        expect((await s.getRefund(order.id))?.txHash).toBe(inserted[0] ? '0xb' : '0xc');
      });

      it('finds the refunds signed with a nonce', async () => {
        const a = await create(),
          b = await create(),
          c = await create();
        await s.insertRefund(refund(a.id, { nonce: 4, txHash: '0xa' }));
        await s.insertRefund(refund(b.id, { nonce: 4, txHash: '0xb' }));
        await s.insertRefund(refund(c.id, { nonce: 5, txHash: '0xc' }));
        expect((await s.refundsByNonce(4)).map((r) => r.txHash).sort()).toEqual(['0xa', '0xb']);
        expect(await s.refundsByNonce(9)).toEqual([]);
      });

      it('finds the orders still refunding whose refund has not been written since a moment', async () => {
        const stalled = await orderIn('refunding');
        const fresh = await orderIn('refunding');
        const done = await orderIn('refunded');
        const unsigned = await orderIn('refunding');
        await s.insertRefund(refund(stalled.id, { txHash: '0xs' }));
        await s.insertRefund(refund(fresh.id, { txHash: '0xf' }));
        await s.insertRefund(refund(done.id, { txHash: '0xd', status: 'confirmed' }));
        const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
        await pause();
        const cutoff = new Date();
        await pause();
        // Written after the cutoff: it has moved since.
        await s.updateRefund(fresh.id, '0xf', { status: 'broadcast' });
        expect((await s.stalledRefunds(cutoff, 10)).map((o) => o.id)).toEqual([stalled.id]);
        expect(await s.stalledRefunds(ago(minutes(1)), 10)).toEqual([]);
        // An order refunding with no refund signed yet is not one of them.
        expect((await s.stalledRefunds(ahead(minutes(1)), 10)).map((o) => o.id)).not.toContain(unsigned.id);
      });

      it('finds the orders refunding with no refund signed, paid before a moment', async () => {
        const unsigned = await orderIn('refunding');
        const signed = await orderIn('refunding');
        await orderIn('running');
        await s.insertRefund(refund(signed.id));
        expect((await s.unsignedRefunds(ahead(minutes(1)), 10)).map((o) => o.id)).toEqual([unsigned.id]);
        expect(await s.unsignedRefunds(ago(minutes(1)), 10)).toEqual([]);
      });

      it('ignores an update to a refund that does not exist', async () => {
        expect(await s.updateRefund('ord_norefund', '0xhash', { status: 'confirmed' })).toBe(false);
        expect(await s.getRefund('ord_norefund')).toBeNull();
      });

      it('refuses a refund for an order that does not exist', async () => {
        await expect(s.insertRefund(refund('ord_doesnotexist'))).rejects.toThrow();
      });
    });

    describe('pre-checks', () => {
      const ok: PrecheckResult = { ok: true, thin: true, demoLinks: ['https://example.com/demo'] };
      const blocked: PrecheckResult = { ok: false, code: 'blocked', reason: 'The site answered with a challenge page.' };

      it('gives back what it was given', async () => {
        await s.putPrecheck('key-ok', ok);
        await s.putPrecheck('key-blocked', blocked);
        await s.putPrecheck('key-unknown-thinness', { ok: true, thin: null, demoLinks: [] });
        expect(await s.getPrecheck('key-ok', minutes(10))).toEqual(ok);
        expect(await s.getPrecheck('key-blocked', minutes(10))).toEqual(blocked);
        expect(await s.getPrecheck('key-unknown-thinness', minutes(10))).toEqual({ ok: true, thin: null, demoLinks: [] });
        expect(await s.getPrecheck('key-missing', minutes(10))).toBeNull();
      });

      it('expires prechecks by age', async () => {
        await s.putPrecheck('key', ok);
        expect(await s.getPrecheck('key', 0)).toBeNull();
        expect(await s.getPrecheck('key', minutes(10))).toEqual(ok);
      });

      it('keeps the latest result for a key', async () => {
        await s.putPrecheck('key', ok);
        await s.putPrecheck('key', blocked);
        expect(await s.getPrecheck('key', minutes(10))).toEqual(blocked);
      });
    });

    describe('what the cron looks for', () => {
      const ids = (orders: Order[]) => orders.map((o) => o.id).sort();

      it('lists orders awaiting settlement older than a date', async () => {
        const waiting = await create();
        await orderIn('paid');
        expect(ids(await s.ordersAwaitingSettlement(ahead(minutes(1)), 10))).toEqual([waiting.id]);
        expect(await s.ordersAwaitingSettlement(ago(minutes(1)), 10)).toEqual([]);
      });

      it('lists paid orders with no run, older than a date', async () => {
        const stuck = await orderIn('paid');
        const started = await orderIn('paid');
        await s.setRunId(started.id, 'wrun_1');
        await orderIn('running');
        await create();
        expect(ids(await s.paidWithoutRun(ahead(minutes(1)), 10))).toEqual([stuck.id]);
        expect(await s.paidWithoutRun(ago(minutes(1)), 10)).toEqual([]);
      });

      it('lists delivered, refunded and unpaid orders created before a date', async () => {
        const delivered = await orderIn('delivered'),
          refunded = await orderIn('refunded'),
          unpaid = await orderIn('unpaid');
        await orderIn('running');
        await orderIn('refund_failed');
        await orderIn('expired');
        await create();
        expect(ids(await s.ordersToExpire(ahead(minutes(1))))).toEqual([delivered.id, refunded.id, unpaid.id].sort());
        expect(await s.ordersToExpire(ago(minutes(1)))).toEqual([]);
      });

      it('lists the orders whose refund failed', async () => {
        const failed = await orderIn('refund_failed');
        await orderIn('refunding');
        await orderIn('refunded');
        expect(ids(await s.refundFailures(10))).toEqual([failed.id]);
        await s.transition(failed.id, 'refunding');
        expect(await s.refundFailures(10)).toEqual([]);
      });

      it('lists the paid orders whose run should be over: paid with a run, or running, paid before a date', async () => {
        const started = await orderIn('paid');
        await s.setRunId(started.id, 'wrun_1');
        const running = await orderIn('running');
        await s.setRunId(running.id, 'wrun_2');
        // Not these: a paid order with no run yet (another pass starts it), and the orders past running.
        await orderIn('paid');
        for (const status of ['delivered', 'refunding', 'refunded', 'refund_failed', 'unpaid', 'expired'] as const) await orderIn(status);
        await create();
        expect(ids(await s.runsOverdue(ahead(minutes(1)), 10))).toEqual([started.id, running.id].sort());
        expect(await s.runsOverdue(ago(minutes(1)), 10)).toEqual([]);
      });

      it('pages through the overdue runs: after a cursor come the next ones by payment, the id settling a tie', async () => {
        const at = ago(minutes(10));
        const tied: string[] = [];
        for (let k = 0; k < 3; k++) {
          const order = await create();
          expect(await s.transition(order.id, 'paid', { paidAt: at })).toBe(true);
          await s.setRunId(order.id, `wrun_tied_${k}`);
          expect(await s.transition(order.id, 'running')).toBe(true);
          tied.push(order.id);
        }
        const later = await create();
        await s.transition(later.id, 'paid', { paidAt: new Date(at.getTime() + 1000) });
        await s.setRunId(later.id, 'wrun_later');
        const inOrder = [...tied].sort();
        const page = (orders: Order[]) => orders.map((o) => o.id);

        const first = await s.runsOverdue(ahead(minutes(1)), 2);
        expect(page(first)).toEqual(inOrder.slice(0, 2));
        const last = first.at(-1)!;
        expect(page(await s.runsOverdue(ahead(minutes(1)), 10, { paidAt: last.paidAt!, id: last.id }))).toEqual([inOrder[2], later.id]);
        expect(await s.runsOverdue(ahead(minutes(1)), 10, { paidAt: new Date(at.getTime() + 1000), id: later.id })).toEqual([]);
      });

      describe('at most as many as asked, the oldest first', () => {
        const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
        /** Three orders, each made (and moved through its route) a little after the one before. */
        const three = async (status: OrderStatus, then?: (order: Order) => Promise<unknown>): Promise<string[]> => {
          const made: string[] = [];
          for (let k = 0; k < 3; k++) {
            const order = await orderIn(status);
            await then?.(order);
            made.push(order.id);
            await pause();
          }
          return made;
        };
        const later = () => ahead(minutes(1));
        const first = (orders: Order[]) => orders.map((o) => o.id);

        it('of the orders awaiting settlement', async () => {
          const made = await three('awaiting_settlement');
          expect(first(await s.ordersAwaitingSettlement(later(), 2))).toEqual(made.slice(0, 2));
        });

        it('of the paid orders with no run', async () => {
          const made = await three('paid');
          expect(first(await s.paidWithoutRun(later(), 2))).toEqual(made.slice(0, 2));
        });

        it('of the paid orders whose run should be over', async () => {
          const made = await three('running', (o) => s.setRunId(o.id, `wrun_${o.id}`));
          expect(first(await s.runsOverdue(later(), 2))).toEqual(made.slice(0, 2));
        });

        it('of the stalled refunds', async () => {
          const made = await three('refunding', (o) => s.insertRefund(refund(o.id, { txHash: `0x${o.id}` })));
          expect(first(await s.stalledRefunds(later(), 2))).toEqual(made.slice(0, 2));
        });

        it('of the unsigned refunds', async () => {
          const made = await three('refunding');
          expect(first(await s.unsignedRefunds(later(), 2))).toEqual(made.slice(0, 2));
        });

        it('of the failed refunds', async () => {
          const made = await three('refund_failed');
          expect(first(await s.refundFailures(2))).toEqual(made.slice(0, 2));
        });
      });
    });
  });
}
