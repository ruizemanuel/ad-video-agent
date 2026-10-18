// The pull loop. The VM asks the service for its next task every few seconds, does it with the handler of its kind and
// posts how it ended. It ends when the service says `shutdown` or at the deadline, and it survives an API that fails
// now and then: the service has its own timeout for each task, so a result that never arrives only costs the order that.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskEnvelope, VmTaskKind } from '@app/core';
import { describeError, VmApiError, type ResultBody, type VmApi } from './api';

/** Does a task and says how it went: the result the service gets, with `ok` and whatever else the kind reports. */
export type Handler = (task: TaskEnvelope) => Promise<ResultBody>;
/** One handler per kind of task but `shutdown`, which the worker answers itself. */
export type Handlers = Partial<Record<Exclude<VmTaskKind, 'shutdown'>, Handler>>;

export type WorkerOptions = {
  api: VmApi;
  handlers: Handlers;
  pollMs?: number;
  /** When to stop looking for tasks, in ms since the epoch. A task already running is let finish. */
  deadline: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
};

/** Where this VM keeps what it makes: the capture is taken once and read by the tasks that follow. */
export function getRunDir(): string {
  return join(tmpdir(), 'ad-video-agent-run');
}

const MAX_MESSAGE = 300;

const messageOf = (error: unknown): string => {
  const text = error instanceof Error ? error.message : 'Unknown error.';
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 3)}...` : text;
};

const isResult = (value: unknown): value is ResultBody => typeof value === 'object' && value !== null && typeof (value as { ok?: unknown }).ok === 'boolean';

export async function runWorker({
  api,
  handlers,
  pollMs = 3000,
  deadline,
  now = Date.now,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  log = (line) => console.log(`${new Date().toISOString()} ${line}`),
}: WorkerOptions): Promise<void> {
  const post = async (id: string, body: ResultBody): Promise<void> => {
    try {
      await api.result(id, body);
    } catch (error) {
      log(`The result of task ${id} could not be posted (${describeError(error)}).`);
    }
  };

  while (now() < deadline) {
    let task: TaskEnvelope | null;
    try {
      task = await api.next();
    } catch (error) {
      // A refused permit is final (it never was good, or it has expired): asking again for 55 minutes would change nothing.
      if (error instanceof VmApiError && error.status === 401) throw error;
      log(`Asking for a task failed (${describeError(error)}).`);
      task = null;
    }
    if (task === null) {
      await sleep(Math.max(0, Math.min(pollMs, deadline - now())));
      continue;
    }

    log(`Task ${task.id}: ${task.kind}.`);
    if (task.kind === 'shutdown') {
      await post(task.id, { ok: true });
      log('Shut down by the service.');
      return;
    }
    const handler = handlers[task.kind];
    let body: ResultBody;
    if (handler === undefined) {
      body = { ok: false, code: 'error', message: `This worker has no handler for ${task.kind} tasks.` };
    } else {
      try {
        const result: unknown = await handler(task);
        body = isResult(result) ? result : { ok: false, code: 'error', message: 'The task ended without a result.' };
      } catch (error) {
        body = { ok: false, code: 'error', message: messageOf(error) };
      }
    }
    log(`Task ${task.id} ${body.ok ? 'done' : 'failed'}.`);
    await post(task.id, body);
  }
  log('Deadline reached.');
}
