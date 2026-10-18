// The BlobPort on a private Vercel Blob store. Nothing in it is public: reading goes through a signed URL, and a
// signed URL is made the way the spike did it (a delegated token for one path, then `presignUrl`), so the VM and
// the client never hold the store's token.
import { del, issueSignedToken, list, presignUrl, put as putBlob } from '@vercel/blob';
import type { BlobPort } from '../../ports';

const MINUTE_MS = 60_000;
// The read URL `get` makes for itself: it is used at once.
const OWN_READ_MINUTES = 2;

export class VercelBlob implements BlobPort {
  constructor(private readonly token: string) {}

  async put(path: string, body: Uint8Array | string, contentType: string): Promise<{ bytes: number }> {
    // The SDK takes a Buffer, not a Uint8Array. This one views the same memory, with the offset of a subarray.
    const data = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    await putBlob(path, data, { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType, token: this.token });
    return { bytes: data.byteLength };
  }

  async get(path: string): Promise<Uint8Array> {
    const response = await fetch(await this.presignGet(path, OWN_READ_MINUTES));
    if (response.status === 404) throw new Error(`The blob ${path} does not exist.`);
    // The message leaves out the URL: it carries a signature.
    if (!response.ok) throw new Error(`The blob ${path} could not be read (HTTP ${response.status}).`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async presignGet(path: string, minutes: number): Promise<string> {
    const validUntil = this.expiry(minutes);
    const signed = await issueSignedToken({ token: this.token, pathname: path, operations: ['get'], validUntil });
    const { presignedUrl } = await presignUrl(signed, { operation: 'get', pathname: path, access: 'private', validUntil });
    return presignedUrl;
  }

  async presignPut(path: string, contentType: string, maxBytes: number, minutes: number): Promise<string> {
    const validUntil = this.expiry(minutes);
    const limits = { allowedContentTypes: [contentType], maximumSizeInBytes: maxBytes };
    const signed = await issueSignedToken({ token: this.token, pathname: path, operations: ['put'], validUntil, ...limits });
    // Overwriting is off, so a URL that leaks can write the path once and no more.
    const { presignedUrl } = await presignUrl(signed, { operation: 'put', pathname: path, access: 'private', validUntil, ...limits, allowOverwrite: false });
    return presignedUrl;
  }

  async deletePrefix(prefix: string): Promise<number> {
    if (prefix === '') throw new RangeError('deletePrefix needs a prefix: an empty one would delete every blob.');
    let deleted = 0;
    let cursor: string | undefined;
    // One page at a time, deleting as it goes: the pattern of the SDK's own documentation.
    do {
      const page = await list({ prefix, token: this.token, ...(cursor === undefined ? {} : { cursor }) });
      if (page.blobs.length > 0) {
        await del(
          page.blobs.map((blob) => blob.url),
          { token: this.token },
        );
        deleted += page.blobs.length;
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor !== undefined);
    return deleted;
  }

  /** The moment a signed URL stops working, in whole ms since the epoch, as the SDK asks. */
  private expiry(minutes: number): number {
    if (!Number.isFinite(minutes) || minutes <= 0) throw new RangeError(`A presigned URL needs a positive number of minutes; got ${minutes}.`);
    return Math.round(Date.now() + minutes * MINUTE_MS);
  }
}
