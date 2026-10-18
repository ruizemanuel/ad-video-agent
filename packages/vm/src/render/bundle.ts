// The Remotion bundle of the video. Webpack builds it from the TypeScript source (the video's and @app/core's) and copies
// the run folder in as its public dir, so the shots, fonts and logo of the capture are what `staticFile` serves.
import { join, resolve } from 'node:path';

const ENTRY_POINT = join(import.meta.dirname, '..', 'video', 'index.ts');

const bundles = new Map<string, Promise<string>>();

/**
 * The serve URL (a folder) of the bundle for `runDir`, made once per run folder: one per VM, since the VM keeps one
 * capture for the whole order. The run folder is copied when the bundle is made, so this is called after the capture;
 * a failed bundle is not kept, and the next call tries again.
 */
export function getServeUrl(runDir: string): Promise<string> {
  const publicDir = resolve(runDir);
  const known = bundles.get(publicDir);
  if (known) return known;
  const made = import('@remotion/bundler').then(({ bundle }) => bundle({ entryPoint: ENTRY_POINT, publicDir }));
  bundles.set(publicDir, made);
  made.catch(() => bundles.delete(publicDir));
  return made;
}
