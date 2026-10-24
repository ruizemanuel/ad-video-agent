import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatusJson } from '../src/payments/orders';
import { ORDER_STATUSES, type StepName, type StepState } from '../src/ports';
import { ORDER_PAGE } from '../src/site/copy';
import { followStatus, isTerminal, phaseOf, POLL_MS, progressRows } from '../src/site/progress';

/** Every step of the status, in order; those not in `steps` are `pending`, and `refund` is there only when it is given. */
function status(steps: Partial<Record<StepName, StepState>> = {}, over: Partial<StatusJson> = {}): StatusJson {
  const names: StepName[] = ['payment', 'vm', 'capture', 'script', 'music', 'preview', 'review', 'render', 'delivery'];
  if (steps.refund !== undefined) names.push('refund');
  return { id: 'ord_abc', status: 'running', steps: names.map((name) => ({ name, state: steps[name] ?? 'pending' })), warnings: [], ...over };
}

const states = (rows: ReturnType<typeof progressRows>) => rows.map(({ state }) => state);
const labels = (rows: ReturnType<typeof progressRows>) => rows.map(({ label }) => label);

describe('progressRows', () => {
  it('labels the steps for people and hides vm and delivery', () => {
    expect(labels(progressRows(status(), 'music'))).toEqual([
      'Payment received',
      'Site captured',
      'Script written, every line sourced',
      'Music chosen',
      'Key frames ready',
      'Quality check',
      'Final video',
    ]);
  });

  it('counts the VM as part of the capture, and the delivery as part of the final video', () => {
    // The VM being set up is the first part of "Site captured"; once it is up and the capture runs, that is still the row.
    expect(progressRows(status({ payment: 'done', vm: 'running' }), 'music')[1]).toEqual({ label: 'Site captured', state: 'now' });
    expect(progressRows(status({ payment: 'done', vm: 'done', capture: 'running' }), 'music')[1]).toEqual({ label: 'Site captured', state: 'now' });
    // Failed if either failed; done once the later one is.
    expect(progressRows(status({ vm: 'failed' }), 'music')[1]?.state).toBe('failed');
    expect(progressRows(status({ vm: 'done', capture: 'failed' }), 'music')[1]?.state).toBe('failed');
    expect(progressRows(status({ vm: 'done', capture: 'done' }), 'music')[1]?.state).toBe('done');
    // The render done is not the video: it is delivered when the delivery is done.
    const rendered = status({ payment: 'done', vm: 'done', capture: 'done', script: 'done', music: 'done', preview: 'done', review: 'done', render: 'done' });
    expect(progressRows(rendered, 'music').at(-1)).toEqual({ label: 'Final video', state: 'now' });
    expect(progressRows({ ...rendered, steps: rendered.steps.map((s) => (s.name === 'delivery' ? { ...s, state: 'running' as const } : s)) }, 'music').at(-1)).toEqual({
      label: 'Final video',
      state: 'now',
    });
    expect(progressRows(status({ render: 'done', delivery: 'done' }), 'music').at(-1)?.state).toBe('done');
    expect(progressRows(status({ render: 'failed' }), 'music').at(-1)?.state).toBe('failed');
    expect(progressRows(status({ render: 'done', delivery: 'failed' }), 'music').at(-1)?.state).toBe('failed');
  });

  it('counts a skipped step as done', () => {
    expect(progressRows(status({ vm: 'skipped', capture: 'skipped', script: 'skipped' }), 'music').slice(1, 3).map(({ state }) => state)).toEqual(['done', 'done']);
  });

  it('hides music for audio none', () => {
    const rows = progressRows(status(), 'none');
    expect(labels(rows)).not.toContain('Music chosen');
    expect(rows).toHaveLength(6);
  });

  it('marks the first running step as now', () => {
    const rows = progressRows(status({ payment: 'done', vm: 'done', capture: 'done', script: 'running' }), 'music');
    expect(states(rows)).toEqual(['done', 'done', 'now', 'todo', 'todo', 'todo', 'todo']);
    // One only, even when the flow has two steps open at once.
    const two = progressRows(status({ payment: 'done', vm: 'done', capture: 'done', script: 'running', music: 'running' }), 'music');
    expect(states(two).filter((state) => state === 'now')).toHaveLength(1);
    expect(states(two)[2]).toBe('now');
  });

  it('marks the first pending step as now when none is running', () => {
    expect(states(progressRows(status(), 'music'))[0]).toBe('now');
    expect(states(progressRows(status({ payment: 'done', vm: 'done', capture: 'done' }), 'music'))).toEqual(['done', 'done', 'now', 'todo', 'todo', 'todo', 'todo']);
  });

  it('has no step now once the video is delivered', () => {
    const done = status(
      { payment: 'done', vm: 'done', capture: 'done', script: 'done', music: 'done', preview: 'done', review: 'done', render: 'done', delivery: 'done' },
      { status: 'delivered' },
    );
    expect(states(progressRows(done, 'music'))).toEqual(Array(7).fill('done'));
  });

  it('shows the refund step only when there is one', () => {
    expect(labels(progressRows(status({ payment: 'done', vm: 'done', capture: 'failed' }), 'music'))).not.toContain('Refund sent');

    const refunding = status({ payment: 'done', vm: 'done', capture: 'failed', refund: 'running' }, { status: 'refunding' });
    const rows = progressRows(refunding, 'music');
    expect(rows.at(-1)).toEqual({ label: 'Refund sent', state: 'now' });
    expect(rows[1]?.state).toBe('failed');
    // The steps after the one that failed will not be done: none of them is waiting, and none is the current one.
    expect(states(rows)).toEqual(['done', 'failed', 'never', 'never', 'never', 'never', 'never', 'now']);

    const sent = progressRows(status({ payment: 'done', vm: 'done', capture: 'failed', refund: 'done' }, { status: 'refunded' }), 'music');
    expect(sent.at(-1)).toEqual({ label: 'Refund sent', state: 'done' });
    expect(states(sent)).not.toContain('now');

    const stuck = progressRows(status({ payment: 'done', capture: 'failed', refund: 'failed' }, { status: 'refund_failed' }), 'music');
    expect(stuck.at(-1)).toEqual({ label: 'Refund sent', state: 'failed' });
  });

  it('lets an order that has ended say how its refund ended, whatever the step says', () => {
    // The flow moves the order to `refunded` and then its step; the reconciliation moves the order and not the step.
    const sent = progressRows(status({ payment: 'done', vm: 'done', capture: 'failed', refund: 'running' }, { status: 'refunded' }), 'music');
    expect(sent.at(-1)).toEqual({ label: 'Refund sent', state: 'done' });
    expect(states(sent)).toEqual(['done', 'failed', 'never', 'never', 'never', 'never', 'never', 'done']);

    const delayed = progressRows(status({ payment: 'done', vm: 'done', capture: 'failed', refund: 'running' }, { status: 'refund_failed' }), 'music');
    expect(delayed.at(-1)).toEqual({ label: 'Refund sent', state: 'failed' });
    expect(states(delayed)).not.toContain('now');
  });

  it('says a step an order that has ended never got to was not done, instead of waiting', () => {
    const rows = progressRows(status({ payment: 'done', vm: 'done', capture: 'done', script: 'done', music: 'done', preview: 'done', review: 'failed', refund: 'done' }, { status: 'refunded' }), 'music');
    expect(rows.find(({ label }) => label === 'Final video')).toEqual({ label: 'Final video', state: 'never' });
    expect(ORDER_PAGE.stateOf.never).toBe('Not done');
  });

  it('makes the refund the step being done while it is on its way, even when the run was lost with a step running', () => {
    // A lost run is refunded with its last step still `running` (the reconciliation's refundLostRun).
    const rows = progressRows(status({ payment: 'done', vm: 'done', capture: 'running', refund: 'running' }, { status: 'refunding' }), 'music');
    expect(states(rows)).toEqual(['done', 'never', 'never', 'never', 'never', 'never', 'never', 'now']);
  });

  it('has no step now once the order is over, even one the order left running', () => {
    for (const end of ORDER_STATUSES.filter(isTerminal)) {
      const rows = progressRows(status({ payment: 'done', vm: 'done', capture: 'running', refund: 'running' }, { status: end }), 'music');
      expect(states(rows), end).not.toContain('now');
      expect(rows[1]?.state, end).toBe('never');
    }
    // While the refund is on its way, it is the step being done.
    expect(progressRows(status({ payment: 'done', capture: 'failed', refund: 'running' }, { status: 'refunding' }), 'music').at(-1)?.state).toBe('now');
  });

  it('shows music that could not be made as a step that is over, in every status', () => {
    for (const order of ORDER_STATUSES) {
      const rows = progressRows(status({ payment: 'done', vm: 'done', capture: 'done', script: 'done', music: 'failed' }, { status: order }), 'music');
      expect(rows[3], order).toEqual({ label: 'No music this time', state: 'done' });
    }
    // The video goes on: the step after it is the one being done, and nothing is red.
    const going = progressRows(status({ payment: 'done', vm: 'done', capture: 'done', script: 'done', music: 'failed', preview: 'running' }), 'music');
    expect(states(going)).toEqual(['done', 'done', 'done', 'done', 'now', 'todo', 'todo']);
    expect(labels(progressRows(status({ music: 'failed' }), 'none'))).not.toContain('No music this time');
  });

  it('marks nothing as now for an order that never got going', () => {
    expect(states(progressRows(status({}, { status: 'unpaid' }), 'music'))).not.toContain('now');
    expect(states(progressRows(status({}, { status: 'expired' }), 'music'))).not.toContain('now');
  });
});

describe('isTerminal', () => {
  it.each(['delivered', 'unpaid', 'refunded', 'refund_failed', 'expired'] as const)('stops at %s', (end) => {
    expect(isTerminal(end)).toBe(true);
  });

  it.each(['awaiting_settlement', 'paid', 'running', 'refunding'] as const)('goes on at %s', (going) => {
    expect(isTerminal(going)).toBe(false);
  });
});

describe('the statuses of an order', () => {
  it('says for every one whether it is over, and what the page shows', () => {
    expect(Object.fromEntries(ORDER_STATUSES.map((order) => [order, [isTerminal(order), phaseOf(order)]]))).toEqual({
      awaiting_settlement: [false, 'making'],
      paid: [false, 'making'],
      running: [false, 'making'],
      delivered: [true, 'delivered'],
      unpaid: [true, 'unpaid'],
      refunding: [false, 'refund'],
      refunded: [true, 'refund'],
      refund_failed: [true, 'refund'],
      expired: [true, 'expired'],
    });
  });
});

describe('followStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks every 5 seconds until the order reaches an end', async () => {
    expect(POLL_MS).toBe(5000);
    const answers = [status({ payment: 'done' }), status({ payment: 'done', capture: 'running' }), status({}, { status: 'delivered' }), status({}, { status: 'delivered' })];
    const read = vi.fn(async () => answers.shift() ?? null);
    const seen: string[] = [];
    followStatus('running', read, (next) => seen.push(next.status));

    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(read).toHaveBeenCalledTimes(3);
    expect(seen).toEqual(['running', 'running', 'delivered']);

    // It ended: nothing is asked again, and nothing is waiting.
    await vi.advanceTimersByTimeAsync(10 * POLL_MS);
    expect(read).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not ask at all for an order that has already ended', async () => {
    const read = vi.fn(async () => status());
    for (const end of ['delivered', 'unpaid', 'refunded', 'refund_failed', 'expired'] as const) followStatus(end, read, () => undefined);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps asking after an answer it could not get', async () => {
    const read = vi
      .fn<() => Promise<StatusJson | null>>()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(status({}, { status: 'refunded' }));
    const seen: string[] = [];
    followStatus('running', read, (next) => seen.push(next.status));
    await vi.advanceTimersByTimeAsync(3 * POLL_MS);
    expect(read).toHaveBeenCalledTimes(3);
    expect(seen).toEqual(['refunded']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops when told to, and drops an answer that comes after', async () => {
    let answer: (value: StatusJson) => void = () => undefined;
    const read = vi.fn(() => new Promise<StatusJson | null>((done) => (answer = done)));
    const seen: string[] = [];
    const stop = followStatus('running', read, (next) => seen.push(next.status));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(read).toHaveBeenCalledTimes(1);
    const [signal] = read.mock.calls[0] as unknown as [AbortSignal];

    stop();
    expect(signal.aborted).toBe(true);
    answer(status());
    await vi.advanceTimersByTimeAsync(5 * POLL_MS);
    expect(seen).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
