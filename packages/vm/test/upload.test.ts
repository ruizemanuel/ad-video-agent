import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadFileToPresigned, uploadToPresigned } from '../src/upload';

const U = 'https://store.example/orders/o1/capture.json?signature=SECRET';

afterEach(() => vi.unstubAllGlobals());

describe('uploadToPresigned', () => {
  it('uploads with the private-blob headers', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchImpl);

    await uploadToPresigned(U, 'x', 'application/json');

    expect(fetchImpl).toHaveBeenCalledWith(
      U,
      expect.objectContaining({
        method: 'PUT',
        headers: { 'x-api-version': '13', 'x-vercel-blob-access': 'private', 'x-content-type': 'application/json' },
      }),
    );
  });

  it('sends the bytes of the body, whether it is text or bytes, and gives the request a timeout', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));

    await uploadToPresigned(U, 'héllo', 'text/plain', { fetchImpl });
    await uploadToPresigned(U, new Uint8Array([1, 2, 3]), 'video/mp4', { fetchImpl });

    const [text, bytes] = fetchImpl.mock.calls.map((call) => new Uint8Array(call[1]?.body as Uint8Array));
    expect(text).toEqual(new TextEncoder().encode('héllo'));
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    for (const call of fetchImpl.mock.calls) expect(call[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('fails with the status and without the address, which carries the signature', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('denied', { status: 403 }));

    const error = await uploadToPresigned(U, 'x', 'application/json', { fetchImpl }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('403');
    expect((error as Error).message).not.toContain('SECRET');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('tries again after a network error or a 5xx, up to three attempts', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError(`fetch failed ${U}`))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await uploadToPresigned(U, 'x', 'application/json', { fetchImpl, retryDelayMs: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    const down = vi.fn<typeof fetch>().mockRejectedValue(new TypeError(`fetch failed ${U}`));
    const error = await uploadToPresigned(U, 'x', 'application/json', { fetchImpl: down, retryDelayMs: 0 }).catch((e: unknown) => e);
    expect(down).toHaveBeenCalledTimes(3);
    expect((error as Error).message).not.toContain('SECRET');
  });
});

// The store refuses a second write to a path, because the URLs are made with allowOverwrite false. Measured against the
// real private store on 17/10/2026: the second PUT to the same URL answers HTTP 400 and says the blob "already exists".
// The body below is in the shape the SDK parses ({error: {code, message}}), with words of our own around
// "already exists": the exact body was not kept.
const EXISTS = JSON.stringify({ error: { code: 'bad_request', message: 'This blob already exists, use `allowOverwrite: true` if you want to overwrite it.' } });
const exists = () => new Response(EXISTS, { status: 400 });

describe('a retry after a write that landed', () => {
  it('counts as done when the store says the blob exists, after a network error or a 5xx on the attempt before', async () => {
    for (const first of [() => Promise.reject(new TypeError('fetch failed')), () => Promise.resolve(new Response(null, { status: 502 }))]) {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce(first).mockImplementationOnce(async () => exists());

      await expect(uploadToPresigned(U, 'x', 'video/mp4', { fetchImpl, retryDelayMs: 0 })).resolves.toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  });

  it('leaves a line in the log that names the file it found there, and nothing of its address', async () => {
    const logged = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockImplementationOnce(async () => exists());

      await uploadToPresigned(U, 'x', 'application/json', { fetchImpl, retryDelayMs: 0 });

      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged).toHaveBeenCalledWith('[blob_exists]', 'capture.json');
      expect(JSON.stringify(logged.mock.calls)).not.toMatch(/SECRET|store\.example|o1/);
    } finally {
      logged.mockRestore();
    }
  });

  it('logs nothing for a write that lands at once', async () => {
    const logged = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await uploadToPresigned(U, 'x', 'application/json', { fetchImpl: vi.fn<typeof fetch>(async () => new Response(null, { status: 200 })) });
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it('counts as done on the third attempt too', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockImplementationOnce(async () => exists());

    await expect(uploadToPresigned(U, 'x', 'video/mp4', { fetchImpl, retryDelayMs: 0 })).resolves.toBeUndefined();
  });

  it('does not count on the first attempt: nobody of ours wrote what is there', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => exists());

    const error = await uploadToPresigned(U, 'x', 'video/mp4', { fetchImpl, retryDelayMs: 0 }).catch((e: unknown) => e);

    expect((error as Error).message).toContain('400');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not count when the refusal is for something else, whatever the attempt', async () => {
    for (const refusal of [
      new Response(JSON.stringify({ error: { code: 'bad_request', message: 'The file is not what the URL allows.' } }), { status: 400 }),
      new Response(EXISTS, { status: 403 }),
      new Response('', { status: 400 }),
    ]) {
      const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(refusal);

      const error = await uploadToPresigned(U, 'x', 'video/mp4', { fetchImpl, retryDelayMs: 0 }).catch((e: unknown) => e);

      expect((error as Error).message).toMatch(/refused \(HTTP (400|403)\)/);
      expect((error as Error).message).not.toContain('SECRET');
    }
  });
});

describe('uploadFileToPresigned', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const fileWith = (bytes: Uint8Array): string => {
    const dir = mkdtempSync(join(tmpdir(), 'upload-'));
    dirs.push(dir);
    const path = join(dir, 'hook.mp4');
    writeFileSync(path, bytes);
    return path;
  };

  it('sends the bytes of the file with its type and size, without reading it into memory first', async () => {
    const path = fileWith(new Uint8Array([1, 2, 3, 4, 5]));
    const sent: { headers?: HeadersInit; body?: unknown; bytes?: Uint8Array } = {};
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      sent.headers = init?.headers;
      sent.body = init?.body;
      sent.bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
      return new Response(null, { status: 200 });
    });

    await uploadFileToPresigned(U, path, 'video/mp4', { fetchImpl });

    expect(sent.headers).toEqual({ 'x-api-version': '13', 'x-vercel-blob-access': 'private', 'x-content-type': 'video/mp4' });
    // A file-backed Blob: fetch reads it as it sends it, and it can be sent again.
    expect(sent.body).toBeInstanceOf(Blob);
    expect(sent.bytes).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('sends the whole file again on a retry', async () => {
    const path = fileWith(new Uint8Array([9, 8, 7]));
    const bodies: Uint8Array[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(new Uint8Array(await new Response(init?.body).arrayBuffer()));
      return new Response(null, { status: bodies.length === 1 ? 502 : 200 });
    });

    await uploadFileToPresigned(U, path, 'video/mp4', { fetchImpl, retryDelayMs: 0 });

    expect(bodies).toEqual([new Uint8Array([9, 8, 7]), new Uint8Array([9, 8, 7])]);
  });

  it('fails, without the address, when the file is not there', async () => {
    const error = await uploadFileToPresigned(U, join(tmpdir(), 'no-such-dir', 'hook.mp4'), 'video/mp4', { fetchImpl: vi.fn<typeof fetch>() }).catch((e: unknown) => e);

    expect((error as Error).message).toMatch(/could not read the file/);
    expect((error as Error).message).not.toContain('SECRET');
  });
});
