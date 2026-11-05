// What the order page shows of an order's progress, and how it follows it. The status lists the flow's steps; a person
// is shown fewer, told in the first person: the VM being rented is part of reading the page and the delivery is part of
// the final video. Types only from the server's modules, since the page runs in the browser too.
import type { StatusJson } from '../payments/orders';
import { ORDER_PAGE } from './copy';

type OrderState = StatusJson['status'];
type StepState = StatusJson['steps'][number]['state'];
type StepName = StatusJson['steps'][number]['name'];

/** `now` is the step being done, `todo` one not reached yet, `never` one an order no longer being made will not reach. */
export type RowState = 'done' | 'now' | 'todo' | 'never' | 'failed';
/** Which row it is: the same whatever its words say, as the words change with its state. */
export type RowKey = keyof typeof ORDER_PAGE.steps;
export type ProgressRow = { key: RowKey; label: string; state: RowState };

/** A row's words: what was done, and what is being done or is still to do. */
type Words = { done: string; doing: string };

/** What a row says in its state: what was done, in the past; the step being done, as it goes; any other, the action. */
const labelOf = ({ done, doing }: Words, state: RowState): string => (state === 'done' ? done : state === 'now' ? `${doing}…` : doing);

/** How often the page asks for the order's status while the order is not over. */
export const POLL_MS = 5000;

/** What the page shows of an order: its making, the refund of one that could not be made, or the end it came to. */
export type Phase = 'making' | 'refund' | 'unpaid' | 'expired' | 'delivered';

/**
 * What the page does with each status of an order: what it shows, and whether the order is over (it will not change
 * again, so the page stops asking and the status is the last word on the steps), and whether its payment went through.
 * The one list of them, a record over every status: one added to the service does not compile until it is placed here.
 * (`refunding` is not over: its refund is still on its way.)
 */
const STATUSES: Record<OrderState, { phase: Phase; over: boolean; paid: boolean }> = {
  awaiting_settlement: { phase: 'making', over: false, paid: false },
  paid: { phase: 'making', over: false, paid: true },
  running: { phase: 'making', over: false, paid: true },
  delivered: { phase: 'delivered', over: true, paid: true },
  unpaid: { phase: 'unpaid', over: true, paid: false },
  refunding: { phase: 'refund', over: false, paid: true },
  refunded: { phase: 'refund', over: true, paid: true },
  refund_failed: { phase: 'refund', over: true, paid: true },
  expired: { phase: 'expired', over: true, paid: false },
};

export const isTerminal = (status: OrderState): boolean => STATUSES[status].over;
export const phaseOf = (status: OrderState): Phase => STATUSES[status].phase;

/**
 * What the page shows of an order as its status says it. A payment the facilitator refused leaves the order awaiting
 * its settlement until its authorization expires, with the payment step `failed`: the page says at once that it did not
 * go through. The order is not over, so the page keeps asking: a payment that still settles turns it to the making.
 */
export function viewPhase(status: StatusJson): Phase {
  const refused = status.status === 'awaiting_settlement' && status.steps.some((step) => step.name === 'payment' && step.state === 'failed');
  return refused ? 'unpaid' : phaseOf(status.status);
}

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

/** A row before its state is settled: which it is, its words, and what it stands on. */
type Row = { key: RowKey; words: Words; seen: Seen };

/**
 * The music step fails only when the music could not be made: the order goes on without it and is delivered, never
 * refunded for it. So it is shown as a step that is over, with words that say what happened.
 */
function musicRow(status: StatusJson): Row {
  const { music } = ORDER_PAGE.steps;
  const state = seen(status, 'music');
  return state === 'failed' ? { key: 'music', words: { ...music, done: music.notMade }, seen: 'done' } : { key: 'music', words: music, seen: state };
}

/**
 * What the payment row stands on. An order past its settlement was paid, whatever its step says: a payment the
 * facilitator refused may settle all the same, and the order turns `paid` a moment before its step turns `done` (or
 * that write fails).
 */
function paymentSeen(status: StatusJson): Seen {
  return STATUSES[status.status].paid ? 'done' : seen(status, 'payment');
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
  const row = (key: Exclude<RowKey, 'music'>, state: Seen): Row => ({ key, words: ORDER_PAGE.steps[key], seen: state });
  const rows: Row[] = [
    row('payment', paymentSeen(status)),
    row('capture', folded(status, 'vm', 'capture')),
    row('script', seen(status, 'script')),
    ...(audio === 'music' ? [musicRow(status)] : []),
    row('preview', seen(status, 'preview')),
    row('review', seen(status, 'review')),
    row('render', folded(status, 'render', 'delivery')),
  ];
  const refundAt = status.steps.some((step) => step.name === 'refund') ? rows.length : -1;
  if (refundAt !== -1) rows.push(row('refund', refundSeen(status)));

  // The video is being made until the order leaves its making or one of its steps fails: a step that failed is refunded
  // (music that could not be made is not one, see musicRow), though the order turns `refunding` only a few steps later.
  const making = phaseOf(status.status) === 'making' && !rows.some((row) => row.seen === 'failed');
  // The step being done: while the refund is on its way, the refund, whatever step a lost run left running; otherwise
  // the step running or, while the video is being made and none has begun, the one that comes next.
  let now = -1;
  if (!isTerminal(status.status)) {
    if (phaseOf(status.status) === 'refund') {
      now = refundAt;
    } else {
      now = rows.findIndex((row) => row.seen === 'running');
      if (now === -1 && making) now = rows.findIndex((row) => row.seen === 'pending');
    }
  }
  // Once the video is no longer being made (a step failed, it is refunded, or the order is over), what it did not get
  // to never comes.
  return rows.map(({ key, words, seen: state }, index) => {
    const shown: RowState = state === 'done' ? 'done' : state === 'failed' ? 'failed' : index === now ? 'now' : making ? 'todo' : 'never';
    return { key, label: labelOf(words, shown), state: shown };
  });
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
