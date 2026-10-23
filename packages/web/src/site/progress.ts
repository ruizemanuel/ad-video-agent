// What the order page shows of an order's progress, and how it follows it. The status lists the flow's steps; a person
// is shown fewer, with names of their own: the VM being rented is part of "Site captured" and the delivery is part of
// "Final video". Types only from the server's modules, since the page runs in the browser too.
import type { StatusJson } from '../payments/orders';
import { ORDER_PAGE } from './copy';

type OrderState = StatusJson['status'];
type StepState = StatusJson['steps'][number]['state'];
type StepName = StatusJson['steps'][number]['name'];

/** `now` is the step being done, `todo` one not reached. */
export type RowState = 'done' | 'now' | 'todo' | 'failed';
export type ProgressRow = { label: string; state: RowState };

/** How often the page asks for the order's status while the order is not over. */
export const POLL_MS = 5000;

/** The states an order does not leave. (`refunding` is not one: its refund is still on its way.) */
const ENDS: readonly OrderState[] = ['delivered', 'unpaid', 'refunded', 'refund_failed', 'expired'];
/** The states in which the video is being made: a step not yet begun is the one that comes next. */
const MAKING: readonly OrderState[] = ['awaiting_settlement', 'paid', 'running'];

export const isTerminal = (status: OrderState): boolean => ENDS.includes(status);

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

/** The rows of the order's progress, in the order they happen. `now` is on one row at most. */
export function progressRows(status: StatusJson, audio: 'music' | 'none'): ProgressRow[] {
  const { steps } = ORDER_PAGE;
  const rows: { label: string; seen: Seen }[] = [
    { label: steps.payment, seen: seen(status, 'payment') },
    { label: steps.capture, seen: folded(status, 'vm', 'capture') },
    { label: steps.script, seen: seen(status, 'script') },
    ...(audio === 'music' ? [{ label: steps.music, seen: seen(status, 'music') }] : []),
    { label: steps.preview, seen: seen(status, 'preview') },
    { label: steps.review, seen: seen(status, 'review') },
    { label: steps.render, seen: folded(status, 'render', 'delivery') },
    ...(status.steps.some((step) => step.name === 'refund') ? [{ label: steps.refund, seen: seen(status, 'refund') }] : []),
  ];

  // The step being done; or, while the video is being made and none has begun, the one that comes next.
  let now = rows.findIndex((row) => row.seen === 'running');
  if (now === -1 && MAKING.includes(status.status)) now = rows.findIndex((row) => row.seen === 'pending');
  return rows.map(({ label, seen: state }, index) => ({
    label,
    state: state === 'done' ? 'done' : state === 'failed' ? 'failed' : index === now ? 'now' : 'todo',
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
