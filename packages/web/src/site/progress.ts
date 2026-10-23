// What the order page shows of an order's progress, and how it follows it. The status lists the flow's steps; a person
// is shown fewer, with names of their own: the VM being rented is part of "Site captured" and the delivery is part of
// "Final video". Types only from the server's modules, since the page runs in the browser too.
import type { StatusJson } from '../payments/orders';
import { ORDER_PAGE } from './copy';

type OrderState = StatusJson['status'];
type StepState = StatusJson['steps'][number]['state'];
type StepName = StatusJson['steps'][number]['name'];

/** `now` is the step being done, `todo` one not reached yet, `never` one an order no longer being made will not reach. */
export type RowState = 'done' | 'now' | 'todo' | 'never' | 'failed';
export type ProgressRow = { label: string; state: RowState };

/** How often the page asks for the order's status while the order is not over. */
export const POLL_MS = 5000;

/** What the page shows of an order: its making, the refund of one that could not be made, or the end it came to. */
export type Phase = 'making' | 'refund' | 'unpaid' | 'expired' | 'delivered';

/**
 * What the page does with each status of an order: what it shows, and whether the order is over (it will not change
 * again, so the page stops asking and the status is the last word on the steps). The one list of them, a record over
 * every status: one added to the service does not compile until it is placed here. (`refunding` is not over: its
 * refund is still on its way.)
 */
const STATUSES: Record<OrderState, { phase: Phase; over: boolean }> = {
  awaiting_settlement: { phase: 'making', over: false },
  paid: { phase: 'making', over: false },
  running: { phase: 'making', over: false },
  delivered: { phase: 'delivered', over: true },
  unpaid: { phase: 'unpaid', over: true },
  refunding: { phase: 'refund', over: false },
  refunded: { phase: 'refund', over: true },
  refund_failed: { phase: 'refund', over: true },
  expired: { phase: 'expired', over: true },
};

export const isTerminal = (status: OrderState): boolean => STATUSES[status].over;
export const phaseOf = (status: OrderState): Phase => STATUSES[status].phase;

/** What a row stands on: a step in the flow's words, where a skipped step counts as done. */
type Seen = 'done' | 'running' | 'failed' | 'pending';

const seen = (status: StatusJson, name: StepName): Seen => {
  const state: StepState = status.steps.find((step) => step.name === name)?.state ?? 'pending';
  return state === 'skipped' ? 'done' : state;
};

/**
 * Two steps shown as one row: failed if either failed, done once the later one is, and otherwise as the first of the
 * two that is not done.
 */
function folded(status: StatusJson, first: StepName, last: StepName): Seen {
  const [a, b] = [seen(status, first), seen(status, last)];
  if (a === 'failed' || b === 'failed') return 'failed';
  if (b === 'done') return 'done';
  return a === 'done' ? b : a;
}

/**
 * The music step fails only when the music could not be made: the order goes on without it and is delivered, never
 * refunded for it. So it is shown as a step that is over, with a name that says what happened.
 */
function musicRow(status: StatusJson): { label: string; seen: Seen } {
  const state = seen(status, 'music');
  return state === 'failed' ? { label: ORDER_PAGE.steps.noMusic, seen: 'done' } : { label: ORDER_PAGE.steps.music, seen: state };
}

/**
 * What the refund step stands on. An order that is over says how its refund ended, whatever the step says: the flow and
 * the reconciliation move the order's status and its step in two writes, or the step not at all.
 */
function refundSeen(status: StatusJson): Seen {
  if (status.status === 'refunded') return 'done';
  if (status.status === 'refund_failed') return 'failed';
  return seen(status, 'refund');
}

/**
 * The rows of the order's progress, in the order they happen. `now` is on one row at most, and on none once the order
 * is over: from then on the status is the last word, so a step the order left running is not being done.
 */
export function progressRows(status: StatusJson, audio: 'music' | 'none'): ProgressRow[] {
  const { steps } = ORDER_PAGE;
  const rows: { label: string; seen: Seen }[] = [
    { label: steps.payment, seen: seen(status, 'payment') },
    { label: steps.capture, seen: folded(status, 'vm', 'capture') },
    { label: steps.script, seen: seen(status, 'script') },
    ...(audio === 'music' ? [musicRow(status)] : []),
    { label: steps.preview, seen: seen(status, 'preview') },
    { label: steps.review, seen: seen(status, 'review') },
    { label: steps.render, seen: folded(status, 'render', 'delivery') },
    ...(status.steps.some((step) => step.name === 'refund') ? [{ label: steps.refund, seen: refundSeen(status) }] : []),
  ];

  // The step being done; or, while the video is being made and none has begun, the one that comes next.
  let now = -1;
  if (!isTerminal(status.status)) {
    now = rows.findIndex((row) => row.seen === 'running');
    if (now === -1 && phaseOf(status.status) === 'making') now = rows.findIndex((row) => row.seen === 'pending');
  }
  // Once the video is no longer being made (it is refunded, or the order is over), what it did not get to never comes.
  const making = phaseOf(status.status) === 'making';
  return rows.map(({ label, seen: state }, index) => ({
    label,
    state: state === 'done' ? 'done' : state === 'failed' ? 'failed' : index === now ? 'now' : making ? 'todo' : 'never',
  }));
}

/**
 * Asks for the order's status every POLL_MS, from when it starts, until an answer says the order is over; each answer
 * goes to `onStatus`. An order that is over already is not asked about. A look that gets no answer (`read` gives null or
 * fails) is tried again at the next turn. Gives the function that stops it, and drops what a look in flight brings after.
 */
export function followStatus(
  from: OrderState,
  read: (signal: AbortSignal) => Promise<StatusJson | null>,
  onStatus: (status: StatusJson) => void,
): () => void {
  if (isTerminal(from)) return () => undefined;
  const stopper = new AbortController();
  let timer: ReturnType<typeof setTimeout>;

  const look = async (): Promise<void> => {
    let status: StatusJson | null = null;
    try {
      status = await read(stopper.signal);
    } catch {
      // No answer this time: the next turn tries again.
    }
    if (stopper.signal.aborted) return;
    if (status !== null) {
      onStatus(status);
      if (isTerminal(status.status)) return;
    }
    timer = setTimeout(() => void look(), POLL_MS);
  };

  timer = setTimeout(() => void look(), POLL_MS);
  return () => {
    stopper.abort();
    clearTimeout(timer);
  };
}
