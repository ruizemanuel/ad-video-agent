// What the service needs from the outside, and nothing else. Each port has a real adapter and a double, so the
// flow and the routes run the same code in production and in the tests. This file holds the OrderStore (orders,
// VM tasks, payment intents, costs, refunds and pre-checks), the BlobPort (the private files), the LlmPort (the
// models, as far as the tasks so far use them), the BuyPort (renting the VM, following it, and what the chain says
// about a payment), the MusicPort (Lyria) and the RefundPort (the refunds' wallet on Celo).
import type {
  CaptureFile,
  Claim,
  Edl,
  FramingItem,
  JudgeItem,
  OrderRequestSchema,
  Problem,
  ScenePatch,
  SiteData,
  VmTaskKind,
} from '@app/core';
import type { Hex } from 'viem';
import { FatalError } from 'workflow';
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
  /** What the signed authorization pays (buy's quote), in atomic units of `asset`. Written before it goes out. */
  amount: bigint | null;
  /** Who the authorization pays: the wallet in buy's quote. With `amount`, what the chain is asked about later. */
  payTo: string | null;
  txHash: string | null;
  authorization: PaymentAuthorization | null;
  /** The VM's tracking URL. It cannot be recovered, so it is kept as soon as it arrives. */
  pollUrl: string | null;
  outcome: string | null;
  reason: string | null;
};

export type NewPaymentIntent = Pick<PaymentRecord, 'key' | 'orderId' | 'kind' | 'maxAtomic'>;
export type PaymentPatch = Partial<Omit<PaymentRecord, 'key' | 'orderId' | 'kind' | 'maxAtomic'>>;

/**
 * - `prepared`: signed and kept, and never handed to the node.
 * - `broadcast`: handed to the node (marked just before), which may or may not have taken it: its hash tells.
 * - `confirmed`, `reverted`: mined, and what came of it.
 * - `failed`: given up on, proven never to be mined (another of our refunds with its nonce was), so it moved no money
 *   and does not count toward the daily cap. Only a failed refund is replaced by a fresh one.
 */
export type RefundStatus = 'prepared' | 'broadcast' | 'confirmed' | 'reverted' | 'failed';

/**
 * The refund of an order: one at most that has not failed. The transaction is signed and kept before it is broadcast.
 */
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
  /** The refunds' wallet nonce the transaction was signed with. */
  nonce: number | null;
  /** The address of the wallet that signed it: REFUND_WALLET_PRIVATE_KEY may change, and a nonce is only that key's. */
  signer: string | null;
  /** The hash of the refund this one replaced, given up on as dead (the store fills it in). */
  replacedTxHash: string | null;
};

/** A refund as it is written: what it replaced, if anything, is the store's to say. */
export type NewRefund = Omit<RefundRecord, 'replacedTxHash'>;

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

  /**
   * Keeps the hash of the order's VM permit, once: an order whose permit is set keeps it (the VM it paid for boots with
   * that one). True when this call wrote it; false when the order already had one, or does not exist.
   */
  setVmToken(orderId: string, hash: string, expiresAt: Date): Promise<boolean>;
  orderByVmTokenHash(hash: string): Promise<Order | null>;

  /** One task per hook token: queueing the same one again returns the first. */
  enqueueTask(t: NewVmTask): Promise<VmTask>;
  /** Hands the oldest pending task of the order to whoever asks first, and marks it claimed. */
  claimNextTask(orderId: string): Promise<VmTask | null>;
  /** Null if the task is not `claimed`: only the first result counts. */
  finishTask(taskId: string, ok: boolean, result: unknown): Promise<VmTask | null>;
  getTask(taskId: string): Promise<VmTask | null>;

  /**
   * False if the order already has a refund that has not failed. A failed one (it can never move money) is replaced by
   * this one, which counts toward the daily cap from now and keeps the replaced one's hash: an order has at most one
   * refund that has not failed.
   */
  insertRefund(r: NewRefund): Promise<boolean>;
  /**
   * Changes the order's refund only while it is the one with this hash (and, when `from` is given, in one of those
   * statuses): a refund replaced, or moved on, since the writer read it is never written over. False when nothing matched.
   */
  updateRefund(orderId: string, txHash: string, patch: RefundPatch, from?: readonly RefundStatus[]): Promise<boolean>;
  getRefund(orderId: string): Promise<RefundRecord | null>;
  /** USD refunded since `t`, not counting refunds that failed. */
  refundsSince(t: Date): Promise<number>;
  /** The kept refunds signed with this nonce of the refunds' wallet, whatever their order. */
  refundsByNonce(nonce: number): Promise<RefundRecord[]>;

  getPrecheck(key: string, maxAgeMs: number): Promise<PrecheckResult | null>;
  putPrecheck(key: string, r: PrecheckResult): Promise<void>;

  // What the cron looks for. Each list is the oldest first, and `limit` long at most: a pass never takes more than its share.

  /** The orders still `refunding` whose refund was last written before `updatedBefore`. */
  stalledRefunds(updatedBefore: Date, limit: number): Promise<Order[]>;
  /** The orders still `refunding` with no refund signed, paid (or, unpaid, made) before `paidBefore`. */
  unsignedRefunds(paidBefore: Date, limit: number): Promise<Order[]>;
  /** The orders `awaiting_settlement` made before `olderThan`. */
  ordersAwaitingSettlement(olderThan: Date, limit: number): Promise<Order[]>;
  /** The orders `paid` with no run, paid before `olderThan`. */
  paidWithoutRun(olderThan: Date, limit: number): Promise<Order[]>;
  /** The orders whose run should be over: `paid` with a run, or `running`, paid before `paidBefore`, by their payment. */
  runsOverdue(paidBefore: Date, limit: number): Promise<Order[]>;
  /** The orders `refund_failed`. */
  refundFailures(limit: number): Promise<Order[]>;
  /** The cleanup's: the orders `delivered`, `refunded` or `unpaid` made before `createdBefore`, oldest first. */
  ordersToExpire(createdBefore: Date): Promise<Order[]>;
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
export type AuthorizationSettlement = 'settled' | 'unsettled' | 'pending' | 'unknown';

/**
 * What a lookup of a payment concludes for now: `settled` and `unsettled` are final, and an authorization that may still
 * settle (`pending`) is `unknown` until it no longer can.
 */
export type SettlementVerdict = Exclude<AuthorizationSettlement, 'pending'>;

/**
 * How long past its validBefore, by this server's clock, an authorization is still taken as able to settle. The token
 * compares validBefore with the chain's time, and the server's clock may run ahead of it: an `unsettled` answer (which
 * the chain gives only once it is past validBefore, or the nonce went elsewhere) is acted on only after this too.
 */
export const SETTLEMENT_GRACE_SECONDS = 60n;

/** What the service sends buy for a VM. The script is the VM's whole start-up: buy runs it as root. */
export type VmRequest = { script: string; machineType: string };

/** A payment for a VM as signed, in the moment before it goes out: the quote it pays and the authorization. */
export type SignedVmPayment = {
  /** The token's address. */
  asset: string;
  /** In atomic units of `asset`: exactly what the authorization lets buy take. */
  amount: bigint;
  /** The wallet the authorization pays. */
  payTo: string;
  authorization: PaymentAuthorization;
};

/**
 * What became of a paid request to buy. `confirmed` is a 2xx: the VM was served. `rejected` (a 4xx, or a payment buy did
 * not take) and `ambiguous` (a 5xx, or no answer at all) may still have settled: they are resolved on the chain, never
 * paid again.
 */
export type VmPaymentOutcome = 'confirmed' | 'rejected' | 'ambiguous';

export type VmPaymentInfo = {
  asset: string;
  amount: bigint;
  /** The wallet the authorization pays, when the adapter knows it. */
  payTo?: string;
  txHash?: string;
  authorization: PaymentAuthorization;
  /** The VM's tracking URL, on buy's own origin. */
  poll?: string;
  outcome: VmPaymentOutcome;
  /** ISO-8601: when the answer came (or did not). */
  timestamp: string;
};

export type RentVmInput = {
  body: VmRequest;
  /** The most the service pays, in atomic units: a dearer quote is refused before anything is signed. */
  maxAtomic: bigint;
  /** Runs once the payment is signed, right before it goes out. If it throws, nothing is sent. */
  beforePayment(payment: SignedVmPayment): Promise<void>;
  /** Runs once after a payment went out, whatever came of it. If it throws, `rentVm` throws. */
  onPayment(info: VmPaymentInfo): Promise<void>;
};

/** `not_paid`: nothing went out (the quote was refused, `beforePayment` threw, buy never asked to be paid). */
export type RentVmResult = { outcome: VmPaymentOutcome | 'not_paid'; reason?: string };

/** What buy says about a rented VM; `gone` when buy no longer knows it. */
export type VmPoll = { gone: true } | { gone: false; vmStatus: string | null; scriptStatus: string | null; expiresAt: string | null };

/** Buy, the x402 marketplace on Celo: the VM it rents, and what the chain says about a payment. */
export interface BuyPort {
  /**
   * Rents a VM from buy and pays for it at most once: a paid request is never sent again, whatever its answer. It throws
   * only when a hook does; otherwise every way it ends is in the result and in the hooks.
   */
  rentVm(input: RentVmInput): Promise<RentVmResult>;

  /** A free look at a rented VM, by the tracking URL buy gave when it was paid. */
  pollVm(url: string): Promise<VmPoll>;

  /**
   * Whether the payment an authorization was signed for reached who it pays: the service, for an order; buy, for a VM.
   * It is not enough that the authorization's nonce was spent: a nonce belongs to the payer and says nothing of who is
   * paid or how much, so the payer can spend it on a transfer to themselves (or cancel it), and the settlement then
   * fails. `asset` is the token's address, `to` the address
   * that has to be paid (compared whatever the case of the hex) and `value` the least it has to receive, in atomic units.
   * - `settled`: the transaction that spent the nonce moved at least `value` of `asset` from `authorization.from` to `to`.
   * - `pending`: that payment has not happened yet, and still can: the nonce is not spent and the chain's time is not
   *   past `validBefore`.
   * - `unsettled`: that payment did not happen and never will, by the chain's own evidence: the nonce is unspent and the
   *   chain's time is past `validBefore`, or the nonce was spent by any other transfer, or cancelled.
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

/** A picture of one shot of the site, small and in JPEG, for the director to look at. */
export type DirectorImage = CaptureFile['directorImages'][number];

/** The judge on a claim item (`id` is the item's: `${scenePath}:${claimId}`): the line says no more than its quote. */
export type ClaimVerdict = { id: string; equivalent: boolean; reason: string };
/** The judge on a framing item (`id` is `${scenePath}:framing:${k}`): whether the line asserts a fact about the product. */
export type FramingVerdict = { id: string; assertsProductFact: boolean; reason: string };

/** A key frame as the visual review is shown it: the label that starts with its number, and its picture as a base64 JPEG. */
export type ReviewFrame = { label: string; jpeg: string };

/**
 * What the vision model says of the key frames. `frame` is the number in a frame's label (the first is 1). `legible`
 * is false when a phone could not read the frame's text, and `cutMidLetter` is true when an edge or a mask cuts a
 * letter: these two, and `logoSwap.generic` (the ad would do as well for any other brand), are what the gate blocks on.
 * `issues` are the rest of what it saw.
 */
export type VisualReview = {
  frames: { frame: number; legible: boolean; cutMidLetter: boolean; issues: string[] }[];
  logoSwap: { generic: boolean; reason: string };
};

/**
 * The language models. Every call says what it cost in `usd`, which the caller records on the order.
 */
export interface LlmPort {
  /**
   * Whether a site may be made into an ad: it is not a scam and has no illegal or adult content. `text` is the start of
   * what the page says. `reason` is written for the person who asked, so it does not name models or protocols.
   */
  classifySite(input: { url: string; title: string; text: string }): Promise<SiteClassification>;

  /** The director: the edit list of the video, from the site, its pictures and the client's one-line brief. */
  writeEdl(input: { site: SiteData; images: DirectorImage[]; brief?: string }): Promise<{ edl: Edl; usd: number }>;

  /**
   * The corrector: the scenes it rewrote (each whole, at its path) and the claims it added or corrected, for these
   * problems of the edit list. It reads the site's text (to quote it) but no pictures.
   */
  patchEdl(input: { edl: Edl; problems: Problem[]; site: SiteData }): Promise<{ patches: ScenePatch[]; claimFixes: Claim[]; usd: number }>;

  /** The judge, on the items judgeItems builds: a verdict per item, which may leave some out. */
  judge(input: { claims: JudgeItem[]; framing: FramingItem[] }): Promise<{ verdicts: ClaimVerdict[]; framing: FramingVerdict[]; usd: number }>;

  /**
   * The visual review: a model with vision looks at the key frames of the main video, in playing order, and says for each
   * whether it can be read and whether a letter is cut, and whether the whole ad would do for any other brand. `siteUrl`
   * is the site the ad is made from.
   */
  review(input: { frames: ReviewFrame[]; siteUrl: string }): Promise<{ review: VisualReview; usd: number }>;
}

/**
 * The music model. It writes one track per call and bills it whole: the caller records `usd` on the order, and measures
 * the track, since Lyria does not keep the tempo or the length the prompt asks for.
 */
export interface MusicPort {
  /**
   * One track for the prompt, as a WAV file. When Lyria answered but not with a WAV it throws `MusicOutputInvalid`: the
   * call was billed, and it is not retried. Any other failure is the provider's, and the call was not billed.
   */
  generate(prompt: string): Promise<{ wav: Uint8Array; model: 'lyria-3.5'; usd: number }>;
}

/** A refund as the RefundPort is asked for it: `amount` (atomic units) of the token at `asset`, to `to`. */
export type RefundRequest = { to: string; asset: string; amount: bigint };

/**
 * A refund signed and not sent: its bytes, the hash they will have on the chain (their keccak256), their nonce, and the
 * address of the wallet that signed them.
 */
export type PreparedRefund = { hash: Hex; rawTx: Hex; nonce: number; from: string };

/** What the chain says of a refund's transaction: mined and done, mined and reverted, or not mined (yet, or ever). */
export type RefundReceipt = 'success' | 'reverted' | 'pending';

/**
 * The refunds' wallet: a small balance that signs with no person in the loop. A refund is the transfer of the paid
 * token back to the payer, with its gas paid in that same token. It is signed first and sent after, so its hash can be
 * kept before anything leaves.
 */
export interface RefundPort {
  /** The address of the refunds' wallet now: what it signs with from here on. */
  readonly wallet: string;
  /**
   * Signs the transfer and sends nothing. Before signing, it throws FeeTooHigh when the most its gas could cost is over
   * what a refund may spend on it, and InsufficientBalance when the wallet holds less of the token than the amount and
   * that gas. Anything it throws was not sent.
   */
  prepare(input: RefundRequest): Promise<PreparedRefund>;
  /**
   * Hands the signed bytes to the node once, and never again on its own. A node that already has them, or whose wallet
   * nonce is already past theirs ("already known", "nonce too low"), is no error: the hash comes back, and `receipt` says
   * the rest (with `nonceUsed` and `minedSafely`, for one that may never land). A throw does not say the node did not take
   * them either: the hash does.
   */
  broadcast(rawTx: Hex): Promise<Hex>;
  /** What the chain says of the transaction with this hash. It only reads. */
  receipt(hash: Hex): Promise<RefundReceipt>;
  /**
   * Whether the refunds' wallet had used this nonce some blocks back. A quick filter, never evidence on its own: it does
   * not say which transaction used it. It only reads.
   */
  nonceUsed(nonce: number): Promise<boolean>;
  /**
   * Whether the transaction with this hash, sent by the refunds' wallet, is mined (whatever came of it) in a block at or
   * below the safe head, which will not be undone, and that block is the one at that height. Positive evidence only: no
   * receipt, a newer block, or a block since replaced, is false. It only reads.
   */
  minedSafely(hash: Hex): Promise<boolean>;
}

/** The refunds' wallet holds less of the token than a refund needs (`needed`: the amount, and its gas when known). */
export class InsufficientBalance extends Error {
  constructor(
    readonly asset: string,
    readonly balance: bigint,
    readonly needed: bigint,
  ) {
    super(`The refunds' wallet holds ${balance} atomic units of the token at ${asset}, and the refund needs ${needed}.`);
    this.name = 'InsufficientBalance';
  }
}

/** The most a refund's gas could cost (`fee`, in the token's atomic units) is over what a refund may spend on it (`cap`). */
export class FeeTooHigh extends Error {
  constructor(
    readonly asset: string,
    readonly fee: bigint,
    readonly cap: bigint,
  ) {
    super(`The refund's gas could cost ${fee} atomic units of the token at ${asset}, over the ${cap} a refund may spend on it.`);
    this.name = 'FeeTooHigh';
  }
}

/**
 * Lyria answered, but not with a WAV file (it sent nothing, or another format). The call was still billed: `usd` is what
 * it cost, and the caller records it. It is a `FatalError`, so a workflow step does not run it again: the same call would
 * be billed again for the same kind of answer. (It keeps the name `FatalError`, which is what the runtime looks for.)
 */
export class MusicOutputInvalid extends FatalError {
  constructor(
    message: string,
    readonly usd: number,
  ) {
    super(message);
  }
}

/**
 * A model answered, but not with what it was asked for (its answer did not fit the schema). The call was still billed:
 * `usd` is what it cost. The message never quotes the answer, which can hold the site's text.
 */
export class ModelOutputInvalid extends Error {
  constructor(
    message: string,
    readonly usd: number,
  ) {
    super(message);
    this.name = 'ModelOutputInvalid';
  }
}

/**
 * A model call that failed without an answer: the gateway or the provider refused it, or it never came back. It says
 * which call it was, the kind of error (its name, e.g. `AI_APICallError`) and the HTTP status of the last try when
 * there was one, so the flow can tell a call worth retrying (429, 5xx, no status) from one that is not (another 4xx).
 * It carries nothing else: the SDK's errors hold the whole request (the site's text, the brief, the pictures).
 */
export class ModelCallFailed extends Error {
  constructor(
    readonly call: string,
    readonly kind: string,
    readonly status?: number,
  ) {
    super(`The ${call} model call failed (${kind}${status === undefined ? '' : `, HTTP ${status}`}).`);
    this.name = 'ModelCallFailed';
  }
}
