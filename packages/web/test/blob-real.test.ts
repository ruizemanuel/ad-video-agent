// The Vercel Blob adapter, checked without a store or a token: the SDK's network calls (put, list, del and the
// request for a signed token) are replaced, and everything that does not need the network stays real. That includes
// presignUrl, which signs on this side and checks what it is given against the scope of the token it is handed.
// The stand-in for issueSignedToken builds that scope from the options the adapter sends, as the Blob API does.
import type { IssueSignedTokenOptions } from '@vercel/blob';
import * as sdk from '@vercel/blob';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BLOB_READ_TIMEOUT_MS, VercelBlob } from '../src/adapters/real/blob';

vi.mock('@vercel/blob', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vercel/blob')>()),
  put: vi.fn(),
  list: vi.fn(),
  del: vi.fn(),
  issueSignedToken: vi.fn(),
}));

const TOKEN = 'vercel_blob_rw_store123_secretpart';
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const MINUTE = 60_000;

const issued = () => vi.mocked(sdk.issueSignedToken);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  issued().mockImplementation(async (options: IssueSignedTokenOptions) => {
    const { pathname, operations, validUntil, allowedContentTypes, maximumSizeInBytes } = options;
    const scope = JSON.stringify({ storeId: 'store_store123', pathname, operations, validUntil, allowedContentTypes, maximumSizeInBytes });
    return { delegationToken: `${Buffer.from(scope).toString('base64url')}.signature`, clientSigningToken: 'client-signing-token', validUntil: validUntil as number };
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe('VercelBlob.put', () => {
  it('writes a private blob at exactly that path, replacing what is there', async () => {
    await new VercelBlob(TOKEN).put('orders/ord_a/out/claims.md', 'text', 'text/markdown');
    expect(sdk.put).toHaveBeenCalledOnce();
    const [path, , options] = vi.mocked(sdk.put).mock.calls[0] ?? [];
    expect(path).toBe('orders/ord_a/out/claims.md');
    expect(options).toEqual({
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'text/markdown',
      token: TOKEN,
    });
  });

  it('sends a string and bytes as the same bytes, and reports their length', async () => {
    const blob = new VercelBlob(TOKEN);
    expect(await blob.put('a', 'héllo', 'text/plain')).toEqual({ bytes: 6 });
    expect(await blob.put('b', Uint8Array.from([1, 2, 3]).subarray(1), 'application/octet-stream')).toEqual({ bytes: 2 });
    const [, textBody] = vi.mocked(sdk.put).mock.calls[0] ?? [];
    const [, bytesBody] = vi.mocked(sdk.put).mock.calls[1] ?? [];
    expect(Buffer.from(textBody as string).toString()).toBe('héllo');
    expect([...(bytesBody as Buffer)]).toEqual([2, 3]);
  });
});

describe('VercelBlob.presignGet', () => {
  it('asks for a token that only reads that path and lasts the minutes given', async () => {
    const url = await new VercelBlob(TOKEN).presignGet('orders/ord_a/out/hook-a-9x16.mp4', 10);
    expect(issued()).toHaveBeenCalledWith({
      token: TOKEN,
      pathname: 'orders/ord_a/out/hook-a-9x16.mp4',
      operations: ['get'],
      validUntil: NOW + 10 * MINUTE,
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://store123.private.blob.vercel-storage.com');
    expect(parsed.pathname).toBe('/orders/ord_a/out/hook-a-9x16.mp4');
    expect(parsed.searchParams.get('vercel-blob-delegation')).toBeTruthy();
    expect(parsed.searchParams.get('vercel-blob-signature')).toBeTruthy();
  });

  it('asks the store to send the file as an attachment when it is to be saved, and only then', async () => {
    const blob = new VercelBlob(TOKEN);
    const saved = new URL(await blob.presignGet('orders/ord_a/out/hook-a-9x16.mp4', 10, { attachment: true }));
    expect(saved.searchParams.get('download')).toBe('1');
    expect(saved.searchParams.get('vercel-blob-signature')).toBeTruthy();
    expect(new URL(await blob.presignGet('orders/ord_a/out/hook-a-9x16.mp4', 10)).searchParams.has('download')).toBe(false);
  });

  it('fails if the token is not for that path, which the SDK checks', async () => {
    issued().mockImplementationOnce(async () => ({
      delegationToken: `${Buffer.from(JSON.stringify({ storeId: 'store_store123', pathname: 'other', operations: ['get'], validUntil: NOW + MINUTE })).toString('base64url')}.signature`,
      clientSigningToken: 'k',
      validUntil: NOW + MINUTE,
    }));
    await expect(new VercelBlob(TOKEN).presignGet('orders/ord_a/out/claims.md', 1)).rejects.toThrow('scope');
  });
});

describe('VercelBlob.presignPut', () => {
  it('asks for a token that only writes that path, one content type, one size limit and the minutes given', async () => {
    const url = await new VercelBlob(TOKEN).presignPut('orders/ord_a/capture.json', 'application/json', 5_000_000, 30);
    expect(issued()).toHaveBeenCalledWith({
      token: TOKEN,
      pathname: 'orders/ord_a/capture.json',
      operations: ['put'],
      validUntil: NOW + 30 * MINUTE,
      allowedContentTypes: ['application/json'],
      maximumSizeInBytes: 5_000_000,
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('pathname')).toBe('orders/ord_a/capture.json');
    expect(parsed.searchParams.get('vercel-blob-allowed-content-types')).toBe('application/json');
    expect(parsed.searchParams.get('vercel-blob-maximum-size-in-bytes')).toBe('5000000');
  });

  it('never lets the URL overwrite: a second upload to it must fail', async () => {
    const url = await new VercelBlob(TOKEN).presignPut('orders/ord_a/capture.json', 'application/json', 1000, 5);
    expect(new URL(url).searchParams.get('vercel-blob-allow-overwrite')).toBe('false');
  });

  it('signs the URL: it carries the delegation and the signature', async () => {
    const url = new URL(await new VercelBlob(TOKEN).presignPut('orders/ord_a/out/hook-a-9x16.mp4', 'video/mp4', 50_000_000, 30));
    expect(url.searchParams.get('vercel-blob-delegation')).toBeTruthy();
    expect(url.searchParams.get('vercel-blob-signature')).toBeTruthy();
  });
});

describe('the minutes of a presigned URL', () => {
  it.each([[0], [-5], [Number.NaN], [Number.POSITIVE_INFINITY]])('refuses %s, before it asks for a token', async (minutes) => {
    const blob = new VercelBlob(TOKEN);
    await expect(blob.presignGet('orders/ord_a/capture.json', minutes)).rejects.toThrow('minutes');
    await expect(blob.presignPut('orders/ord_a/capture.json', 'application/json', 1000, minutes)).rejects.toThrow('minutes');
    expect(issued()).not.toHaveBeenCalled();
  });

  it('rounds a fraction of a minute to a whole millisecond, which is what the SDK asks for', async () => {
    await new VercelBlob(TOKEN).presignGet('orders/ord_a/capture.json', 0.0000123456);
    const [{ validUntil }] = issued().mock.calls[0] ?? [{}];
    expect(Number.isInteger(validUntil)).toBe(true);
  });
});

describe('VercelBlob.get', () => {
  it('reads the blob through a presigned read of 2 minutes', async () => {
    const fetchMock = vi.fn(async () => new Response(Uint8Array.from([7, 8, 9])));
    vi.stubGlobal('fetch', fetchMock);
    const bytes = await new VercelBlob(TOKEN).get('orders/ord_a/capture.json');
    expect(bytes).toEqual(Uint8Array.from([7, 8, 9]));
    expect(issued()).toHaveBeenCalledWith(expect.objectContaining({ pathname: 'orders/ord_a/capture.json', operations: ['get'], validUntil: NOW + 2 * MINUTE }));
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = (fetchMock.mock.calls[0] as unknown as [string]) ?? [];
    expect(new URL(url).pathname).toBe('/orders/ord_a/capture.json');
  });

  it('gives the read a time limit', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await new VercelBlob(TOKEN).get('orders/ord_a/capture.json');
    const ours = timeout.mock.calls.findIndex(([ms]) => ms === BLOB_READ_TIMEOUT_MS);
    expect(ours).toBeGreaterThanOrEqual(0);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(timeout.mock.results[ours]?.value);
    expect(BLOB_READ_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });

  it('fails with the path, and not the signed URL, when the read fails or runs out of time', async () => {
    for (const failure of [new DOMException('The operation was aborted due to timeout', 'TimeoutError'), new TypeError('fetch failed')]) {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => Promise.reject(Object.assign(failure, { url }))));
      const message = await new VercelBlob(TOKEN)
        .get('orders/ord_a/capture.json')
        .then(() => 'it did not fail')
        .catch((error: Error) => error.message);
      expect(message).toContain('orders/ord_a/capture.json');
      expect(message).toContain(failure.name);
      expect(message).not.toContain('https://');
    }
  });

  it('says which blob is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    await expect(new VercelBlob(TOKEN).get('orders/ord_a/capture.json')).rejects.toThrow('orders/ord_a/capture.json');
  });

  it('fails on any other error, with the path and the status but not the signed URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 403 })));
    const message = await new VercelBlob(TOKEN)
      .get('orders/ord_a/capture.json')
      .then(() => 'it did not fail')
      .catch((error: Error) => error.message);
    expect(message).toContain('orders/ord_a/capture.json');
    expect(message).toContain('403');
    expect(message).not.toContain('https://');
  });
});

describe('VercelBlob.deletePrefix', () => {
  const entry = (pathname: string) => ({ url: `https://store123.private.blob.vercel-storage.com/${pathname}`, downloadUrl: '', pathname, size: 1, uploadedAt: new Date(), etag: '' });

  it('lists every page under the prefix, deletes what it found and counts it', async () => {
    vi.mocked(sdk.list)
      .mockResolvedValueOnce({ blobs: [entry('orders/ord_a/capture.json'), entry('orders/ord_a/out/claims.md')], hasMore: true, cursor: 'next' })
      .mockResolvedValueOnce({ blobs: [entry('orders/ord_a/music/cand-0.wav')], hasMore: false });
    expect(await new VercelBlob(TOKEN).deletePrefix('orders/ord_a/')).toBe(3);
    expect(sdk.list).toHaveBeenNthCalledWith(1, { prefix: 'orders/ord_a/', token: TOKEN });
    expect(sdk.list).toHaveBeenNthCalledWith(2, { prefix: 'orders/ord_a/', cursor: 'next', token: TOKEN });
    const deleted = vi.mocked(sdk.del).mock.calls.flatMap(([urls]) => urls);
    expect(deleted).toEqual([
      'https://store123.private.blob.vercel-storage.com/orders/ord_a/capture.json',
      'https://store123.private.blob.vercel-storage.com/orders/ord_a/out/claims.md',
      'https://store123.private.blob.vercel-storage.com/orders/ord_a/music/cand-0.wav',
    ]);
    for (const [, options] of vi.mocked(sdk.del).mock.calls) expect(options).toEqual({ token: TOKEN });
  });

  it('deletes nothing and says 0 when nothing matches', async () => {
    vi.mocked(sdk.list).mockResolvedValueOnce({ blobs: [], hasMore: false });
    expect(await new VercelBlob(TOKEN).deletePrefix('orders/ord_none/')).toBe(0);
    expect(sdk.del).not.toHaveBeenCalled();
  });

  it('refuses an empty prefix before it asks the store anything', async () => {
    await expect(new VercelBlob(TOKEN).deletePrefix('')).rejects.toThrow('prefix');
    expect(sdk.list).not.toHaveBeenCalled();
    expect(sdk.del).not.toHaveBeenCalled();
  });
});
