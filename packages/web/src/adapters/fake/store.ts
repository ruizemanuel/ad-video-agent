// The OrderStore on plain files, for the tests that run the whole flow without a database: the integration tests
// of the order workflow seed and read orders through it under a temporary FAKE_DIR. It answers exactly as the
// Postgres store does (test/store-contract.ts runs both), but it is only as safe as one process: a mutex in
// memory per directory keeps the read-then-write operations atomic, and nothing guards against a second process.
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  canTransition,
  type CostKind,
  type Deliverable,
  type NewOrder,
  type NewPaymentIntent,
  type NewVmTask,
  type Order,
  type OrderStatus,
  type OrderStore,
  type PaymentPatch,
  type PaymentRecord,
  type PrecheckResult,
  type RefundPatch,
  type RefundRecord,
  type StepName,
  type StepState,
  type VmTask,
} from '../../ports';
import { atomicToUsd, defined, newOrderId, roundUsd } from '../store-common';

type Collection = 'orders' | 'tasks' | 'payments' | 'costs' | 'refunds' | 'prechecks';

type Timestamps = { createdAt: Date; updatedAt: Date };
type StoredPayment = PaymentRecord & Timestamps;
type StoredRefund = RefundRecord & Timestamps;
// `seq` is the order in which tasks were queued; the oldest pending one is handed out first.
type StoredTask = VmTask & { seq: number };
type StoredCost = { orderId: string; item: string; usd: number; kind: CostKind; createdAt: Date };
type StoredPrecheck = { result: PrecheckResult; createdAt: Date };

// JSON has neither bigint nor Date. They travel as `{ $bigint }` and `{ $date }`.
const encode = (value: unknown): string =>
  JSON.stringify(
    value,
    function (this: Record<string, unknown>, key: string, current: unknown) {
      const original = this[key];
      if (typeof original === 'bigint') return { $bigint: original.toString() };
      if (original instanceof Date) return { $date: original.toISOString() };
      return current;
    },
    2,
  );

const decode = (text: string): unknown =>
  JSON.parse(text, (_key, value: unknown) => {
    if (value !== null && typeof value === 'object') {
      const tagged = value as Record<string, unknown>;
      if (Object.keys(tagged).length === 1) {
        if (typeof tagged.$bigint === 'string') return BigInt(tagged.$bigint);
        if (typeof tagged.$date === 'string') return new Date(tagged.$date);
      }
    }
    return value;
  });

// A key as a file name that every system accepts: no colon (Windows), no star, nothing that is not a letter or digit.
const fileName = (key: string): string =>
  encodeURIComponent(key).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

const isMissing = (error: unknown): boolean => (error as { code?: string }).code === 'ENOENT';

// One queue per directory in this process, shared by every FileStore over it: a test that seeds an order with one
// instance and a workflow that reads it with another must not interleave their writes.
const queues = new Map<string, Promise<unknown>>();
function inQueue<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const result = (queues.get(dir) ?? Promise.resolve()).then(run);
  queues.set(
    dir,
    result.catch(() => undefined),
  );
  return result;
}

const byAge = <T extends { createdAt: Date }>(a: T, b: T): number => a.createdAt.getTime() - b.createdAt.getTime();
const sameHex = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const publicPayment = ({ createdAt: _created, updatedAt: _updated, ...payment }: StoredPayment): PaymentRecord => payment;
const publicRefund = ({ createdAt: _created, updatedAt: _updated, ...refund }: StoredRefund): RefundRecord => refund;
const publicTask = ({ seq: _seq, ...task }: StoredTask): VmTask => task;

export class FileStore implements OrderStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  // The files: one JSON per record, written to a temporary file and renamed, so a reader never sees half a record.

  private file(collection: Collection, key: string): string {
    return join(this.dir, collection, `${fileName(key)}.json`);
  }

  private async read<T>(collection: Collection, key: string): Promise<T | null> {
    try {
      return decode(await readFile(this.file(collection, key), 'utf8')) as T;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  private async write(collection: Collection, key: string, value: unknown): Promise<void> {
    const target = this.file(collection, key);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, encode(value));
    await rename(temporary, target);
  }

  private async all<T>(collection: Collection): Promise<T[]> {
    const folder = join(this.dir, collection);
    let names: string[];
    try {
      names = await readdir(folder);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    return Promise.all(names.filter((name) => name.endsWith('.json')).map(async (name) => decode(await readFile(join(folder, name), 'utf8')) as T));
  }

  private locked<T>(run: () => Promise<T>): Promise<T> {
    return inQueue(this.dir, run);
  }

  /** Changes one order, if it exists, with the queue held. */
  private changeOrder(id: string, change: (order: Order) => Order): Promise<void> {
    return this.locked(async () => {
      const order = await this.read<Order>('orders', id);
      if (order) await this.write('orders', id, change(order));
    });
  }

  private async requireOrder(id: string): Promise<void> {
    if (!(await this.read('orders', id))) throw new Error(`There is no order ${id}.`);
  }

  private async findByPayment(asset: string, payer: string, nonce: string): Promise<Order | null> {
    const found = (await this.all<Order>('orders')).find((o) => sameHex(o.asset, asset) && sameHex(o.payer, payer) && sameHex(o.nonce, nonce));
    return found ?? null;
  }

  private async ordersWhere(keep: (order: Order) => boolean): Promise<Order[]> {
    return (await this.all<Order>('orders')).filter(keep).sort(byAge);
  }

  // Orders.

  createOrder(o: NewOrder): Promise<{ order: Order; created: boolean }> {
    return this.locked(async () => {
      const existing = await this.findByPayment(o.asset, o.payer, o.nonce);
      if (existing) return { order: existing, created: false };
      const order: Order = {
        id: newOrderId(),
        status: 'awaiting_settlement',
        request: o.request,
        network: o.network,
        asset: o.asset,
        payer: o.payer,
        amount: o.amount,
        nonce: o.nonce,
        validAfter: o.validAfter,
        validBefore: o.validBefore,
        settleTx: null,
        runId: null,
        steps: {},
        deliverables: [],
        warnings: [],
        failureReason: null,
        vmTokenHash: null,
        vmTokenExpiresAt: null,
        createdAt: new Date(),
        paidAt: null,
        deliveredAt: null,
      };
      await this.write('orders', order.id, order);
      return { order, created: true };
    });
  }

  getOrder(id: string): Promise<Order | null> {
    return this.locked(() => this.read<Order>('orders', id));
  }

  findOrderByPayment(asset: string, payer: string, nonce: string): Promise<Order | null> {
    return this.locked(() => this.findByPayment(asset, payer, nonce));
  }

  transition(id: string, to: OrderStatus, patch: Partial<Order> = {}): Promise<boolean> {
    return this.locked(async () => {
      const order = await this.read<Order>('orders', id);
      if (!order || !canTransition(order.status, to)) return false;
      const { id: _id, status: _status, ...rest } = defined(patch);
      const next: Order = { ...order, ...rest, status: to };
      if (to === 'paid') next.paidAt ??= new Date();
      if (to === 'delivered') next.deliveredAt ??= new Date();
      await this.write('orders', id, next);
      return true;
    });
  }

  setStep(id: string, name: StepName, state: StepState): Promise<void> {
    return this.changeOrder(id, (order) => ({ ...order, steps: { ...order.steps, [name]: state } }));
  }

  addWarning(id: string, text: string): Promise<void> {
    return this.changeOrder(id, (order) => ({ ...order, warnings: [...order.warnings, text] }));
  }

  setDeliverables(id: string, list: Deliverable[]): Promise<void> {
    return this.changeOrder(id, (order) => ({ ...order, deliverables: list }));
  }

  setRunId(id: string, runId: string): Promise<void> {
    return this.changeOrder(id, (order) => ({ ...order, runId }));
  }

  setVmToken(orderId: string, hash: string, expiresAt: Date): Promise<void> {
    return this.changeOrder(orderId, (order) => ({ ...order, vmTokenHash: hash, vmTokenExpiresAt: expiresAt }));
  }

  orderByVmTokenHash(hash: string): Promise<Order | null> {
    return this.locked(async () => (await this.all<Order>('orders')).find((o) => o.vmTokenHash === hash) ?? null);
  }

  // Costs.

  async addCost(orderId: string, item: string, usd: number, kind: CostKind): Promise<void> {
    const cost: StoredCost = { orderId, item, usd: roundUsd(usd), kind, createdAt: new Date() };
    await this.locked(() => this.write('costs', randomUUID(), cost));
  }

  // Summed in millionths of a dollar, which are whole numbers: no float drift.
  private async sumCosts(keep: (cost: StoredCost) => boolean): Promise<number> {
    const micros = (await this.all<StoredCost>('costs')).filter(keep).reduce((sum, cost) => sum + Math.round(cost.usd * 1e6), 0);
    return micros / 1e6;
  }

  orderCost(orderId: string): Promise<number> {
    return this.locked(() => this.sumCosts((cost) => cost.orderId === orderId));
  }

  buySpendSince(t: Date): Promise<number> {
    return this.locked(() => this.sumCosts((cost) => cost.kind === 'buy' && cost.createdAt >= t));
  }

  // Payments.

  insertPaymentIntent(r: NewPaymentIntent): Promise<boolean> {
    return this.locked(async () => {
      await this.requireOrder(r.orderId);
      if (await this.read('payments', r.key)) return false;
      const now = new Date();
      const payment: StoredPayment = {
        key: r.key,
        orderId: r.orderId,
        kind: r.kind,
        maxAtomic: r.maxAtomic,
        status: 'intent',
        asset: null,
        amount: null,
        payTo: null,
        txHash: null,
        authorization: null,
        pollUrl: null,
        outcome: null,
        reason: null,
        createdAt: now,
        updatedAt: now,
      };
      await this.write('payments', r.key, payment);
      return true;
    });
  }

  updatePayment(key: string, patch: PaymentPatch): Promise<void> {
    return this.locked(async () => {
      const payment = await this.read<StoredPayment>('payments', key);
      if (payment) await this.write('payments', key, { ...payment, ...defined(patch), updatedAt: new Date() });
    });
  }

  getPayment(key: string): Promise<PaymentRecord | null> {
    return this.locked(async () => {
      const payment = await this.read<StoredPayment>('payments', key);
      return payment ? publicPayment(payment) : null;
    });
  }

  // VM tasks.

  enqueueTask(t: NewVmTask): Promise<VmTask> {
    return this.locked(async () => {
      await this.requireOrder(t.orderId);
      const tasks = await this.all<StoredTask>('tasks');
      const existing = tasks.find((task) => task.hookToken === t.hookToken);
      if (existing) return publicTask(existing);
      const task: StoredTask = {
        id: randomUUID(),
        seq: tasks.reduce((highest, other) => Math.max(highest, other.seq), 0) + 1,
        orderId: t.orderId,
        kind: t.kind,
        round: t.round,
        input: t.input,
        hookToken: t.hookToken,
        status: 'pending',
        result: null,
        createdAt: new Date(),
        claimedAt: null,
        finishedAt: null,
      };
      await this.write('tasks', task.id, task);
      return publicTask(task);
    });
  }

  claimNextTask(orderId: string): Promise<VmTask | null> {
    return this.locked(async () => {
      const pending = (await this.all<StoredTask>('tasks')).filter((task) => task.orderId === orderId && task.status === 'pending');
      const oldest = pending.sort((a, b) => a.seq - b.seq)[0];
      if (!oldest) return null;
      const claimed: StoredTask = { ...oldest, status: 'claimed', claimedAt: new Date() };
      await this.write('tasks', claimed.id, claimed);
      return publicTask(claimed);
    });
  }

  finishTask(taskId: string, ok: boolean, result: unknown): Promise<VmTask | null> {
    return this.locked(async () => {
      const task = await this.read<StoredTask>('tasks', taskId);
      if (!task || task.status !== 'claimed') return null;
      const finished: StoredTask = { ...task, status: ok ? 'done' : 'failed', result, finishedAt: new Date() };
      await this.write('tasks', taskId, finished);
      return publicTask(finished);
    });
  }

  getTask(taskId: string): Promise<VmTask | null> {
    return this.locked(async () => {
      const task = await this.read<StoredTask>('tasks', taskId);
      return task ? publicTask(task) : null;
    });
  }

  // Refunds.

  insertRefund(r: RefundRecord): Promise<boolean> {
    return this.locked(async () => {
      await this.requireOrder(r.orderId);
      // A refund that failed moved no money: a new one takes its place. Any other stands.
      const existing = await this.read<StoredRefund>('refunds', r.orderId);
      if (existing && existing.status !== 'failed') return false;
      const now = new Date();
      const refund: StoredRefund = {
        orderId: r.orderId,
        to: r.to,
        asset: r.asset,
        amount: r.amount,
        status: r.status,
        reason: r.reason,
        rawTx: r.rawTx,
        txHash: r.txHash,
        createdAt: now,
        updatedAt: now,
      };
      await this.write('refunds', r.orderId, refund);
      return true;
    });
  }

  updateRefund(orderId: string, patch: RefundPatch): Promise<void> {
    return this.locked(async () => {
      const refund = await this.read<StoredRefund>('refunds', orderId);
      if (refund) await this.write('refunds', orderId, { ...refund, ...defined(patch), updatedAt: new Date() });
    });
  }

  getRefund(orderId: string): Promise<RefundRecord | null> {
    return this.locked(async () => {
      const refund = await this.read<StoredRefund>('refunds', orderId);
      return refund ? publicRefund(refund) : null;
    });
  }

  refundsSince(t: Date): Promise<number> {
    return this.locked(async () => {
      const refunds = (await this.all<StoredRefund>('refunds')).filter((refund) => refund.status !== 'failed' && refund.createdAt >= t);
      return atomicToUsd(refunds.reduce((sum, refund) => sum + refund.amount, 0n));
    });
  }

  // Pre-checks.

  getPrecheck(key: string, maxAgeMs: number): Promise<PrecheckResult | null> {
    return this.locked(async () => {
      const stored = await this.read<StoredPrecheck>('prechecks', key);
      return stored && stored.createdAt.getTime() > Date.now() - maxAgeMs ? stored.result : null;
    });
  }

  putPrecheck(key: string, r: PrecheckResult): Promise<void> {
    const stored: StoredPrecheck = { result: r, createdAt: new Date() };
    return this.locked(() => this.write('prechecks', key, stored));
  }

  // What the cron looks for.

  ordersAwaitingSettlement(olderThan: Date): Promise<Order[]> {
    return this.locked(() => this.ordersWhere((o) => o.status === 'awaiting_settlement' && o.createdAt < olderThan));
  }

  paidWithoutRun(olderThan: Date): Promise<Order[]> {
    return this.locked(() => this.ordersWhere((o) => o.status === 'paid' && o.runId === null && o.paidAt !== null && o.paidAt < olderThan));
  }

  ordersToExpire(createdBefore: Date): Promise<Order[]> {
    return this.locked(() => this.ordersWhere((o) => ['delivered', 'refunded', 'unpaid'].includes(o.status) && o.createdAt < createdBefore));
  }

  refundFailures(): Promise<Order[]> {
    return this.locked(() => this.ordersWhere((o) => o.status === 'refund_failed'));
  }
}
