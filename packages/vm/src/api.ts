// The worker's side of the service's VM API: ask for the next task, post how it ended. The worker's only credential is
// the order's token, sent as a Bearer header; it is in no message the worker writes, and the address of a request is
// in none either (the ones of a presigned upload carry a signature).
import type { TaskEnvelope, VmTaskKind } from '@app/core';

export type ResultBody = { ok: boolean } & Record<string, unknown>;

export type VmApi = {
  /** The next task, or null when there is none yet (204). */
  next(): Promise<TaskEnvelope | null>;
  /** Says how a task ended. Tries again after a network error, so a lost answer does not leave the order waiting. */
  result(id: string, body: ResultBody): Promise<void>;
};

export class VmApiError extends Error {
  constructor(
    message: string,
    /** The HTTP status of the answer; none when the call never got one. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'VmApiError';
  }
}

export type VmApiOptions = {
  base: string;
  token: string;
  fetchImpl?: typeof fetch;
  /** For each call, not for all the attempts together. */
  timeoutMs?: number;
  /** The wait before the second attempt of a result post; the third waits twice as long. */
  retryDelayMs?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const RESULT_ATTEMPTS = 3;

const KINDS: ReadonlySet<string> = new Set<VmTaskKind>(['capture', 'keyframes', 'render', 'shutdown']);

/** What an error is, without what it says: a fetch error may quote the address it was fetching. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return typeof cause?.code === 'string' ? `${error.name} ${cause.code}` : error.name;
}

/** An answer that may be different next time: the server had a problem, or asked to be called later. */
const mayPass = (status: number): boolean => status >= 500 || status === 408 || status === 429;

export type SendOptions = { fetchImpl: typeof fetch; timeoutMs: number; attempts: number; retryDelayMs: number };

/**
 * One request with a timeout on every attempt. After a network error, a timeout or an answer that may pass (5xx, 408,
 * 429) it waits and tries again, up to `attempts`. It returns the last answer, or throws the last network error.
 */
export async function sendWithRetries(url: string, init: RequestInit, { fetchImpl, timeoutMs, attempts, retryDelayMs }: SendOptions): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (attempt >= attempts || !mayPass(response.status)) return response;
      await response.body?.cancel();
    } catch (error) {
      if (attempt >= attempts) throw error;
    }
    await new Promise((done) => setTimeout(done, retryDelayMs * attempt));
  }
}

function parseEnvelope(value: unknown): TaskEnvelope {
  const task = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const { id, kind, input, urls } = task;
  const urlsOk = typeof urls === 'object' && urls !== null && !Array.isArray(urls) && Object.values(urls).every((u) => typeof u === 'string');
  if (typeof id !== 'string' || id === '' || typeof kind !== 'string' || !KINDS.has(kind) || !urlsOk) {
    throw new VmApiError('The service sent a task the worker does not understand.');
  }
  return { id, kind: kind as VmTaskKind, input, urls: urls as Record<string, string> };
}

export function createVmApi({ base, token, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, retryDelayMs = DEFAULT_RETRY_DELAY_MS }: VmApiOptions): VmApi {
  const root = base.replace(/\/+$/, '');
  const authorization = `Bearer ${token}`;
  // The global fetch is read when a call is made, not when the API is made.
  const send = (path: string, init: RequestInit, attempts: number): Promise<Response> =>
    sendWithRetries(`${root}${path}`, init, { fetchImpl: fetchImpl ?? fetch, timeoutMs, attempts, retryDelayMs }).catch((error: unknown) => {
      throw new VmApiError(`The call to the service failed (${describeError(error)}).`);
    });

  return {
    async next() {
      const response = await send('/api/vm/tasks/next', { method: 'GET', headers: { authorization, accept: 'application/json' } }, 1);
      if (response.status === 204) return null;
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new VmApiError(`The service answered ${response.status} to the poll for a task.`, response.status);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new VmApiError('The service sent a task that is not JSON.');
      }
      return parseEnvelope(body);
    },

    async result(id, body) {
      const response = await send(
        `/api/vm/tasks/${encodeURIComponent(id)}/result`,
        { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body) },
        RESULT_ATTEMPTS,
      );
      await response.body?.cancel();
      if (!response.ok) throw new VmApiError(`The service answered ${response.status} to a result.`, response.status);
    },
  };
}
