import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadToPresigned } from '../src/upload';

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
