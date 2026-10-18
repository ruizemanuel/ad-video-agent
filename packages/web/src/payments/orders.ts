// What happens to an order around its payment, and what its status says to whoever polls it. The paying request
// makes the order (`awaiting_settlement`); once the facilitator settles, `markPaidAndStart` moves it to `paid` and
// starts its run. The reconciliation does the same for a settlement nobody reported.
import { start } from 'workflow/api';
import type { Env } from '../env';
import { signFileLink } from '../links';
import { ORDER_DAYS, STEP_NAMES, type Order, type OrderStatus, type OrderStore, type RefundRecord, type RefundStatus, type StepName, type StepState } from '../ports';
import { orderWorkflow } from '../workflows/order';
import type { SettledPayment } from './x402';

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long the delivery links work, from the delivery. */
const LINK_DAYS = 30;

export type MarkPaidDeps = { store: Pick<OrderStore, 'findOrderByPayment' | 'transition' | 'setStep' | 'setRunId'> };

/** A payment that was found settled. `txHash` is null when it was found on the chain, which does not say which transaction. */
export type FoundPayment = Pick<SettledPayment, 'asset' | 'payer' | 'nonce'> & { txHash: string | null };

/** Starts the run of a paid order and keeps its id. The caller has the right to start it: nothing here checks. */
export async function startRun(orderId: string, store: Pick<OrderStore, 'setRunId'>): Promise<void> {
  const run = await start(orderWorkflow, [orderId]);
  await store.setRunId(orderId, run.runId);
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
  warnings: string[];
  refund?: { status: RefundStatus; txHash: string | null };
  /** When the order and its files are deleted (ISO 8601). Gone once the order has expired. */
  expiresAt?: string;
};

/** The base is where the service lives, with no trailing slash: the links point there. */
export function statusView(order: Order, refund: RefundRecord | null, settings: Pick<Env, 'LINK_SIGNING_SECRET'> & { PUBLIC_BASE_URL: string }): StatusJson {
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
  if (refund !== null) view.refund = { status: refund.status, txHash: refund.txHash };
  if (order.status !== 'expired') view.expiresAt = new Date(order.createdAt.getTime() + ORDER_DAYS * DAY_MS).toISOString();
  return view;
}

/** Where the service lives: PUBLIC_BASE_URL, or (only where it is not set, in local runs) the address it was asked at. */
export const serviceBase = (settings: Pick<Env, 'PUBLIC_BASE_URL'>, req: Request): string => settings.PUBLIC_BASE_URL ?? new URL(req.url).origin;
