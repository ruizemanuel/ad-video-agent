// What the service needs from the outside, and nothing else. Each port has a real adapter and a double, so the
// flow and the routes run the same code in production and in the tests. This file holds the OrderStore (orders,
// VM tasks, payment intents, costs, refunds and pre-checks), the BlobPort (the private files), the LlmPort (the
// models, as far as the tasks so far use them) and the BuyPort (what the chain says about a payment, so far); the
// other ports arrive with the tasks that use them.
import type { OrderRequestSchema, VmTaskKind } from '@app/core';
import type { z } from 'zod';

export type OrderRequest = z.infer<typeof OrderRequestSchema>;

export const ORDER_STATUSES = [
  'awaiting_settlement',
  'paid',
  'running',
  'delivered',
  'unpaid',
  'refunding',
  'refunded',
  'refund_failed',
  'expired',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

// The state machine: where an order may go from each status. Both stores enforce it in `transition`.
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  awaiting_settlement: ['paid', 'unpaid'],
  paid: ['running', 'refunding'],
  running: ['delivered', 'refunding'],
  refunding: ['refunded', 'refund_failed'],
  // A refund that could not be paid is retried by hand.
  refund_failed: ['refunding'],
  // 30 days after the order was made.
  delivered: ['expired'],
  refunded: ['expired'],
  unpaid: ['expired'],
  expired: [],
};

/** How long an order is kept, from when it was made: then it expires and its files are deleted. */
export const ORDER_DAYS = 30;

export const canTransition = (from: OrderStatus, to: OrderStatus): boolean => ORDER_TRANSITIONS[from].includes(to);

/** The statuses an order may leave to go to `to`. */
export const statusesBefore = (to: OrderStatus): OrderStatus[] => ORDER_STATUSES.filter((from) => canTransition(from, to));

// The steps the status shows, in the order they happen. `refund` appears only when there is one.
export const STEP_NAMES = ['payment', 'vm', 'capture', 'script', 'music', 'preview', 'review', 'render', 'delivery', 'refund'] as const;
export type StepName = (typeof STEP_NAMES)[number];
export type StepState = 'running' | 'done' | 'failed' | 'skipped';
/** A step that is not there has not started. */
export type Steps = Partial<Record<StepName, StepState>>;

/** A file the client can download: `name` is what the link says, `path` where the blob store keeps it. */
export type Deliverable = { name: string; path: string; bytes: number };

export type Order = {
  /** `ord_` and 24 random base32 characters. */
  id: string;
  status: OrderStatus;
  request: OrderRequest;
  // The payment: an EIP-3009 authorization. Amounts and times are uint256, so bigint; `amount` is in atomic units
  // of the token (6 decimals), and `validAfter` and `validBefore` are unix seconds.
  network: string;
  asset: string;
  payer: string;
  amount: bigint;
  nonce: string;
  validAfter: bigint;
  validBefore: bigint;
  settleTx: string | null;
  // The flow and what it delivers.
  runId: string | null;
  steps: Steps;
  deliverables: Deliverable[];
  warnings: string[];
  failureReason: string | null;
  // The VM's permit: only its hash is kept.
  vmTokenHash: string | null;
  vmTokenExpiresAt: Date | null;
  createdAt: Date;
  paidAt: Date | null;
  deliveredAt: Date | null;
};

/** What the paying request says. An order always starts `awaiting_settlement`. */
export type NewOrder = Pick<Order, 'request' | 'network' | 'asset' | 'payer' | 'amount' | 'nonce' | 'validAfter' | 'validBefore'>;

export type VmTaskStatus = 'pending' | 'claimed' | 'done' | 'failed';

export type VmTask = {
  id: string;
  orderId: string;
  kind: VmTaskKind;
  round: number;
  input: unknown;
  /** `vmtask:${orderId}:${kind}:${round}`: the hook the flow waits on, and what makes a task unique. */
  hookToken: string;
  status: VmTaskStatus;
  result: unknown;
  createdAt: Date;
  claimedAt: Date | null;
  finishedAt: Date | null;
};

export type NewVmTask = Pick<VmTask, 'orderId' | 'kind' | 'round' | 'input' | 'hookToken'>;

/** What the payer signed (EIP-3009), as buy reports it. Times are decimal strings: this goes to JSON. */
export type PaymentAuthorization = { from: string; nonce: string; validAfter: string; validBefore: string };

export type PaymentStatus = 'intent' | 'paid' | 'uncertain' | 'rejected' | 'settled' | 'unsettled';

/** A payment the service makes with buy. It is written before paying, so a retry finds it and never pays twice. */
export type PaymentRecord = {
  /** `${orderId}:vm`. */
  key: string;
  orderId: string;
  kind: 'vm';
  /** The most the service agreed to pay, in atomic units. */
  maxAtomic: bigint;
  status: PaymentStatus;
  asset: string | null;
  /** What was really paid. */
  amount: bigint | null;
  txHash: string | null;
  authorization: PaymentAuthorization | null;
  /** The VM's tracking URL. It cannot be recovered, so it is kept as soon as it arrives. */
  pollUrl: string | null;
  outcome: string | null;
  reason: string | null;
};

export type NewPaymentIntent = Pick<PaymentRecord, 'key' | 'orderId' | 'kind' | 'maxAtomic'>;
export type PaymentPatch = Partial<Omit<PaymentRecord, 'key' | 'orderId' | 'kind' | 'maxAtomic'>>;

export type RefundStatus = 'prepared' | 'broadcast' | 'confirmed' | 'reverted' | 'failed';

/** The refund of an order: one at most. The transaction is signed and kept before it is broadcast. */
export type RefundRecord = {
  orderId: string;
  to: string;
  asset: string;
  /** In atomic units of `asset` (6 decimals). */
  amount: bigint;
  status: RefundStatus;
  reason: string;
  rawTx: string | null;
  txHash: string | null;
};

export type RefundPatch = Partial<Omit<RefundRecord, 'orderId'>>;

export type PrecheckResult =
  | { ok: true; thin: boolean | null; demoLinks: string[] }
  | { ok: false; code: 'invalid_url' | 'unreachable' | 'blocked' | 'login_wall' | 'inadmissible'; reason: string };

/** `buy` is money out of the buy wallet; `card` is what models and music cost. */
export type CostKind = 'buy' | 'card';

export interface OrderStore {
  /** One order per (asset, payer, nonce), whatever the case of the hex: the same payment gives the same order. */
  createOrder(o: NewOrder): Promise<{ order: Order; created: boolean }>;
  getOrder(id: string): Promise<Order | null>;
  findOrderByPayment(asset: string, payer: string, nonce: string): Promise<Order | null>;
  /** Moves the order if ORDER_TRANSITIONS allows it from where it is (and only then applies the patch). False otherwise. */
  transition(id: string, to: OrderStatus, patch?: Partial<Order>): Promise<boolean>;
  setStep(id: string, name: StepName, state: StepState): Promise<void>;
  addWarning(id: string, text: string): Promise<void>;
  setDeliverables(id: string, list: Deliverable[]): Promise<void>;
  /** Not in the plan's list: a paid order has to remember its run before the flow moves it to `running`. */
  setRunId(id: string, runId: string): Promise<void>;

  /** `usd` is kept to the millionth of a dollar. An order id of 'precheck' is for what the free pre-check costs. */
  addCost(orderId: string, item: string, usd: number, kind: CostKind): Promise<void>;
  orderCost(orderId: string): Promise<number>;
  buySpendSince(t: Date): Promise<number>;

  /** False if the key already has an intent. */
  insertPaymentIntent(r: NewPaymentIntent): Promise<boolean>;
  updatePayment(key: string, patch: PaymentPatch): Promise<void>;
  getPayment(key: string): Promise<PaymentRecord | null>;

  setVmToken(orderId: string, hash: string, expiresAt: Date): Promise<void>;
  orderByVmTokenHash(hash: string): Promise<Order | null>;

  /** One task per hook token: queueing the same one again returns the first. */
  enqueueTask(t: NewVmTask): Promise<VmTask>;
  /** Hands the oldest pending task of the order to whoever asks first, and marks it claimed. */
  claimNextTask(orderId: string): Promise<VmTask | null>;
  /** Null if the task is not `claimed`: only the first result counts. */
  finishTask(taskId: string, ok: boolean, result: unknown): Promise<VmTask | null>;
  getTask(taskId: string): Promise<VmTask | null>;

  /** False if the order already has a refund. */
  insertRefund(r: RefundRecord): Promise<boolean>;
  updateRefund(orderId: string, patch: RefundPatch): Promise<void>;
  getRefund(orderId: string): Promise<RefundRecord | null>;
  /** USD refunded since `t`, not counting refunds that failed. */
  refundsSince(t: Date): Promise<number>;

  getPrecheck(key: string, maxAgeMs: number): Promise<PrecheckResult | null>;
  putPrecheck(key: string, r: PrecheckResult): Promise<void>;

  ordersAwaitingSettlement(olderThan: Date): Promise<Order[]>;
  paidWithoutRun(olderThan: Date): Promise<Order[]>;
  ordersToExpire(createdBefore: Date): Promise<Order[]>;
  refundFailures(): Promise<Order[]>;
}

/**
 * The private file store. A path is the blob's name in the store (`orders/<id>/out/<name>`), with no leading slash.
 * The presigned URLs stand in for a secret: whoever holds one can do what it allows, until it expires.
 */
export interface BlobPort {
  /** Writes the blob, replacing what is at that path. `bytes` is the size of what was stored. */
  put(path: string, body: Uint8Array | string, contentType: string): Promise<{ bytes: number }>;
  /** Fails if there is no blob at that path. */
  get(path: string): Promise<Uint8Array>;
  /** A URL that writes that path once (it will not overwrite), with that content type and no more than `maxBytes`. */
  presignPut(path: string, contentType: string, maxBytes: number, minutes: number): Promise<string>;
  /** A URL that reads that path. */
  presignGet(path: string, minutes: number): Promise<string>;
  /** Deletes every blob whose path starts with `prefix`, and says how many. An empty prefix is refused. */
  deletePrefix(prefix: string): Promise<number>;
}

/** What the chain says about the payment an authorization was signed for. See `BuyPort.authorizationSettled`. */
export type AuthorizationSettlement = 'settled' | 'unsettled' | 'unknown';

/** Buy, as far as the tasks so far use it: renting the VM and following it arrive with the task that pays for it. */
export interface BuyPort {
  /**
   * Whether the payment an order was made for reached the service. It is not enough that the authorization's nonce was
   * spent: a nonce belongs to the payer and says nothing of who is paid or how much, so the payer can spend it on a
   * transfer to themselves, and the service's settlement then fails. `asset` is the token's address, `to` the address
   * that has to be paid (compared whatever the case of the hex) and `value` the least it has to receive, in atomic units.
   * - `settled`: the transaction that spent the nonce moved at least `value` of `asset` from `authorization.from` to `to`.
   * - `unsettled`: that payment did not happen. The nonce is not spent yet (it may still be, until `validBefore`) or it
   *   was spent by any other transfer (this authorization can then never settle).
   * - `unknown`: the chain could not be read, or its answer is not final.
   */
  authorizationSettled(input: {
    asset: string;
    authorization: PaymentAuthorization;
    to: string;
    value: bigint;
  }): Promise<AuthorizationSettlement>;
}

/** What the model says about a site: `usd` is what the call cost. */
export type SiteClassification = { admissible: boolean; reason: string; usd: number };

/** The language models. It holds what the pre-check needs; the script and the review add their calls with their tasks. */
export interface LlmPort {
  /**
   * Whether a site may be made into an ad: it is not a scam and has no illegal or adult content. `text` is the start of
   * what the page says. `reason` is written for the person who asked, so it does not name models or protocols.
   */
  classifySite(input: { url: string; title: string; text: string }): Promise<SiteClassification>;
}
