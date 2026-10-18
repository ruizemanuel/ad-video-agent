import type { TaskEnvelope } from '@app/core';
import { describe, expect, it, vi } from 'vitest';
import { createVmApi, VmApiError, type VmApi } from '../src/api';
import { runWorker } from '../src/worker';

const task = (id: string, kind: TaskEnvelope['kind'], input: unknown = {}): TaskEnvelope => ({ id, kind, input, urls: {} });

/** An API that gives out the steps in order: a task, no task (null) or an error to throw. */
function fakeApi(steps: (TaskEnvelope | null | Error)[]) {
  const results: [string, unknown][] = [];
  const api: VmApi = {
    next: vi.fn(async () => {
      const step = steps.shift();
      if (step === undefined) throw new Error('the test ran out of steps');
      if (step instanceof Error) throw step;
      return step;
    }),
    result: vi.fn(async (id, body) => {
      results.push([id, body]);
    }),
  };
  return { api, results };
}

/** A clock that only moves when the worker sleeps. */
function clock(start = 0) {
  let now = start;
  const sleep = vi.fn(async (ms: number) => {
    now += ms;
  });
  return { now: () => now, sleep, log: () => {} };
}

describe('runWorker', () => {
  it('runs tasks until shutdown and posts each result', async () => {
    const { api, results } = fakeApi([task('t1', 'capture', { url: 'https://x.example' }), null, task('t2', 'shutdown')]);
    const capture = vi.fn(async () => ({ ok: true, sections: 4 }));
    const time = clock();

    await runWorker({ api, handlers: { capture }, deadline: 600_000, ...time });

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ id: 't1', input: { url: 'https://x.example' } }));
    expect(results).toEqual([
      ['t1', { ok: true, sections: 4 }],
      ['t2', { ok: true }],
    ]);
    // One wait, after the poll that found nothing: 3 s unless told otherwise.
    expect(time.sleep.mock.calls).toEqual([[3000]]);
    expect(api.next).toHaveBeenCalledTimes(3);
  });

  it('posts ok:false when a handler throws', async () => {
    const { api, results } = fakeApi([task('t1', 'capture'), task('t2', 'shutdown')]);
    const capture = vi.fn(async () => {
      throw new Error('Chrome died');
    });

    await runWorker({ api, handlers: { capture }, deadline: 600_000, ...clock() });

    expect(results[0]).toEqual(['t1', { ok: false, code: 'error', message: 'Chrome died' }]);
  });

  it('keeps the message of a failure short', async () => {
    const { api, results } = fakeApi([task('t1', 'capture'), task('t2', 'shutdown')]);
    const capture = async () => {
      throw new Error('x'.repeat(5000));
    };

    await runWorker({ api, handlers: { capture }, deadline: 600_000, ...clock() });

    const body = results[0]?.[1] as { message: string };
    expect(body.message.length).toBeLessThanOrEqual(300);
  });

  it('answers a task it has no handler for with ok:false and goes on', async () => {
    const { api, results } = fakeApi([task('t1', 'keyframes'), task('t2', 'shutdown')]);

    await runWorker({ api, handlers: {}, deadline: 600_000, ...clock() });

    expect(results[0]).toEqual(['t1', { ok: false, code: 'error', message: expect.stringContaining('keyframes') }]);
    expect(results).toHaveLength(2);
  });

  it('survives an API that fails now and then', async () => {
    const { api, results } = fakeApi([new TypeError('fetch failed'), new VmApiError('answered 502', 502), task('t1', 'shutdown')]);
    const time = clock();

    await runWorker({ api, handlers: {}, deadline: 600_000, ...time });

    expect(results).toEqual([['t1', { ok: true }]]);
    expect(time.sleep.mock.calls).toEqual([[3000], [3000]]);
  });

  it('gives up when the permit is refused: nothing it asks for will be answered', async () => {
    const { api } = fakeApi([new VmApiError('answered 401', 401)]);

    await expect(runWorker({ api, handlers: {}, deadline: 600_000, ...clock() })).rejects.toThrow(/401/);
    expect(api.next).toHaveBeenCalledTimes(1);
  });

  it('stops at the deadline, and never waits past it', async () => {
    const { api } = fakeApi(Array.from({ length: 20 }, () => null));
    const time = clock(1_000);

    await runWorker({ api, handlers: {}, pollMs: 4000, deadline: 10_000, ...time });

    // Polls at 1 s, 5 s and 9 s; the wait after the last one is cut to the 1 s that is left, not the 4 s asked for.
    expect(api.next).toHaveBeenCalledTimes(3);
    expect(time.sleep.mock.calls).toEqual([[4000], [4000], [1000]]);
    expect(time.now()).toBe(10_000);
  });

  it('does not start a task once the deadline has passed', async () => {
    const { api } = fakeApi([task('t1', 'capture')]);

    await runWorker({ api, handlers: {}, deadline: 5_000, ...clock(5_000) });

    expect(api.next).not.toHaveBeenCalled();
  });

  it('goes on to the next task when a result cannot be posted', async () => {
    const { api } = fakeApi([task('t1', 'capture'), task('t2', 'shutdown')]);
    vi.mocked(api.result).mockRejectedValueOnce(new Error('offline'));
    const capture = async () => ({ ok: true });

    await runWorker({ api, handlers: { capture }, deadline: 600_000, ...clock() });

    expect(api.result).toHaveBeenCalledTimes(2);
  });

  it('ends on shutdown even if the shutdown result cannot be posted', async () => {
    const { api } = fakeApi([task('t1', 'shutdown')]);
    vi.mocked(api.result).mockRejectedValue(new Error('offline'));

    await expect(runWorker({ api, handlers: {}, deadline: 600_000, ...clock() })).resolves.toBeUndefined();
  });
});

describe('the API calls', () => {
  /** A fetch that never answers until its signal fires. */
  const hang = ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    })) as unknown as typeof fetch;

  it('gives every API call a timeout and retries result posts on network errors', async () => {
    // The poll: a call that hangs is cut.
    const hanging = vi.fn(hang);
    await expect(createVmApi({ base: 'https://api.example', token: 't', fetchImpl: hanging, timeoutMs: 20 }).next()).rejects.toThrow();
    expect(hanging.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);

    // The result: three attempts, each with its own timeout, and the third one gets through.
    const flaky = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const api = createVmApi({ base: 'https://api.example', token: 't', fetchImpl: flaky, timeoutMs: 20, retryDelayMs: 0 });
    await expect(api.result('t1', { ok: true })).resolves.toBeUndefined();
    expect(flaky).toHaveBeenCalledTimes(3);
    for (const call of flaky.mock.calls) expect(call[1]?.signal).toBeInstanceOf(AbortSignal);

    // Three attempts and no more.
    const down = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(createVmApi({ base: 'https://api.example', token: 't', fetchImpl: down, retryDelayMs: 0 }).result('t1', { ok: true })).rejects.toThrow();
    expect(down).toHaveBeenCalledTimes(3);

    // A result post that hangs is cut too, and tried again.
    const stuck = vi.fn(hang);
    await expect(createVmApi({ base: 'https://api.example', token: 't', fetchImpl: stuck, timeoutMs: 20, retryDelayMs: 0 }).result('t1', { ok: true })).rejects.toThrow();
    expect(stuck).toHaveBeenCalledTimes(3);
  });
});
