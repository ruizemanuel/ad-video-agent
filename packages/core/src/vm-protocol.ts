// What the service and the rented VM say to each other. The VM asks for its next task and gets a TaskEnvelope; it does
// the work and posts the result. What the flow needs to read later travels through the blob store as a file
// (CaptureFile, KeyframesFile), and the envelope only carries the presigned URLs that file is written to.
import type { Edl } from './edl';
import type { VmTaskKind } from './order';
import type { Still } from './qa';
import type { SiteData } from './site';

/** The next task, as `GET /api/vm/tasks/next` gives it. `urls` are presigned and valid for 30 minutes; which ones depends on `kind`. */
export type TaskEnvelope = { id: string; kind: VmTaskKind; input: unknown; urls: Record<string, string> };

export type CaptureInput = { url: string; extraUrls: string[]; followDemoLinks: number };
export type CaptureResult =
  | { ok: true; metadataBlocked: boolean; sections: number; shots: number }
  | { ok: false; code: 'blocked' | 'unreachable' | 'error'; message: string };

export type KeyframesInput = { edl: Edl; hook: 0; format: '9x16'; round: number };
export type KeyframesResult = { ok: true; stills: number } | { ok: false; code: 'error'; message: string };

export type RenderInput = {
  edl: Edl;
  hook: 0;
  format: '9x16';
  /** The chosen track: `firstBeat` and `seconds` are as measured, `path` is the blob the VM downloads it from. Null for a silent order. */
  music: { firstBeat: number; seconds: number; path: string } | null;
};
export type RenderResult =
  | { ok: true; frames: number; seconds: number; mutedBytes: number; withMusicBytes: number | null }
  | { ok: false; code: 'error'; message: string };

/** `orders/<id>/capture.json`: the capture the flow reads. The pictures for the director travel as base64 JPEG. */
export type CaptureFile = { site: SiteData; directorImages: { shotId: string; jpegBase64: string }[] };

/** `orders/<id>/keyframes-<round>.json`. */
export type KeyframesFile = { stills: Still[] };
