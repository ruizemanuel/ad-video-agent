// POST /api/vm/tasks/<taskId>/result: the VM says how a task it was given ended: a JSON object with `ok: true|false`
// and whatever else the kind of task reports. The result is kept (only the first one counts) and the task's hook is
// resumed, which wakes the order's flow. The VM may say it again if it did not hear the answer, so a repeat is harmless:
// it wakes the flow once more with the first result, or finds nobody waiting.
import { getAdapters } from '../../../../../../adapters';
import { wakeFlow } from '../../../../../../vm/wake';
import { authenticate, NO_STORE, refuse } from '../../../auth';

// A result is a few fields; the files it talks about went to the blob store.
const MAX_BODY_BYTES = 64 * 1024;
// The ids the store makes. Anything else is no task, and does not reach the store.
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The body as text, or null as soon as it is longer than `max` bytes: the rest is not read. */
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (req.body === null) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function POST(req: Request, ctx: { params: Promise<{ taskId: string }> }): Promise<Response> {
  const { store } = await getAdapters();
  const who = await authenticate(req, store);
  if ('refusal' in who) return who.refusal;

  const { taskId } = await ctx.params;
  const task = TASK_ID.test(taskId) ? await store.getTask(taskId) : null;
  if (task === null) return refuse(404, 'No such task.');
  if (task.orderId !== who.order.id) return refuse(403, 'This task belongs to another order.');

  const text = await readCapped(req, MAX_BODY_BYTES);
  if (text === null) return refuse(413, 'This result is too large.');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body) || typeof (body as { ok?: unknown }).ok !== 'boolean') {
    return refuse(400, 'A result is a JSON object with "ok" set to true or false.');
  }

  // Null when the task is not `claimed` any more: it already has its result, and that one stands.
  const finished = await store.finishTask(task.id, (body as { ok: boolean }).ok, body);
  const settled = finished ?? (await store.getTask(task.id));
  if (settled === null || (settled.status !== 'done' && settled.status !== 'failed')) return refuse(409, 'This task was never handed out.');

  try {
    // `gone`: the flow is not waiting any more (it gave up, or it already has this result), and there is nothing left to do.
    if ((await wakeFlow(settled.hookToken, settled.result)) === 'gone') return Response.json({ duplicate: true }, { headers: NO_STORE });
  } catch (error) {
    // The result is kept; the VM only has to say it again. The message may quote the payload, so only the kind of error is logged.
    console.error('[vm_result_not_delivered]', task.id, error instanceof Error ? error.name : typeof error);
    return refuse(502, 'The result was kept, but the order could not be woken. Send it again.');
  }
  return Response.json({ ok: true }, { headers: NO_STORE });
}
