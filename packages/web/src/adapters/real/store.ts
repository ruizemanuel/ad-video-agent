// The OrderStore on Postgres (Neon over HTTP in production, PGlite in the tests), through drizzle. Neon's HTTP
// driver has no interactive transactions, so every operation that must be atomic is one statement.
import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, gte, inArray, isNull, lt, ne, sql, type AnyColumn } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { costs, orders, payments, prechecks, refunds, vmTasks } from '../../db/schema';
import {
  statusesBefore,
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

const toPayment = ({ createdAt: _created, updatedAt: _updated, ...payment }: typeof payments.$inferSelect): PaymentRecord => payment;

const toRefund = ({ toAddress, createdAt: _created, updatedAt: _updated, ...refund }: typeof refunds.$inferSelect): RefundRecord => ({
  ...refund,
  to: toAddress,
});

const toTask = ({ seq: _seq, ...task }: typeof vmTasks.$inferSelect): VmTask => task;

/** What a `sum()` over a numeric column gives, as a string: 0 when there is nothing to sum. */
const total = (column: AnyColumn) => sql<string>`coalesce(sum(${column}), 0)::text`;

export class DrizzleStore implements OrderStore {
  constructor(private readonly db: Db) {}

  async createOrder(o: NewOrder): Promise<{ order: Order; created: boolean }> {
    const { request, network, asset, payer, amount, nonce, validAfter, validBefore } = o;
    const [inserted] = await this.db
      .insert(orders)
      .values({ id: newOrderId(), request, network, asset, payer, amount, nonce, validAfter, validBefore, createdAt: new Date() })
      // No conflict target: the one that can happen is the payment's unique index, which is an expression index.
      .onConflictDoNothing()
      .returning();
    if (inserted) return { order: inserted, created: true };
    const existing = await this.findOrderByPayment(o.asset, o.payer, o.nonce);
    if (!existing) throw new Error('The order was refused as a duplicate, but no order has that payment.');
    return { order: existing, created: false };
  }

  async getOrder(id: string): Promise<Order | null> {
    const [row] = await this.db.select().from(orders).where(eq(orders.id, id));
    return row ?? null;
  }

  async findOrderByPayment(asset: string, payer: string, nonce: string): Promise<Order | null> {
    const [row] = await this.db
      .select()
      .from(orders)
      .where(
        and(
          sql`lower(${orders.asset}) = ${asset.toLowerCase()}`,
          sql`lower(${orders.payer}) = ${payer.toLowerCase()}`,
          sql`lower(${orders.nonce}) = ${nonce.toLowerCase()}`,
        ),
      );
    return row ?? null;
  }

  async transition(id: string, to: OrderStatus, patch: Partial<Order> = {}): Promise<boolean> {
    const from = statusesBefore(to);
    if (from.length === 0) return false;
    const { id: _id, status: _status, ...rest } = defined(patch);
    const set: Partial<typeof orders.$inferInsert> = { ...rest, status: to };
    if (to === 'paid') set.paidAt ??= new Date();
    if (to === 'delivered') set.deliveredAt ??= new Date();
    const moved = await this.db
      .update(orders)
      .set(set)
      .where(and(eq(orders.id, id), inArray(orders.status, from)))
      .returning({ id: orders.id });
    return moved.length > 0;
  }

  // The three below change one key or one element of a json column inside the statement, so two steps running at
  // once (music and keyframes do) cannot overwrite each other the way read-then-write would.
  async setStep(id: string, name: StepName, state: StepState): Promise<void> {
    await this.db
      .update(orders)
      .set({ steps: sql`${orders.steps} || jsonb_build_object(${name}::text, ${state}::text)` })
      .where(eq(orders.id, id));
  }

  async addWarning(id: string, text: string): Promise<void> {
    await this.db
      .update(orders)
      .set({ warnings: sql`${orders.warnings} || jsonb_build_array(${text}::text)` })
      .where(eq(orders.id, id));
  }

  async setDeliverables(id: string, list: Deliverable[]): Promise<void> {
    await this.db.update(orders).set({ deliverables: list }).where(eq(orders.id, id));
  }

  async setRunId(id: string, runId: string): Promise<void> {
    await this.db.update(orders).set({ runId }).where(eq(orders.id, id));
  }

  async addCost(orderId: string, item: string, usd: number, kind: CostKind): Promise<void> {
    await this.db.insert(costs).values({ orderId, item, usd: roundUsd(usd).toFixed(6), kind, createdAt: new Date() });
  }

  async orderCost(orderId: string): Promise<number> {
    const [row] = await this.db.select({ usd: total(costs.usd) }).from(costs).where(eq(costs.orderId, orderId));
    return Number(row?.usd ?? 0);
  }

  async buySpendSince(t: Date): Promise<number> {
    const [row] = await this.db
      .select({ usd: total(costs.usd) })
      .from(costs)
      .where(and(eq(costs.kind, 'buy'), gte(costs.createdAt, t)));
    return Number(row?.usd ?? 0);
  }

  async insertPaymentIntent(r: NewPaymentIntent): Promise<boolean> {
    const { key, orderId, kind, maxAtomic } = r;
    const now = new Date();
    const inserted = await this.db
      .insert(payments)
      .values({ key, orderId, kind, maxAtomic, status: 'intent', createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: payments.key })
      .returning({ key: payments.key });
    return inserted.length > 0;
  }

  async updatePayment(key: string, patch: PaymentPatch): Promise<void> {
    await this.db
      .update(payments)
      .set({ ...defined(patch), updatedAt: new Date() })
      .where(eq(payments.key, key));
  }

  async getPayment(key: string): Promise<PaymentRecord | null> {
    const [row] = await this.db.select().from(payments).where(eq(payments.key, key));
    return row ? toPayment(row) : null;
  }

  async setVmToken(orderId: string, hash: string, expiresAt: Date): Promise<void> {
    await this.db.update(orders).set({ vmTokenHash: hash, vmTokenExpiresAt: expiresAt }).where(eq(orders.id, orderId));
  }

  async orderByVmTokenHash(hash: string): Promise<Order | null> {
    const [row] = await this.db.select().from(orders).where(eq(orders.vmTokenHash, hash));
    return row ?? null;
  }

  async enqueueTask(t: NewVmTask): Promise<VmTask> {
    const { orderId, kind, round, input, hookToken } = t;
    const [inserted] = await this.db
      .insert(vmTasks)
      .values({ id: randomUUID(), orderId, kind, round, input, hookToken, status: 'pending', createdAt: new Date() })
      .onConflictDoNothing({ target: vmTasks.hookToken })
      .returning();
    if (inserted) return toTask(inserted);
    const [existing] = await this.db.select().from(vmTasks).where(eq(vmTasks.hookToken, t.hookToken));
    if (!existing) throw new Error('The task was refused as a duplicate, but no task has that hook token.');
    return toTask(existing);
  }

  // One statement: the subquery picks the oldest pending task and locks it, skipping one that another claim holds.
  async claimNextTask(orderId: string): Promise<VmTask | null> {
    const oldest = sql`(
      select ${vmTasks.id} from ${vmTasks}
      where ${vmTasks.orderId} = ${orderId} and ${vmTasks.status} = 'pending'
      order by ${vmTasks.seq} limit 1 for update skip locked
    )`;
    const [claimed] = await this.db
      .update(vmTasks)
      .set({ status: 'claimed', claimedAt: new Date() })
      .where(sql`${vmTasks.id} = ${oldest}`)
      .returning();
    return claimed ? toTask(claimed) : null;
  }

  async finishTask(taskId: string, ok: boolean, result: unknown): Promise<VmTask | null> {
    const [finished] = await this.db
      .update(vmTasks)
      .set({ status: ok ? 'done' : 'failed', result, finishedAt: new Date() })
      .where(and(eq(vmTasks.id, taskId), eq(vmTasks.status, 'claimed')))
      .returning();
    return finished ? toTask(finished) : null;
  }

  async getTask(taskId: string): Promise<VmTask | null> {
    const [row] = await this.db.select().from(vmTasks).where(eq(vmTasks.id, taskId));
    return row ? toTask(row) : null;
  }

  async insertRefund(r: RefundRecord): Promise<boolean> {
    const now = new Date();
    const values = {
      toAddress: r.to,
      asset: r.asset,
      amount: r.amount,
      status: r.status,
      reason: r.reason,
      rawTx: r.rawTx,
      txHash: r.txHash,
      createdAt: now,
      updatedAt: now,
    };
    // A refund that failed moved no money: a new one takes its place, in the same statement, so of two only one does.
    // Any other refund stands, and nothing is written.
    const inserted = await this.db
      .insert(refunds)
      .values({ orderId: r.orderId, ...values })
      .onConflictDoUpdate({ target: refunds.orderId, set: values, setWhere: eq(refunds.status, 'failed') })
      .returning({ orderId: refunds.orderId });
    return inserted.length > 0;
  }

  async updateRefund(orderId: string, patch: RefundPatch): Promise<void> {
    const { to, ...rest } = defined(patch);
    await this.db
      .update(refunds)
      .set({ ...rest, ...(to === undefined ? {} : { toAddress: to }), updatedAt: new Date() })
      .where(eq(refunds.orderId, orderId));
  }

  async getRefund(orderId: string): Promise<RefundRecord | null> {
    const [row] = await this.db.select().from(refunds).where(eq(refunds.orderId, orderId));
    return row ? toRefund(row) : null;
  }

  async refundsSince(t: Date): Promise<number> {
    const [row] = await this.db
      .select({ atomic: total(refunds.amount) })
      .from(refunds)
      .where(and(ne(refunds.status, 'failed'), gte(refunds.createdAt, t)));
    return atomicToUsd(BigInt(row?.atomic ?? 0));
  }

  async getPrecheck(key: string, maxAgeMs: number): Promise<PrecheckResult | null> {
    const [row] = await this.db
      .select({ result: prechecks.result })
      .from(prechecks)
      .where(and(eq(prechecks.key, key), gt(prechecks.createdAt, new Date(Date.now() - maxAgeMs))));
    return row?.result ?? null;
  }

  async putPrecheck(key: string, r: PrecheckResult): Promise<void> {
    const now = new Date();
    await this.db
      .insert(prechecks)
      .values({ key, result: r, createdAt: now })
      .onConflictDoUpdate({ target: prechecks.key, set: { result: r, createdAt: now } });
  }

  ordersAwaitingSettlement(olderThan: Date): Promise<Order[]> {
    return this.db
      .select()
      .from(orders)
      .where(and(eq(orders.status, 'awaiting_settlement'), lt(orders.createdAt, olderThan)))
      .orderBy(asc(orders.createdAt));
  }

  // A paid order is stamped with its payment time, so it is the one to measure from.
  paidWithoutRun(olderThan: Date): Promise<Order[]> {
    return this.db
      .select()
      .from(orders)
      .where(and(eq(orders.status, 'paid'), isNull(orders.runId), lt(orders.paidAt, olderThan)))
      .orderBy(asc(orders.paidAt));
  }

  ordersToExpire(createdBefore: Date): Promise<Order[]> {
    return this.db
      .select()
      .from(orders)
      .where(and(inArray(orders.status, ['delivered', 'refunded', 'unpaid']), lt(orders.createdAt, createdBefore)))
      .orderBy(asc(orders.createdAt));
  }

  refundFailures(): Promise<Order[]> {
    return this.db.select().from(orders).where(eq(orders.status, 'refund_failed')).orderBy(asc(orders.createdAt));
  }
}
