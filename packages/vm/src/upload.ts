// Writing a file to the private blob store through the presigned URL the task came with. The VM holds no credentials
// for the store: the URL is made for one path, one content type and one size limit, and it is the only way in.
import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { describeError, sendWithRetries } from './api';

export type UploadOptions = {
  fetchImpl?: typeof fetch;
  /** For each attempt. A render can be 200 MB, so it is long. */
  timeoutMs?: number;
  retryDelayMs?: number;
};

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_RETRY_DELAY_MS = 2_000;
const ATTEMPTS = 3;

/**
 * Whether the store refused a write because the blob is already there. The presigned URLs are made with
 * `allowOverwrite: false`, so a second write to the path is refused: measured against the real private store on
 * 17/10/2026, it answers HTTP 400 and says the blob "already exists". Neither the SDK (@vercel/blob 2.8.2) nor its docs
 * give the status or the wording of this refusal, and the exact body was not kept, so both the status and the words are
 * checked: any other 400 is a real refusal, and a body worded differently would only bring back the old behavior (the
 * upload fails), never a false success.
 */
async function blobAlreadyExists(response: Response): Promise<boolean> {
  if (response.status !== 400) return false;
  const text = await response.text().catch(() => '');
  return /already exists/i.test(text);
}

/**
 * The name of the file a presigned URL writes (`capture.json`, `hook-a-9x16.mp4`): what the log may say of it. Nothing
 * else of the URL goes there, neither its host nor its folder (the order) nor its query (the signature).
 */
function fileKind(url: string): string {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? '');
    return /^[A-Za-z0-9._-]{1,64}$/.test(name) ? name : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * One PUT to a presigned URL of the private store, tried again after a network error or a 5xx (up to 3 attempts); any
 * other refusal is final. The errors say the status, never the URL: it carries the signature.
 *
 * A try again can find the write already done: the first PUT landed but its answer was lost (a timeout, a dropped
 * connection, a 5xx from a proxy), which is likelier the bigger the file. The store then refuses the second PUT because
 * the blob exists (see blobAlreadyExists). From the second attempt on, that refusal counts as done: the path is this
 * task's own, written only by this upload. On the first attempt it stays a refusal. A write counted done this way leaves
 * a line in the log, with the file's name and nothing else of the URL.
 */
async function put(url: string, body: Uint8Array | Blob, contentType: string, options: UploadOptions): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let sent = 0;
  const counted: typeof fetch = (input, init) => {
    sent++;
    return fetchImpl(input, init);
  };
  let response: Response;
  try {
    response = await sendWithRetries(
      url,
      {
        method: 'PUT',
        headers: { 'x-api-version': '13', 'x-vercel-blob-access': 'private', 'x-content-type': contentType },
        body: body as BodyInit,
      },
      { fetchImpl: counted, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, attempts: ATTEMPTS, retryDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS },
    );
  } catch (error) {
    throw new Error(`The upload failed (${describeError(error)}).`);
  }
  if (!response.ok && sent >= 2 && (await blobAlreadyExists(response))) {
    console.warn('[blob_exists]', fileKind(url));
    return;
  }
  // blobAlreadyExists reads the body of the refusals it looks at.
  if (!response.bodyUsed) await response.body?.cancel();
  if (!response.ok) throw new Error(`The upload was refused (HTTP ${response.status}).`);
}

/** PUTs `body` to a presigned URL of the private store (see `put` for the retries). The body is sent as bytes. */
export async function uploadToPresigned(url: string, body: string | Uint8Array, contentType: string, options: UploadOptions = {}): Promise<void> {
  // Bytes, not text: a string body would make fetch add a text/plain header of its own to a file of another type.
  await put(url, typeof body === 'string' ? Buffer.from(body) : body, contentType, options);
}

/**
 * PUTs the file at `path` to a presigned URL of the private store (see `put` for the retries). The file is streamed
 * from the disk as it is sent, never held in memory whole (a render can be 200 MB, and the VM has 4 GiB for Chrome as
 * well): a file-backed Blob is read as fetch sends it, and can be sent again on a retry.
 */
export async function uploadFileToPresigned(url: string, path: string, contentType: string, options: UploadOptions = {}): Promise<void> {
  let file: Blob;
  try {
    file = await openAsBlob(path);
  } catch (error) {
    throw new Error(`The upload could not read the file ${basename(path)} (${describeError(error)}).`);
  }
  await put(url, file, contentType, options);
}
