// GET /api/vm/tasks/next: the VM asks for its next task, with `Authorization: Bearer <permit>`. It gets the oldest task
// the order has pending, once, with freshly presigned URLs for the files that task reads and writes (200), or 204
// when there is none yet. The worker asks again every few seconds.
import type { TaskEnvelope } from '@app/core';
import { getAdapters } from '../../../../../adapters';
import { uploadUrlsFor } from '../../../../../vm/tasks';
import { authenticate, NO_STORE } from '../../auth';

export async function GET(req: Request): Promise<Response> {
  const { store, blob } = await getAdapters();
  const who = await authenticate(req, store);
  if ('refusal' in who) return who.refusal;

  const task = await store.claimNextTask(who.order.id);
  if (task === null) return new Response(null, { status: 204, headers: NO_STORE });
  // Only what the VM needs: the task's own id, its kind, what it is to do and where to put what it makes.
  const envelope: TaskEnvelope = { id: task.id, kind: task.kind, input: task.input, urls: await uploadUrlsFor(task, { blob }) };
  return Response.json(envelope, { headers: NO_STORE });
}
