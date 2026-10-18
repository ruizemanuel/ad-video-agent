// Reading a file from the private blob store through the presigned URL the task came with (the music a render mixes
// in). Like the upload, the URL is the only way in, and the errors never quote it: it carries the signature.
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { describeError, sendWithRetries } from './api';

export type DownloadOptions = {
  fetchImpl?: typeof fetch;
  /** For each attempt, the transfer of the file included. */
  timeoutMs?: number;
  retryDelayMs?: number;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const ATTEMPTS = 3;

/**
 * GETs a presigned URL into the file `dest` and says how many bytes it holds. A network error or a 5xx before the file
 * starts coming is tried again (up to 3 attempts); any other refusal, and a transfer that breaks halfway, is final.
 * The file is written as it arrives, not held in memory.
 */
export async function downloadToFile(url: string, dest: string, options: DownloadOptions = {}): Promise<number> {
  let response: Response;
  try {
    response = await sendWithRetries(
      url,
      { method: 'GET' },
      { fetchImpl: options.fetchImpl ?? fetch, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, attempts: ATTEMPTS, retryDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS },
    );
  } catch (error) {
    throw new Error(`The download failed (${describeError(error)}).`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`The download was refused (HTTP ${response.status}).`);
  }
  if (!response.body) throw new Error('The download came back empty.');
  const out = createWriteStream(dest);
  try {
    // The DOM type of fetch's stream and the one of node:stream/web are the same stream.
    await pipeline(Readable.fromWeb(response.body as NodeReadableStream), out);
  } catch (error) {
    throw new Error(`The download failed (${describeError(error)}).`);
  }
  return out.bytesWritten;
}
