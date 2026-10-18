import type { TaskEnvelope } from '@app/core';
import { describe, expect, it, vi } from 'vitest';
import { createVmApi, VmApiError } from '../src/api';

const TOKEN = 'tok_secret-value';
const envelope: TaskEnvelope = { id: 'a1', kind: 'capture', input: { url: 'https://x.example' }, urls: { captureJson: 'https://blob.example/put?sig=1' } };

const api = (fetchImpl: typeof fetch, over: { base?: string; retryDelayMs?: number } = {}) =>
  createVmApi({ base: over.base ?? 'https://api.example', token: TOKEN, fetchImpl, retryDelayMs: over.retryDelayMs ?? 0 });

describe('next', () => {
  it('asks for the next task with the permit and reads the envelope', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(envelope));

    expect(await api(fetchImpl).next()).toEqual(envelope);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example/api/vm/tasks/next',
      expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ authorization: `Bearer ${TOKEN}` }) }),
    );
  });

  it('gets null when there is no task yet (204)', async () => {
    expect(await api(async () => new Response(null, { status: 204 })).next()).toBeNull();
  });

  it('takes the address with a trailing slash', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    await api(fetchImpl, { base: 'https://api.example/' }).next();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.example/api/vm/tasks/next');
  });

  it('throws with the status of an answer that is neither a task nor 204, without the permit', async () => {
    const error = await api(async () => Response.json({ error: 'unauthorized' }, { status: 401 }))
      .next()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VmApiError);
    expect((error as VmApiError).status).toBe(401);
    expect((error as VmApiError).message).not.toContain(TOKEN);
  });

  it.each([
    ['not JSON', () => new Response('<html>', { status: 200 })],
    ['not an object', () => Response.json([1])],
    ['a task with no id', () => Response.json({ ...envelope, id: undefined })],
    ['a kind nobody knows', () => Response.json({ ...envelope, kind: 'mine-bitcoin' })],
    ['URLs that are not text', () => Response.json({ ...envelope, urls: { captureJson: 5 } })],
  ])('refuses an answer that is %s', async (_what, response) => {
    await expect(api(async () => response()).next()).rejects.toBeInstanceOf(VmApiError);
  });
});

describe('result', () => {
  it('posts the result as JSON, with the permit', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));

    await api(fetchImpl).result('a1', { ok: true, sections: 4 });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example/api/vm/tasks/a1/result',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ok: true, sections: 4 }),
        headers: expect.objectContaining({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }),
      }),
    );
  });

  it('tries again after a 5xx, 408 or 429', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: 'x' }, { status: 502 }))
      .mockResolvedValueOnce(Response.json({ error: 'x' }, { status: 429 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    await api(fetchImpl).result('a1', { ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each([400, 401, 403, 404, 409, 413])('does not try again after a %i: it would be the same answer', async (status) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ error: 'no' }, { status }));
    const error = await api(fetchImpl)
      .result('a1', { ok: true })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VmApiError);
    expect((error as VmApiError).status).toBe(status);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws after three 5xx answers', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ error: 'x' }, { status: 500 }));
    await expect(api(fetchImpl).result('a1', { ok: true })).rejects.toMatchObject({ status: 500 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('puts the id in the address as one path segment', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
    await api(fetchImpl).result('a/../b', { ok: true });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.example/api/vm/tasks/a%2F..%2Fb/result');
  });
});
