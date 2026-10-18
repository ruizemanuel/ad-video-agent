// GET /api/vm/tasks/next: the VM asks for its next task, with `Authorization: Bearer <permit>`. It gets the oldest task
// the order has pending, once, with freshly presigned URLs for the files that task reads and writes (200), or 204
// when there is none yet. If the task's URLs cannot be made, the task is ended as failed (and the flow told) and the VM
// gets a 500. The worker asks again every few seconds.
import type { TaskEnvelope } from '@app/core';
import { getAdapters } from '../../../../../adapters';
import { uploadUrlsFor } from '../../../../../vm/tasks';
import { failUnpreparedTask } from '../../../../../vm/wake';
import { authenticate, NO_STORE, refuse } from '../../auth';

export async function GET(req: Request): Promise<Response> {
  const { store, blob } = await getAdapters();
  const who = await authenticate(req, store);
  if ('refusal' in who) return who.refusal;

  const task = await store.claimNextTask(who.order.id);
  if (task === null) return new Response(null, { status: 204, headers: NO_STORE });
  let urls: Record<string, string>;
  try {
    urls = await uploadUrlsFor(task, { blob });
  } catch (error) {
    // The task is claimed, so nobody would ever be given it again: end it as failed and tell the flow. Only the kind of
    // error is logged (a presign error may quote the URL).
    console.error('[vm_task_not_prepared]', task.id, error instanceof Error ? error.name : typeof error);
    await failUnpreparedTask(task, store);
    return refuse(500, 'This task could not be prepared.');
  }
  // Only what the VM needs: the task's own id, its kind, what it is to do and where to put what it makes.
  const envelope: TaskEnvelope = { id: task.id, kind: task.kind, input: task.input, urls };
  return Response.json(envelope, { headers: NO_STORE });
}
