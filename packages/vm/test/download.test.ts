import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadToFile } from '../src/download';

const U = 'https://store.example/orders/o1/music/cand-1.wav?signature=SECRET';

describe('downloadToFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'download-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes what the store sends to the file, and says how many bytes', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));

    const bytes = await downloadToFile(U, join(dir, 'm.wav'), { fetchImpl });

    expect(bytes).toBe(4);
    expect(new Uint8Array(readFileSync(join(dir, 'm.wav')))).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(fetchImpl).toHaveBeenCalledWith(U, expect.objectContaining({ method: 'GET' }));
  });

  it('gives every attempt a timeout, a minute by default', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new Uint8Array([1]), { status: 200 }));

    await downloadToFile(U, join(dir, 'm.wav'), { fetchImpl });

    expect(timeout).toHaveBeenCalledWith(60_000);
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    timeout.mockRestore();
  });

  it('tries again after a network error or a 5xx, up to three attempts', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError(`fetch failed ${U}`))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([7]), { status: 200 }));

    await downloadToFile(U, join(dir, 'm.wav'), { fetchImpl, retryDelayMs: 0 });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(readFileSync(join(dir, 'm.wav'))[0]).toBe(7);
  });

  it('fails with the status and without the address, which carries the signature', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('denied', { status: 403 }));

    const error = await downloadToFile(U, join(dir, 'm.wav'), { fetchImpl }).catch((e: unknown) => e);

    expect((error as Error).message).toBe('The download was refused (HTTP 403).');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails without the address when the store cannot be reached', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError(`fetch failed ${U}`));

    const error = await downloadToFile(U, join(dir, 'm.wav'), { fetchImpl, retryDelayMs: 0 }).catch((e: unknown) => e);

    expect((error as Error).message).toBe('The download failed (TypeError).');
  });

  it('fails when the answer has no content', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));

    const error = await downloadToFile(U, join(dir, 'm.wav'), { fetchImpl }).catch((e: unknown) => e);

    expect((error as Error).message).toMatch(/empty/);
  });

  it('fails, without the address, when the connection drops in the middle of the file', async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.error(new TypeError(`terminated ${U}`));
      },
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(broken, { status: 200 }));

    const error = await downloadToFile(U, join(dir, 'm.wav'), { fetchImpl }).catch((e: unknown) => e);

    expect((error as Error).message).toBe('The download failed (TypeError).');
  });
});
