// The worker's entry point, started by the VM's boot script: `API_BASE=<service> VM_TOKEN=<order permit> node --import
// tsx src/main.ts`, from this folder. It asks the service for tasks for up to 55 minutes (the VM is rented for an
// hour) and does them. The permit is read once and taken out of the environment: it is never printed, and no program
// the worker starts inherits it.
import { createVmApi } from './api';
import { captureTask } from './capture';
import { takeSecret } from './child-env';
import { keyframesTask } from './render/keyframes';
import { renderTask } from './render/video';
import { getRunDir, runWorker } from './worker';

const LIFETIME_MS = 55 * 60_000;

async function main(): Promise<void> {
  const apiBase = process.env.API_BASE;
  const token = takeSecret(process.env, 'VM_TOKEN');
  const missing = [apiBase ? '' : 'API_BASE', token ? '' : 'VM_TOKEN'].filter(Boolean);
  if (!apiBase || !token) throw new Error(`The worker needs ${missing.join(' and ')} in its environment.`);

  const runDir = getRunDir();
  await runWorker({
    api: createVmApi({ base: apiBase, token }),
    handlers: {
      capture: (task) => captureTask(task, runDir),
      keyframes: (task) => keyframesTask(task, runDir),
      render: (task) => renderTask(task, runDir),
    },
    deadline: Date.now() + LIFETIME_MS,
  });
}

main()
  .catch((error: unknown) => {
    // Only the message: it never holds the permit (nothing the worker writes does).
    console.error(error instanceof Error ? error.message : 'The worker failed.');
    process.exitCode = 1;
  })
  .finally(() => {
    // Chrome or a socket that did not close must not keep the VM's last process alive.
    setTimeout(() => process.exit(), 10_000).unref();
  });
