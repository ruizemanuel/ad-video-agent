// Where the files of a VM task live in the blob store, and the presigned URLs the VM is given for them. The VM holds
// no credentials for the store: for each task it gets exactly the writes and reads that task needs, each good for
// 30 minutes, minted when the task is claimed.
import type { BlobPort, VmTask } from '../ports';

/** How long the URLs of a task work. */
const URL_MINUTES = 30;
const MB = 1024 * 1024;

/** The capture the flow reads. */
export const capturePath = (orderId: string): string => `orders/${orderId}/capture.json`;
/** The key frames of one round of the script, which the review reads. */
export const keyframesPath = (orderId: string, round: number): string => `orders/${orderId}/keyframes-${round}.json`;
/** The hook the render writes: without music, and with it. These are the names the client downloads. */
export const renderPaths = (orderId: string): { muted: string; withMusic: string } => ({
  muted: `orders/${orderId}/out/hook-a-9x16-muted.mp4`,
  withMusic: `orders/${orderId}/out/hook-a-9x16.mp4`,
});

export type UploadUrlDeps = { blob: Pick<BlobPort, 'presignPut' | 'presignGet'> };

// A track is read from the path the task names, so the path has to be one of this order's tracks: one file in its
// music folder. Anything else would let a task hand the VM a read of any file in the store.
const TRACK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function trackPath(orderId: string, input: unknown): string | null {
  const music = typeof input === 'object' && input !== null ? (input as { music?: unknown }).music : undefined;
  if (music === null || music === undefined) return null;
  const path = typeof music === 'object' ? (music as { path?: unknown }).path : undefined;
  const folder = `orders/${orderId}/music/`;
  if (typeof path !== 'string' || !path.startsWith(folder) || !TRACK_NAME.test(path.slice(folder.length))) {
    throw new RangeError(`A render task can only use a track in ${folder}.`);
  }
  return path;
}

/**
 * The presigned URLs the VM gets with a task, by the name the worker knows them by:
 * - capture: `captureJson`, a write of capture.json (20 MB);
 * - keyframes: `keyframesJson`, a write of the round's file (30 MB);
 * - render: `muted` and, if the order has music, `withMusic` (writes of 200 MB each, video/mp4) and `musicWav`, a read
 *   of the chosen track;
 * - shutdown: none.
 */
export async function uploadUrlsFor(task: Pick<VmTask, 'orderId' | 'kind' | 'round' | 'input'>, deps: UploadUrlDeps): Promise<Record<string, string>> {
  const { orderId, kind, round, input } = task;
  const { blob } = deps;
  switch (kind) {
    case 'capture':
      return { captureJson: await blob.presignPut(capturePath(orderId), 'application/json', 20 * MB, URL_MINUTES) };
    case 'keyframes':
      return { keyframesJson: await blob.presignPut(keyframesPath(orderId, round), 'application/json', 30 * MB, URL_MINUTES) };
    case 'render': {
      // Checked before anything is presigned.
      const track = trackPath(orderId, input);
      const paths = renderPaths(orderId);
      const urls: Record<string, string> = { muted: await blob.presignPut(paths.muted, 'video/mp4', 200 * MB, URL_MINUTES) };
      if (track !== null) {
        urls.withMusic = await blob.presignPut(paths.withMusic, 'video/mp4', 200 * MB, URL_MINUTES);
        urls.musicWav = await blob.presignGet(track, URL_MINUTES);
      }
      return urls;
    }
    case 'shutdown':
      return {};
  }
}
