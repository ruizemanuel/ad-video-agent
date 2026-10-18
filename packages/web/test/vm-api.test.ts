import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VmTaskKind } from '@app/core';
import { resumeHook } from 'workflow/api';
import { HookNotFoundError } from 'workflow/errors';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAdapters } from '../src/adapters';
import type { FileBlob } from '../src/adapters/fake/blob';
import { GET as nextTask } from '../src/app/api/vm/tasks/next/route';
import { POST as postResult } from '../src/app/api/vm/tasks/[taskId]/result/route';
import type { BlobPort, Order, VmTask } from '../src/ports';
import { issueVmToken, VM_TOKEN_MINUTES, vmTokenExpiry, vmTokenHash } from '../src/vm/token';
import { uploadUrlsFor } from '../src/vm/tasks';

// Resuming a hook needs a running workflow world; the routes are tested for what they ask of it.
vi.mock('workflow/api', () => ({ resumeHook: vi.fn() }));

// The routes read their settings and their adapters the way the service does: from the environment, once.
const dir = await mkdtemp(join(tmpdir(), 'vm-api-'));
vi.stubEnv('AD_AGENT_ADAPTERS', 'fake');
vi.stubEnv('FAKE_DIR', dir);
vi.stubEnv('PAYTO_ADDRESS', `0x${'1'.repeat(40)}`);
vi.stubEnv('LINK_SIGNING_SECRET', 's'.repeat(40));
vi.stubEnv('CRON_SECRET', 'c'.repeat(40));
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const { store, blob } = await getAdapters();
const fakeBlob = blob as FileBlob;

const MB = 1024 * 1024;
const BASE = 'https://ad-video-agent.example.com';

let counter = 0;
// An order the flow has started: paid and running, the way a VM finds it.
async function runningOrder(): Promise<Order> {
  const { order } = await store.createOrder({
    request: { url: 'https://example.com', audio: 'music' },
    network: 'eip155:42220',
    asset: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e',
    payer: '0x1234567890AbcdEF1234567890aBcdef12345678',
    amount: 5_000_000n,
    nonce: `0x${(++counter).toString(16).padStart(64, '0')}`,
    validAfter: 0n,
    validBefore: 1_790_000_000n,
  });
  await store.transition(order.id, 'paid');
  await store.transition(order.id, 'running');
  return order;
}

/** The permit the flow gives the VM: its hash is stored, and it expires at `expiresAt` (by default, as a new one does). */
async function permitFor(order: Order, expiresAt = vmTokenExpiry(new Date())): Promise<string> {
  const { token, hash } = issueVmToken();
  await store.setVmToken(order.id, hash, expiresAt);
  return token;
}
const aMinuteAgo = (): Date => new Date(Date.now() - 60_000);

const queue = (order: Order, kind: VmTaskKind, round = 0, input: unknown = {}): Promise<VmTask> =>
  store.enqueueTask({ orderId: order.id, kind, round, input, hookToken: `vmtask:${order.id}:${kind}:${round}` });

const bearer = (token: string): Request => new Request(`${BASE}/api/vm/tasks/next`, { headers: { authorization: `Bearer ${token}` } });
const NEXT = (req: Request) => nextTask(req);
const RESULT = (token: string | null, taskId: string, body: unknown) =>
  postResult(
    new Request(`${BASE}/api/vm/tasks/${taskId}/result`, {
      method: 'POST',
      headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ taskId }) },
  );
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

beforeEach(() => {
  vi.mocked(resumeHook).mockReset();
  vi.mocked(resumeHook).mockResolvedValue({} as Awaited<ReturnType<typeof resumeHook>>);
  fakeBlob.lastPresignGet = undefined;
  fakeBlob.lastPresignPut = undefined;
});

describe('the order token', () => {
  it('is 32 random bytes in base64url, and only its sha256 in hex is meant to be stored', () => {
    const { token, hash } = issueVmToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(vmTokenHash(token)).toBe(hash);
    expect(hash).not.toContain(token);
  });

  it('is new every time', () => {
    expect(issueVmToken().token).not.toBe(issueVmToken().token);
  });

  it('lives 75 minutes', () => {
    expect(VM_TOKEN_MINUTES).toBe(75);
    expect(vmTokenExpiry(new Date('2026-10-18T12:00:00Z')).toISOString()).toBe('2026-10-18T13:15:00.000Z');
  });

  it('stops working the moment it expires', async () => {
    const order = await runningOrder();
    const edge = new Date(Date.now() + 5_000);
    const token = await permitFor(order, edge);
    await queue(order, 'capture');
    // Just before: the token opens the order's tasks. At the expiry itself, it no longer does.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(edge.getTime() - 1) });
    try {
      expect((await NEXT(bearer(token))).status).toBe(200);
      vi.setSystemTime(edge);
      expect((await NEXT(bearer(token))).status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('uploadUrlsFor', () => {
  // Records every presign, so a task that gets several can be checked for each.
  const recorder = () => {
    const calls: unknown[][] = [];
    const port: Pick<BlobPort, 'presignPut' | 'presignGet'> = {
      presignPut: async (path, contentType, maxBytes, minutes) => (calls.push(['put', path, contentType, maxBytes, minutes]), `put:${path}`),
      presignGet: async (path, minutes) => (calls.push(['get', path, minutes]), `get:${path}`),
    };
    return { calls, deps: { blob: port } };
  };
  const task = (kind: VmTaskKind, round = 0, input: unknown = {}) => ({ orderId: 'ord_a', kind, round, input });

  it('gives a capture the place to write capture.json: 20 MB, 30 minutes', async () => {
    const { calls, deps } = recorder();
    expect(await uploadUrlsFor(task('capture'), deps)).toEqual({ captureJson: 'put:orders/ord_a/capture.json' });
    expect(calls).toEqual([['put', 'orders/ord_a/capture.json', 'application/json', 20 * MB, 30]]);
  });

  it('gives keyframes the place for the file of their round: 30 MB, 30 minutes', async () => {
    const { calls, deps } = recorder();
    expect(await uploadUrlsFor(task('keyframes', 2), deps)).toEqual({ keyframesJson: 'put:orders/ord_a/keyframes-2.json' });
    expect(calls).toEqual([['put', 'orders/ord_a/keyframes-2.json', 'application/json', 30 * MB, 30]]);
  });

  it('gives a silent render only the place for the muted video', async () => {
    const { calls, deps } = recorder();
    const urls = await uploadUrlsFor(task('render', 0, { music: null }), deps);
    expect(urls).toEqual({ muted: 'put:orders/ord_a/out/hook-a-9x16-muted.mp4' });
    expect(calls).toEqual([['put', 'orders/ord_a/out/hook-a-9x16-muted.mp4', 'video/mp4', 200 * MB, 30]]);
  });

  it('gives a render with music both videos and a read of the chosen track', async () => {
    const { calls, deps } = recorder();
    const music = { firstBeat: 0.4, seconds: 21, path: 'orders/ord_a/music/cand-2.wav' };
    const urls = await uploadUrlsFor(task('render', 0, { music }), deps);
    expect(Object.keys(urls)).toEqual(['muted', 'withMusic', 'musicWav']);
    expect(urls).toEqual({
      muted: 'put:orders/ord_a/out/hook-a-9x16-muted.mp4',
      withMusic: 'put:orders/ord_a/out/hook-a-9x16.mp4',
      musicWav: 'get:orders/ord_a/music/cand-2.wav',
    });
    expect(calls).toEqual([
      ['put', 'orders/ord_a/out/hook-a-9x16-muted.mp4', 'video/mp4', 200 * MB, 30],
      ['put', 'orders/ord_a/out/hook-a-9x16.mp4', 'video/mp4', 200 * MB, 30],
      ['get', 'orders/ord_a/music/cand-2.wav', 30],
    ]);
  });

  it('gives shutdown nothing', async () => {
    const { calls, deps } = recorder();
    expect(await uploadUrlsFor(task('shutdown'), deps)).toEqual({});
    expect(calls).toEqual([]);
  });

  // The track is read from the path in the task: it must be one of this order's tracks, or the VM could be given a read of any file.
  it.each([
    ['another order', 'orders/ord_b/music/cand-1.wav'],
    ['the order but not its music', 'orders/ord_a/out/hook-a-9x16.mp4'],
    ['a path that climbs out of the music folder', 'orders/ord_a/music/../../ord_b/capture.json'],
    ['a path with a leading slash', '/orders/ord_a/music/cand-1.wav'],
    ['an empty path', ''],
  ])('refuses a track from %s, and presigns nothing', async (_label, path) => {
    const { calls, deps } = recorder();
    await expect(uploadUrlsFor(task('render', 0, { music: { firstBeat: 0, seconds: 20, path } }), deps)).rejects.toThrow(RangeError);
    expect(calls).toEqual([]);
  });
});

describe('GET /api/vm/tasks/next', () => {
  it('answers 401 without a valid, unexpired token, and hands out nothing', async () => {
    const order = await runningOrder();
    const task = await queue(order, 'capture');
    const expired = await permitFor(order, aMinuteAgo());
    for (const headers of [{}, { authorization: 'Bearer' }, { authorization: 'Basic abc' }, { authorization: `Bearer ${issueVmToken().token}` }, { authorization: `Bearer ${expired}` }, { authorization: `Bearer ${expired} extra` }]) {
      const res = await NEXT(new Request(`${BASE}/api/vm/tasks/next`, { headers }));
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await json(res)).toEqual({ error: 'unauthorized' });
    }
    expect((await store.getTask(task.id))?.status).toBe('pending');
  });

  it('gives the next task with fresh presigned URLs, then 204 when none is pending', async () => {
    const order = await runningOrder();
    const tok = await permitFor(order);
    const input = { url: 'https://example.com', extraUrls: [], followDemoLinks: 2 };
    const task = await queue(order, 'capture', 0, input);

    const res = await NEXT(bearer(tok));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const env = (await res.json()) as { id: string; kind: string; input: unknown; urls: Record<string, string> };
    expect(env.kind).toBe('capture');
    // Only what the VM needs: no hook token, no order id, nothing of the store.
    expect(Object.keys(env).sort()).toEqual(['id', 'input', 'kind', 'urls']);
    expect(env.id).toBe(task.id);
    expect(env.input).toEqual(input);
    expect(Object.keys(env.urls)).toEqual(['captureJson']);
    expect(fakeBlob.lastPresignPut).toEqual({ path: `orders/${order.id}/capture.json`, contentType: 'application/json', maxBytes: 20 * MB, minutes: 30 });
    expect((await store.getTask(task.id))?.status).toBe('claimed');

    expect((await NEXT(bearer(tok))).status).toBe(204);
  });

  it('hands the tasks over in the order they were queued, each once', async () => {
    const order = await runningOrder();
    const tok = await permitFor(order);
    await queue(order, 'capture');
    await queue(order, 'keyframes', 1);
    const first = (await (await NEXT(bearer(tok))).json()) as { kind: string };
    const second = (await json(await NEXT(bearer(tok)))) as { kind: string; urls: Record<string, string> };
    expect(first.kind).toBe('capture');
    expect(second.kind).toBe('keyframes');
    expect(Object.keys(second.urls)).toEqual(['keyframesJson']);
    expect(fakeBlob.lastPresignPut?.path).toBe(`orders/${order.id}/keyframes-1.json`);
    expect((await NEXT(bearer(tok))).status).toBe(204);
  });

  it('gives a render with music its three URLs', async () => {
    const order = await runningOrder();
    const tok = await permitFor(order);
    await queue(order, 'render', 0, { edl: {}, hook: 0, format: '9x16', music: { firstBeat: 0.5, seconds: 20, path: `orders/${order.id}/music/cand-1.wav` } });
    const env = (await json(await NEXT(bearer(tok)))) as { urls: Record<string, string> };
    expect(Object.keys(env.urls)).toEqual(['muted', 'withMusic', 'musicWav']);
    expect(fakeBlob.lastPresignGet).toEqual({ path: `orders/${order.id}/music/cand-1.wav`, minutes: 30 });
  });

  // A task that cannot be prepared (here, a render that names a track of another order) must not stay claimed for
  // ever: the flow is told that it failed at once, instead of waiting out its timeout.
  describe('a task whose URLs cannot be made', () => {
    const badRender = (order: Order) => queue(order, 'render', 0, { edl: {}, hook: 0, format: '9x16', music: { firstBeat: 0, seconds: 20, path: 'orders/ord_other/music/cand-1.wav' } });

    it('is marked failed, the flow is woken with the failure, and the VM gets a 500 that says nothing of the task', async () => {
      const order = await runningOrder();
      const tok = await permitFor(order);
      const bad = await badRender(order);
      const next = await queue(order, 'keyframes', 1);

      const res = await NEXT(bearer(tok));
      expect(res.status).toBe(500);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(JSON.stringify(await json(res))).not.toMatch(/ord_other|music|render/);

      const stored = await store.getTask(bad.id);
      expect(stored?.status).toBe('failed');
      expect(stored?.result).toEqual({ ok: false, code: 'error', message: expect.any(String) });
      expect(JSON.stringify(stored?.result)).not.toContain('ord_other');
      expect(resumeHook).toHaveBeenCalledWith(bad.hookToken, stored?.result);

      // It is not offered again, and the VM is not stuck behind it.
      const after = (await json(await NEXT(bearer(tok)))) as { id: string };
      expect(after.id).toBe(next.id);
    });

    it('is failed all the same when nobody waits for it any more', async () => {
      const order = await runningOrder();
      const tok = await permitFor(order);
      const bad = await badRender(order);
      vi.mocked(resumeHook).mockRejectedValueOnce(new HookNotFoundError('x'));
      expect((await NEXT(bearer(tok))).status).toBe(500);
      expect((await store.getTask(bad.id))?.status).toBe('failed');
    });

    it('is failed all the same when the flow cannot be woken', async () => {
      const order = await runningOrder();
      const tok = await permitFor(order);
      const bad = await badRender(order);
      vi.mocked(resumeHook).mockRejectedValueOnce(new Error('world unavailable'));
      const res = await NEXT(bearer(tok));
      expect(res.status).toBe(500);
      expect(JSON.stringify(await json(res))).not.toContain('world unavailable');
      expect((await store.getTask(bad.id))?.status).toBe('failed');
    });
  });

  it('shows a token only the tasks of its own order', async () => {
    const [a, b] = [await runningOrder(), await runningOrder()];
    const tokenB = await permitFor(b);
    const task = await queue(a, 'capture');
    expect((await NEXT(bearer(tokenB))).status).toBe(204);
    expect((await store.getTask(task.id))?.status).toBe('pending');
  });
});

describe('POST /api/vm/tasks/[taskId]/result', () => {
  // A task the VM has been given, with the token that was given with it.
  async function handedOut(kind: VmTaskKind = 'capture') {
    const order = await runningOrder();
    const token = await permitFor(order);
    const queued = await queue(order, kind);
    await store.claimNextTask(order.id);
    return { order, token, task: queued };
  }

  it('answers 401 without a valid, unexpired token, and keeps the task as it was', async () => {
    const { order, task } = await handedOut();
    const expired = await permitFor(order, aMinuteAgo());
    for (const token of [null, issueVmToken().token, expired]) {
      const res = await RESULT(token, task.id, { ok: true });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
    }
    expect((await store.getTask(task.id))?.status).toBe('claimed');
    expect(resumeHook).not.toHaveBeenCalled();
  });

  it('rejects a result for a task of another order with 403', async () => {
    const mine = await handedOut();
    const theirs = await handedOut();
    const res = await RESULT(mine.token, theirs.task.id, { ok: true });
    expect(res.status).toBe(403);
    expect((await store.getTask(theirs.task.id))?.status).toBe('claimed');
    expect(resumeHook).not.toHaveBeenCalled();
  });

  it.each([['a task that does not exist', '0a1b2c3d-0000-4000-8000-000000000000'], ['an id that is not even an id', '..%2F..%2Fx']])('answers 404 for %s', async (_label, id) => {
    const { token } = await handedOut();
    expect((await RESULT(token, id, { ok: true })).status).toBe(404);
    expect(resumeHook).not.toHaveBeenCalled();
  });

  it('stores a result and resumes the task hook; a repeated post is harmless', async () => {
    const { token, task } = await handedOut();
    const first = await RESULT(token, task.id, { ok: true });
    expect(first.status).toBe(200);
    expect(await json(first)).toEqual({ ok: true });
    expect(resumeHook).toHaveBeenCalledWith(task.hookToken, { ok: true });
    const stored = await store.getTask(task.id);
    expect(stored?.status).toBe('done');
    expect(stored?.result).toEqual({ ok: true });

    vi.mocked(resumeHook).mockRejectedValueOnce(new HookNotFoundError('x'));
    const again = await RESULT(token, task.id, { ok: true });
    expect(again.status).toBe(200);
    expect(await json(again)).toEqual({ duplicate: true });
  });

  it('keeps a failed result as failed, and still wakes the flow with it', async () => {
    const { token, task } = await handedOut('keyframes');
    const failure = { ok: false, code: 'error', message: 'Chrome did not start' };
    expect((await RESULT(token, task.id, failure)).status).toBe(200);
    expect(resumeHook).toHaveBeenCalledWith(task.hookToken, failure);
    expect((await store.getTask(task.id))?.status).toBe('failed');
  });

  it('counts only the first result: a later, different one changes nothing', async () => {
    const { token, task } = await handedOut();
    await RESULT(token, task.id, { ok: true, sections: 6 });
    vi.mocked(resumeHook).mockClear();
    vi.mocked(resumeHook).mockRejectedValueOnce(new HookNotFoundError('x'));
    expect((await RESULT(token, task.id, { ok: false, code: 'error', message: 'late' })).status).toBe(200);
    expect((await store.getTask(task.id))?.status).toBe('done');
    expect((await store.getTask(task.id))?.result).toEqual({ ok: true, sections: 6 });
    // If the flow is still there to hear it, it hears the first result again, never the late one.
    expect(resumeHook).toHaveBeenCalledWith(task.hookToken, { ok: true, sections: 6 });
  });

  it('answers 502 when the flow cannot be woken, and wakes it on the retry', async () => {
    const { token, task } = await handedOut();
    vi.mocked(resumeHook).mockRejectedValueOnce(new Error('world unavailable'));
    const failed = await RESULT(token, task.id, { ok: true });
    expect(failed.status).toBe(502);
    expect(JSON.stringify(await json(failed))).not.toContain('world unavailable');
    // The result is kept, so the VM only has to say it again.
    expect((await store.getTask(task.id))?.status).toBe('done');
    const retry = await RESULT(token, task.id, { ok: true });
    expect(retry.status).toBe(200);
    expect(await json(retry)).toEqual({ ok: true });
    expect(resumeHook).toHaveBeenCalledTimes(2);
  });

  it('answers 409 for a task the VM was never given', async () => {
    const order = await runningOrder();
    const token = await permitFor(order);
    const task = await queue(order, 'capture');
    expect((await RESULT(token, task.id, { ok: true })).status).toBe(409);
    expect((await store.getTask(task.id))?.status).toBe('pending');
    expect(resumeHook).not.toHaveBeenCalled();
  });

  it.each([
    ['not JSON', '{nope'],
    ['not an object', '[1]'],
    ['an object with no ok', '{"code":"error"}'],
    ['an ok that is not a boolean', '{"ok":"yes"}'],
  ])('answers 400 for a body that is %s, and keeps the task claimed', async (_label, body) => {
    const { token, task } = await handedOut();
    expect((await RESULT(token, task.id, body)).status).toBe(400);
    expect((await store.getTask(task.id))?.status).toBe('claimed');
    expect(resumeHook).not.toHaveBeenCalled();
  });

  it('answers 413 for a body far larger than any result', async () => {
    const { token, task } = await handedOut();
    expect((await RESULT(token, task.id, { ok: true, message: 'x'.repeat(100_000) })).status).toBe(413);
    expect((await store.getTask(task.id))?.status).toBe('claimed');
  });
});
