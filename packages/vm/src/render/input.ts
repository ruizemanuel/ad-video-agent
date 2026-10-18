// What the keyframes and render tasks are given, checked before anything is rendered: the service wrote it, but a task
// that cannot be done should fail in a line, at once, not minutes into a render. The edit list is read with its schema
// only: by now the service has validated it (and, with music, retimed it to the track's tempo), and this VM has no
// business judging what the site backs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EdlSchema, type Edl, type RenderInput, type SiteData } from '@app/core';

type TaskKind = 'keyframes' | 'render';

const asRecord = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** What both kinds of task say about the video: the edit list, and the only hook and format this service makes. */
function parseVideo(kind: TaskKind, given: Record<string, unknown>): { edl: Edl; hook: 0; format: '9x16' } {
  const parsed = EdlSchema.safeParse(given.edl);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = ['edl', ...(issue?.path ?? [])].join('.');
    throw new Error(`The ${kind} task has no usable edit list (${where}: ${issue?.message ?? 'invalid'}).`);
  }
  if (given.hook !== 0 || given.format !== '9x16') {
    throw new Error(`The ${kind} task asks for hook ${String(given.hook)} in ${String(given.format)}: this service renders hook 0 in 9x16 only.`);
  }
  return { edl: parsed.data, hook: 0, format: '9x16' };
}

export type KeyframesTaskInput = { edl: Edl; hook: 0; format: '9x16' };

/** The input of a `keyframes` task. The round only names the file it is written to, and the service's URL already says that. */
export function parseKeyframesInput(value: unknown): KeyframesTaskInput {
  return parseVideo('keyframes', asRecord(value));
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** The input of a `render` task. No track (null, or none given) is a silent order. */
export function parseRenderInput(value: unknown): RenderInput {
  const given = asRecord(value);
  const video = parseVideo('render', given);
  if (given.music === null || given.music === undefined) return { ...video, music: null };
  const music = asRecord(given.music);
  if (!finite(music.firstBeat) || !finite(music.seconds) || music.seconds <= 0 || typeof music.path !== 'string') {
    throw new Error('The render task has a track that is not described by its first beat, its length and its path.');
  }
  return { ...video, music: { firstBeat: music.firstBeat, seconds: music.seconds, path: music.path } };
}

/** The site the capture left in the run folder, which the tasks that follow it render. */
export function readSite(runDir: string): SiteData {
  let text: string;
  try {
    text = readFileSync(join(runDir, 'site.json'), 'utf8');
  } catch {
    throw new Error('There is no capture on this VM: site.json is missing from the run folder.');
  }
  return JSON.parse(text) as SiteData;
}
