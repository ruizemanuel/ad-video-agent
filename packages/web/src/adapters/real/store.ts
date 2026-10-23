// The OrderStore on Postgres (Neon over HTTP in production, PGlite in the tests), through drizzle. Neon's HTTP
// driver has no interactive transactions, so every operation that must be atomic is one statement.
import { randomUUID } from 'node:crypto';
import { and, asc, count, eq, getTableColumns, gt, gte, inArray, is, isNotNull, isNull, lt, lte, ne, or, SQL, sql, type AnyColumn } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { costs, feedback, holdsPromoSlot, holdsVideo, orders, payments, prechecks, refunds, vmTasks } from '../../db/schema';
import {
  statusesBefore,
  type CostKind,
  type Deliverable,
  type Feedback,
  type NewOrder,
  type NewPaymentIntent,
  type NewRefund,
  type NewVmTask,
  type Order,
  type OrderCursor,
  type OrderStatus,
  type OrderStore,
  type PaymentPatch,
  type PaymentRecord,
  type PrecheckResult,
  type RefundPatch,
  type RefundRecord,
  type RefundStatus,
  type StepName,
  type StepState,
  type VmTask,
} from '../../ports';
import { atomicToUsd, defined, keptFeedback, lowestFreeSlot, newOrderId, roundUsd } from '../store-common';

const toPayment = ({ createdAt: _created, updatedAt: _updated, ...payment }: typeof payments.$inferSelect): PaymentRecord => payment;

const toRefund = ({ toAddress, createdAt: _created, updatedAt: _updated, ...refund }: typeof refunds.$inferSelect): RefundRecord => ({
  ...refund,
  to: toAddress,
});

const toTask = ({ seq: _seq, ...task }: typeof vmTasks.$inferSelect): VmTask => task;

/** What a `sum()` over a numeric column gives, as a string: 0 when there is nothing to sum. */
const total = (column: AnyColumn) => sql<string>`coalesce(sum(${column}), 0)::text`;

/**
 * A new order as the select list of an INSERT … SELECT, which names every column of the table in its order (`orders`
 * has no generated column): the value `values` gives, or else the column's default, as VALUES would put it. Each value
 * is cast to its column's type, which a SELECT, unlike VALUES, does not take from the columns it fills.
 */
function selectedOrder(values: Partial<typeof orders.$inferInsert>): SQL {
  return sql.join(
    Object.entries(getTableColumns(orders)).map(([key, column]) => {
      const value: unknown = key in values ? values[key as keyof typeof values] : (column.default ?? null);
      return is(value, SQL) ? value : sql`${sql.param(value, column)}::${sql.raw(column.getSQLType())}`;
    }),
    sql`, `,
  );
}

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

  // The promo's atomicity rests on the two unique indexes of schema.ts and on single statements: a slot or a wallet
  // taken by another call at the same moment makes the insert write nothing, and what was taken is then read back.
  async createPromoOrder(o: NewOrder, slots: number): Promise<{ order: Order; created: boolean } | { refused: 'no_slot' | 'not_first_video' }> {
    const existing = await this.findOrderByPayment(o.asset, o.payer, o.nonce);
    if (existing) return { order: existing, created: false };
    // A pass that writes nothing and finds neither the payment nor a video lost its slot to an order made at the same
    // moment, which now holds it; the next pass takes another. A slot freed meanwhile could make the passes run out
    // first: the payment is then refused, and the payer asks for a new quote.
    for (let pass = 0; pass < slots; pass++) {
      const slot = lowestFreeSlot(await this.heldSlots(slots), slots);
      if (slot === null) break;
      const [inserted] = await this.insertPromoOrder(o, slot);
      if (inserted) return { order: inserted, created: true };
      const same = await this.findOrderByPayment(o.asset, o.payer, o.nonce);
      if (same) return { order: same, created: false };
      if (await this.hasVideo(o.payer)) return { refused: 'not_first_video' };
    }
    return (await this.hasVideo(o.payer)) ? { refused: 'not_first_video' } : { refused: 'no_slot' };
  }

  /** The promo slots in 1..`slots` that an order holds. */
  private async heldSlots(slots: number): Promise<(number | null)[]> {
    const rows = await this.db
      .select({ slot: orders.promoSlot })
      .from(orders)
      .where(and(holdsPromoSlot(orders), lte(orders.promoSlot, slots)));
    return rows.map((row) => row.slot);
  }

  /**
   * One statement: the order holding `slot`, written only if the wallet has no video (the condition VALUES cannot carry,
   * so it is an INSERT … SELECT). Nothing is written, and nothing comes back, when the wallet has one, when the slot or
   * the wallet's promo is held (the promo indexes), or when the payment already made an order.
   */
  private insertPromoOrder(o: NewOrder, slot: number): Promise<Order[]> {
    const { request, network, asset, payer, amount, nonce, validAfter, validBefore } = o;
    const order = selectedOrder({ id: newOrderId(), request, network, asset, payer, amount, nonce, validAfter, validBefore, promoSlot: slot, createdAt: new Date() });
    const walletHasVideo = sql`exists (select 1 from ${orders} where lower(${orders.payer}) = ${payer.toLowerCase()} and ${holdsVideo(orders)})`;
    return this.db
      .insert(orders)
      .select(sql`select ${order} where not ${walletHasVideo}`)
      .onConflictDoNothing()
      .returning();
  }

  async promoSlotsUsed(): Promise<number> {
    const [row] = await this.db.select({ used: count() }).from(orders).where(holdsPromoSlot(orders));
    return row?.used ?? 0;
  }

  async hasVideo(payer: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: orders.id })
      .from(orders)
      .where(and(sql`lower(${orders.payer}) = ${payer.toLowerCase()}`, holdsVideo(orders)))
      .limit(1);
    return row !== undefined;
  }

  async getOrder(id: string): Promise<Order | null> {
    const [row] = await this.db.select().from(orders).where(eq(orders.id, id));
    return row ?? null;
  }

  // One statement, so two answers given at once leave one of them whole. The FK refuses an order that does not exist.
  async setFeedback(orderId: string, f: Omit<Feedback, 'updatedAt'>): Promise<void> {
    const kept = keptFeedback(f, new Date());
    await this.db
      .insert(feedback)
      .values({ orderId, ...kept })
      .onConflictDoUpdate({ target: feedback.orderId, set: kept });
  }

  async getFeedback(orderId: string): Promise<Feedback | null> {
    const [row] = await this.db
      .select({ answer: feedback.answer, postUrl: feedback.postUrl, mayShow: feedback.mayShow, updatedAt: feedback.updatedAt })
      .from(feedback)
      .where(eq(feedback.orderId, orderId));
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

  // One statement: of several calls at once, only one finds the column empty.
  async setRunIdIfNone(id: string, runId: string): Promise<boolean> {
    const written = await this.db
      .update(orders)
      .set({ runId })
      .where(and(eq(orders.id, id), isNull(orders.runId)))
      .returning({ id: orders.id });
    return written.length > 0;
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

  // The pre-check's costs are card costs: the condition on the kind lets the (kind, created_at) index find the day's.
  async precheckSpendSince(t: Date): Promise<number> {
    const [row] = await this.db
      .select({ usd: total(costs.usd) })
      .from(costs)
      .where(and(eq(costs.kind, 'card'), gte(costs.createdAt, t), eq(costs.orderId, 'precheck')));
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

  async setVmToken(orderId: string, hash: string, expiresAt: Date): Promise<boolean> {
    const written = await this.db
      .update(orders)
      .set({ vmTokenHash: hash, vmTokenExpiresAt: expiresAt })
      .where(and(eq(orders.id, orderId), isNull(orders.vmTokenHash)))
      .returning({ id: orders.id });
    return written.length > 0;
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
  // The outer condition also requires 'pending', so a task that is no longer pending is never claimed again.
  async claimNextTask(orderId: string): Promise<VmTask | null> {
    const oldest = sql`(
      select ${vmTasks.id} from ${vmTasks}
      where ${vmTasks.orderId} = ${orderId} and ${vmTasks.status} = 'pending'
      order by ${vmTasks.seq} limit 1 for update skip locked
    )`;
    const [claimed] = await this.db
      .update(vmTasks)
      .set({ status: 'claimed', claimedAt: new Date() })
      .where(and(sql`${vmTasks.id} = ${oldest}`, eq(vmTasks.status, 'pending')))
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

  async insertRefund(r: NewRefund): Promise<boolean> {
    const now = new Date();
    const values = {
      toAddress: r.to,
      asset: r.asset,
      amount: r.amount,
      status: r.status,
      reason: r.reason,
      rawTx: r.rawTx,
      txHash: r.txHash,
      nonce: r.nonce,
      signer: r.signer,
      createdAt: now,
      updatedAt: now,
    };
    // A refund that failed moved no money: a new one takes its place, in the same statement, so of two only one does,
    // and keeps the replaced one's hash (in SET, the table's columns are the row being replaced). Any other refund stands,
    // and nothing is written.
    const inserted = await this.db
      .insert(refunds)
      .values({ orderId: r.orderId, ...values })
      .onConflictDoUpdate({
        target: refunds.orderId,
        set: { ...values, replacedTxHash: sql`${refunds.txHash}` },
        setWhere: eq(refunds.status, 'failed'),
      })
      .returning({ orderId: refunds.orderId });
    return inserted.length > 0;
  }

  async updateRefund(orderId: string, txHash: string, patch: RefundPatch, from?: readonly RefundStatus[]): Promise<boolean> {
    const { to, ...rest } = defined(patch);
    const updated = await this.db
      .update(refunds)
      .set({ ...rest, ...(to === undefined ? {} : { toAddress: to }), updatedAt: new Date() })
      .where(and(eq(refunds.orderId, orderId), eq(refunds.txHash, txHash), from === undefined ? undefined : inArray(refunds.status, [...from])))
      .returning({ orderId: refunds.orderId });
    return updated.length > 0;
  }

  async getRefund(orderId: string): Promise<RefundRecord | null> {
    const [row] = await this.db.select().from(refunds).where(eq(refunds.orderId, orderId));
    return row ? toRefund(row) : null;
  }

  async refundsByNonce(nonce: number): Promise<RefundRecord[]> {
    return (await this.db.select().from(refunds).where(eq(refunds.nonce, nonce))).map(toRefund);
  }

  async stalledRefunds(updatedBefore: Date, limit: number): Promise<Order[]> {
    const rows = await this.db
      .select({ order: orders })
      .from(orders)
      .innerJoin(refunds, eq(refunds.orderId, orders.id))
      .where(and(eq(orders.status, 'refunding'), lt(refunds.updatedAt, updatedBefore)))
      .orderBy(asc(orders.createdAt))
      .limit(limit);
    return rows.map((row) => row.order);
  }

  async unsignedRefunds(paidBefore: Date, limit: number): Promise<Order[]> {
    const rows = await this.db
      .select({ order: orders })
      .from(orders)
      .leftJoin(refunds, eq(refunds.orderId, orders.id))
      .where(
        and(
          eq(orders.status, 'refunding'),
          isNull(refunds.orderId),
          or(lt(orders.paidAt, paidBefore), and(isNull(orders.paidAt), lt(orders.createdAt, paidBefore))),
        ),
      )
      .orderBy(asc(orders.createdAt))
      .limit(limit);
    return rows.map((row) => row.order);
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

  ordersAwaitingSettlement(olderThan: Date, limit: number): Promise<Order[]> {
    return this.db
      .select()
      .from(orders)
      .where(and(eq(orders.status, 'awaiting_settlement'), lt(orders.createdAt, olderThan)))
      .orderBy(asc(orders.createdAt))
      .limit(limit);
  }

  // A paid order is stamped with its payment time, so it is the one to measure from.
  paidWithoutRun(olderThan: Date, limit: number): Promise<Order[]> {
    return this.db
      .select()
      .from(orders)
      .where(and(eq(orders.status, 'paid'), isNull(orders.runId), lt(orders.paidAt, olderThan)))
      .orderBy(asc(orders.paidAt))
      .limit(limit);
  }

  runsOverdue(paidBefore: Date, limit: number, after?: OrderCursor): Promise<Order[]> {
    const next = after === undefined ? undefined : or(gt(orders.paidAt, after.paidAt), and(eq(orders.paidAt, after.paidAt), gt(orders.id, after.id)));
    return this.db
      .select()
      .from(orders)
      .where(and(or(and(eq(orders.status, 'paid'), isNotNull(orders.runId)), eq(orders.status, 'running')), lt(orders.paidAt, paidBefore), next))
      .orderBy(asc(orders.paidAt), asc(orders.id))
      .limit(limit);
  }

  ordersToExpire(createdBefore: Date): Promise<Order[]> {
    return this.db
      .select()
      .from(orders)
      .where(and(inArray(orders.status, ['delivered', 'refunded', 'unpaid']), lt(orders.createdAt, createdBefore)))
      .orderBy(asc(orders.createdAt));
  }

  refundFailures(limit: number): Promise<Order[]> {
    return this.db.select().from(orders).where(eq(orders.status, 'refund_failed')).orderBy(asc(orders.createdAt)).limit(limit);
  }
}
