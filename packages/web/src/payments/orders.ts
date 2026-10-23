// What happens to an order around its payment, and what its status says to whoever polls it. The paying request
// makes the order (`awaiting_settlement`); once the facilitator settles, `markPaidAndStart` moves it to `paid` and
// starts its run. The reconciliation does the same for a settlement nobody reported.
import type { ClaimItem } from '@app/core';
import { getRun, start, type Run } from 'workflow/api';
import { WorkflowRunNotFoundError } from 'workflow/errors';
import type { Env } from '../env';
import { signFileLink } from '../links';
import {
  ORDER_DAYS,
  STEP_NAMES,
  type Feedback,
  type FeedbackAnswer,
  type Order,
  type OrderStatus,
  type OrderStore,
  type RefundRecord,
  type RefundStatus,
  type StepName,
  type StepState,
} from '../ports';
import { orderWorkflow } from '../workflows/order';
import type { SettledPayment } from './x402';

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long the delivery links work, from the delivery. */
const LINK_DAYS = 30;

export type MarkPaidDeps = { store: Pick<OrderStore, 'findOrderByPayment' | 'transition' | 'setStep' | 'setRunIdIfNone'> };

/** A payment that was found settled. `txHash` is null when it was found on the chain, which does not say which transaction. */
export type FoundPayment = Pick<SettledPayment, 'asset' | 'payer' | 'nonce'> & { txHash: string | null };

/**
 * Starts the run of a paid order and keeps its id, unless the order already has one. The caller has the right to start
 * it: nothing here checks. Two callers can start a run for the same order (two reconciliations at once); the second run
 * ends as a duplicate (see orderWorkflow), and its id must not take the place of the run that holds the order, or the
 * reconciliation would take that run for lost. So the id is kept only if none is there, and the loser leaves the order
 * as it is.
 */
export async function startRun(orderId: string, store: Pick<OrderStore, 'setRunIdIfNone'>): Promise<void> {
  const run = await start(orderWorkflow, [orderId]);
  await store.setRunIdIfNone(orderId, run.runId);
}

/**
 * What the workflow runtime says of a run: `pending` or `running` while it is at work, `completed`, `failed` or
 * `cancelled` once it is over, `missing` when the runtime does not know it, `unreadable` when it could not be asked.
 */
export type RunStatus = Awaited<Run<unknown>['status']> | 'missing' | 'unreadable';

/** One read of the run's record, without its data. It never throws. */
export async function runStatus(runId: string): Promise<RunStatus> {
  try {
    return await getRun(runId).status;
  } catch (error) {
    return WorkflowRunNotFoundError.is(error) ? 'missing' : 'unreadable';
  }
}

/**
 * `started` when this call moved the order to `paid` and started its run. `already` when the order is past waiting
 * for its settlement (another call got there first, or it was given up as unpaid): nothing is started twice.
 * `unknown` when no order has this payment.
 */
export async function markPaidAndStart(payment: FoundPayment, deps: MarkPaidDeps): Promise<'started' | 'already' | 'unknown'> {
  const { store } = deps;
  const order = await store.findOrderByPayment(payment.asset, payment.payer, payment.nonce);
  if (order === null) return 'unknown';
  // The store sets `paidAt`. Only one caller can win this move, so only one starts a run.
  if (!(await store.transition(order.id, 'paid', { settleTx: payment.txHash }))) return 'already';
  await store.setStep(order.id, 'payment', 'done');
  await startRun(order.id, store);
  return 'started';
}

/** A step not yet reached is `pending`. */
export type StatusStep = { name: StepName; state: StepState | 'pending' };

export type StatusJson = {
  id: string;
  status: OrderStatus;
  /** Every step, in the order they happen. `refund` is there only when the order has one. */
  steps: StatusStep[];
  /** Only once the order is delivered: each file with its signed download link. */
  files?: { name: string; url: string; bytes: number }[];
  /** Only once the order is delivered: each claim the video makes, with the words on the site that back it. */
  claims?: ClaimItem[];
  /** Only once the order is delivered with music: the model that made the track (its name) and the tempo measured on it. */
  music?: { model: string; bpm: number };
  warnings: string[];
  refund?: { status: RefundStatus; txHash: string | null };
  /** Once the client has answered "did you post it?" (POST /v1/videos/<id>/feedback), and still after the order expires. */
  feedback?: { answer: FeedbackAnswer; postUrl: string | null; mayShow: boolean };
  /** When the order and its files are deleted (ISO 8601). Gone once the order has expired. */
  expiresAt?: string;
};

/** The base is where the service lives, with no trailing slash: the links point there. */
export function statusView(
  order: Order,
  refund: RefundRecord | null,
  feedback: Feedback | null,
  settings: Pick<Env, 'LINK_SIGNING_SECRET'> & { PUBLIC_BASE_URL: string },
): StatusJson {
  const steps: StatusStep[] = STEP_NAMES.filter((name) => name !== 'refund' || order.steps.refund !== undefined).map((name) => ({
    name,
    state: order.steps[name] ?? 'pending',
  }));
  const view: StatusJson = { id: order.id, status: order.status, steps, warnings: order.warnings };

  const { deliveredAt } = order;
  if (order.status === 'delivered' && deliveredAt !== null) {
    const exp = Math.floor((deliveredAt.getTime() + LINK_DAYS * DAY_MS) / 1000);
    view.files = order.deliverables.map(({ name, bytes }) => ({
      name,
      url: signFileLink({ orderId: order.id, name, exp }, settings.LINK_SIGNING_SECRET, settings.PUBLIC_BASE_URL),
      bytes,
    }));
  }
  if (order.status === 'delivered' && order.summary !== null) {
    view.claims = order.summary.claims;
    if (order.summary.music !== null) view.music = order.summary.music;
  }
  if (refund !== null) view.refund = { status: refund.status, txHash: refund.txHash };
  if (feedback !== null) view.feedback = { answer: feedback.answer, postUrl: feedback.postUrl, mayShow: feedback.mayShow };
  if (order.status !== 'expired') view.expiresAt = new Date(order.createdAt.getTime() + ORDER_DAYS * DAY_MS).toISOString();
  return view;
}

/** Where the service lives: PUBLIC_BASE_URL, or (only where it is not set, in local runs) the address it was asked at. */
export const serviceBase = (settings: Pick<Env, 'PUBLIC_BASE_URL'>, req: Request): string => settings.PUBLIC_BASE_URL ?? new URL(req.url).origin;
