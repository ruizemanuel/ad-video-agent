// Waking the flow that waits for a task, for the two VM routes: the result route does it with what the VM says, the
// next route with a failure when it cannot give the task out.
import { resumeHook } from 'workflow/api';
import { HookNotFoundError } from 'workflow/errors';
import type { OrderStore, VmTask } from '../ports';

/** `gone` when no flow waits on the hook any more (it gave up, or it already has a result). Any other error is thrown. */
export async function wakeFlow(hookToken: string, result: unknown): Promise<'woken' | 'gone'> {
  try {
    await resumeHook(hookToken, result);
    return 'woken';
  } catch (error) {
    if (HookNotFoundError.is(error)) return 'gone';
    throw error;
  }
}

// The same shape as the failures the VM reports itself, so the flow reads it the same way. It says nothing of why.
const NOT_PREPARED = { ok: false, code: 'error', message: 'The task could not be given to the VM.' } as const;

/**
 * Ends a claimed task that cannot be given out as failed, and tells the flow, so the order does not wait out the
 * task's timeout for a task nobody will ever do. If the flow cannot be woken the task stays failed: the timeout is
 * what is left.
 */
export async function failUnpreparedTask(task: Pick<VmTask, 'id' | 'hookToken'>, store: Pick<OrderStore, 'finishTask'>): Promise<void> {
  if ((await store.finishTask(task.id, false, NOT_PREPARED)) === null) return;
  try {
    await wakeFlow(task.hookToken, NOT_PREPARED);
  } catch (error) {
    console.error('[vm_task_failure_not_delivered]', task.id, error instanceof Error ? error.name : typeof error);
  }
}
