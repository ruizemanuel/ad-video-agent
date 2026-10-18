// Writing a file to the private blob store through the presigned URL the task came with. The VM holds no credentials
// for the store: the URL is made for one path, one content type and one size limit, and it is the only way in.
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
 * PUTs `body` to a presigned URL of the private store. A network error or a 5xx is tried again (up to 3 attempts); any
 * other refusal is final. The errors say the status, never the URL: it carries the signature.
 */
export async function uploadToPresigned(url: string, body: string | Uint8Array, contentType: string, options: UploadOptions = {}): Promise<void> {
  // Bytes, not text: a string body would make fetch add a text/plain header of its own to a file of another type.
  const bytes = typeof body === 'string' ? Buffer.from(body) : body;
  let response: Response;
  try {
    response = await sendWithRetries(
      url,
      {
        method: 'PUT',
        headers: { 'x-api-version': '13', 'x-vercel-blob-access': 'private', 'x-content-type': contentType },
        body: bytes as BodyInit,
      },
      { fetchImpl: options.fetchImpl ?? fetch, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, attempts: ATTEMPTS, retryDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS },
    );
  } catch (error) {
    throw new Error(`The upload failed (${describeError(error)}).`);
  }
  await response.body?.cancel();
  if (!response.ok) throw new Error(`The upload was refused (HTTP ${response.status}).`);
}
