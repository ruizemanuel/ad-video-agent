import { sql, type SQL } from 'drizzle-orm';
import { boolean, customType, index, integer, jsonb, numeric, pgTable, serial, text, timestamp, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import type { VmTaskKind } from '@app/core';
import {
  VIDEO_STATUSES,
  type CostKind,
  type Deliverable,
  type DeliverySummary,
  type FeedbackAnswer,
  type OrderRequest,
  type OrderStatus,
  type PaymentAuthorization,
  type PaymentStatus,
  type PrecheckResult,
  type RefundStatus,
  type Steps,
  type VmTaskStatus,
} from '../ports';

/** Token amounts in atomic units: numeric(78, 0) holds any uint256, and comes back as bigint. */
const units = customType<{ data: bigint; driverData: string }>({
  dataType: () => 'numeric(78, 0)',
  toDriver: (value) => value.toString(),
  fromDriver: (value) => BigInt(value),
});

const at = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => at('created_at').notNull().defaultNow();

// Written into the SQL as it is (an index's predicate takes no parameters): the statuses are this code's own constants.
const videoStatuses = sql.raw(VIDEO_STATUSES.map((status) => `'${status}'`).join(', '));

/**
 * An order that has its video or is on its way to it (VIDEO_STATUSES, or expired once delivered), as a condition on
 * these columns of `orders`: what makes a wallet's first video.
 */
export const holdsVideo = (t: { status: AnyPgColumn; deliveredAt: AnyPgColumn }): SQL =>
  sql`(${t.status} in (${videoStatuses}) or (${t.status} = 'expired' and ${t.deliveredAt} is not null))`;

/**
 * An order that holds a first-video promo slot: one at the promo price that holds its video. The two promo indexes and
 * the store's queries all use this one condition.
 */
export const holdsPromoSlot = (t: { status: AnyPgColumn; deliveredAt: AnyPgColumn; promoSlot: AnyPgColumn }): SQL =>
  sql`(${t.promoSlot} is not null and ${holdsVideo(t)})`;

export const orders = pgTable(
  'orders',
  {
    id: text('id').primaryKey(),
    status: text('status').$type<OrderStatus>().notNull().default('awaiting_settlement'),
    request: jsonb('request').$type<OrderRequest>().notNull(),
    network: text('network').notNull(),
    asset: text('asset').notNull(),
    payer: text('payer').notNull(),
    amount: units('amount').notNull(),
    nonce: text('nonce').notNull(),
    validAfter: units('valid_after').notNull(),
    validBefore: units('valid_before').notNull(),
    settleTx: text('settle_tx'),
    runId: text('run_id'),
    steps: jsonb('steps').$type<Steps>().notNull().default({}),
    deliverables: jsonb('deliverables').$type<Deliverable[]>().notNull().default([]),
    summary: jsonb('summary').$type<DeliverySummary>(),
    warnings: jsonb('warnings').$type<string[]>().notNull().default([]),
    failureReason: text('failure_reason'),
    /** The VM's permit: only its sha256 is kept. */
    vmTokenHash: text('vm_token_hash'),
    vmTokenExpiresAt: at('vm_token_expires_at'),
    /** The first-video promo slot of an order at the promo price; null at the full price. */
    promoSlot: integer('promo_slot'),
    createdAt: createdAt(),
    paidAt: at('paid_at'),
    deliveredAt: at('delivered_at'),
  },
  (t) => [
    // One order per payment. Addresses and nonces are hex: 0xAB and 0xab are the same payment.
    uniqueIndex('orders_payment_idx').on(sql`lower(${t.asset})`, sql`lower(${t.payer})`, sql`lower(${t.nonce})`),
    index('orders_vm_token_hash_idx').on(t.vmTokenHash),
    // What the cron lists: by status, oldest first.
    index('orders_status_created_idx').on(t.status, t.createdAt),
    // The first-video promo, among the orders that hold a slot: each slot held once, and one slot per wallet. An order
    // that will never have its video leaves both, and its slot is free again.
    uniqueIndex('orders_promo_slot_idx').on(t.promoSlot).where(holdsPromoSlot(t)),
    uniqueIndex('orders_promo_payer_idx').on(sql`lower(${t.payer})`).where(holdsPromoSlot(t)),
  ],
);

/** The answer to "did you post it?": one per order, replaced when it is given again. */
export const feedback = pgTable('feedback', {
  orderId: text('order_id')
    .primaryKey()
    .references(() => orders.id),
  answer: text('answer').$type<FeedbackAnswer>().notNull(),
  postUrl: text('post_url'),
  /** Whether the post may be shown: false whenever there is no post_url (the store sees to it). */
  mayShow: boolean('may_show').notNull().default(false),
  updatedAt: at('updated_at').notNull().defaultNow(),
});

export const vmTasks = pgTable(
  'vm_tasks',
  {
    /** A UUID, as text: a malformed id in a URL simply finds nothing. */
    id: text('id').primaryKey(),
    /** The order in which tasks were queued: the oldest pending one goes first. */
    seq: serial('seq').notNull(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    kind: text('kind').$type<VmTaskKind>().notNull(),
    round: integer('round').notNull(),
    input: jsonb('input').$type<unknown>().notNull(),
    hookToken: text('hook_token').notNull(),
    status: text('status').$type<VmTaskStatus>().notNull().default('pending'),
    result: jsonb('result').$type<unknown>(),
    createdAt: createdAt(),
    claimedAt: at('claimed_at'),
    finishedAt: at('finished_at'),
  },
  (t) => [uniqueIndex('vm_tasks_hook_token_idx').on(t.hookToken), index('vm_tasks_claim_idx').on(t.orderId, t.status, t.seq)],
);

export const payments = pgTable('payments', {
  key: text('key').primaryKey(),
  orderId: text('order_id')
    .notNull()
    .references(() => orders.id),
  kind: text('kind').$type<'vm'>().notNull(),
  maxAtomic: units('max_atomic').notNull(),
  status: text('status').$type<PaymentStatus>().notNull().default('intent'),
  asset: text('asset'),
  amount: units('amount'),
  payTo: text('pay_to'),
  txHash: text('tx_hash'),
  authorization: jsonb('authorization').$type<PaymentAuthorization>(),
  pollUrl: text('poll_url'),
  outcome: text('outcome'),
  reason: text('reason'),
  createdAt: createdAt(),
  updatedAt: at('updated_at').notNull().defaultNow(),
});

/** What each order cost, in dollars to the millionth. Some costs belong to no order ('precheck'), so no foreign key. */
export const costs = pgTable(
  'costs',
  {
    id: serial('id').primaryKey(),
    orderId: text('order_id').notNull(),
    item: text('item').notNull(),
    usd: numeric('usd', { precision: 14, scale: 6 }).notNull(),
    kind: text('kind').$type<CostKind>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('costs_order_idx').on(t.orderId), index('costs_kind_created_idx').on(t.kind, t.createdAt)],
);

export const refunds = pgTable(
  'refunds',
  {
    orderId: text('order_id')
      .primaryKey()
      .references(() => orders.id),
    /** "to" is a keyword in SQL. */
    toAddress: text('to_address').notNull(),
    asset: text('asset').notNull(),
    amount: units('amount').notNull(),
    status: text('status').$type<RefundStatus>().notNull(),
    reason: text('reason').notNull(),
    rawTx: text('raw_tx'),
    txHash: text('tx_hash'),
    /** The refunds' wallet nonce the transaction was signed with, and the wallet's address: its key may change. */
    nonce: integer('nonce'),
    signer: text('signer'),
    /** The hash of the refund this one replaced, given up on as dead. */
    replacedTxHash: text('replaced_tx_hash'),
    createdAt: createdAt(),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // Which refunds were signed with a nonce: how one that can never land is told apart.
    index('refunds_nonce_idx').on(t.nonce),
    // What the cron lists: the refunds that stopped moving.
    index('refunds_updated_idx').on(t.updatedAt),
  ],
);

export const prechecks = pgTable('prechecks', {
  key: text('key').primaryKey(),
  result: jsonb('result').$type<PrecheckResult>().notNull(),
  createdAt: createdAt(),
});
