// The key frames of a video: a still of each scene once it has settled, with the text of the frame measured in the real
// DOM (the probe), for the code checks and the visual review. A scene whose text changes partway (a caption replaced at
// its `atBeat`, the words of a WordCycle) gets one still per text it shows, so every line is seen settled once.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { layoutScenes, settledFrame, timedScenePath, type Edl, type Format, type KeyframesFile, type KeyframesResult, type ProbeItem, type SiteData, type Still, type TaskEnvelope, type TimedScene } from '@app/core';
import { uploadToPresigned } from '../upload';
import { readProbe } from '../video/probe';
import { textChanges } from '../video/rhythm';
import { getServeUrl } from './bundle';
import { buildStillJpegArgs, runFfmpeg } from './ffmpeg';
import { parseKeyframesInput, readSite } from './input';

// A still of a text that is about to be replaced is taken this many frames before the change...
const BEFORE_CHANGE = 4;
// ...but not before the scene has come in (its caption, its card), unless the change comes first: then the frame before it.
const ENTRANCES = 20;

/** The frame of the scene to take the text replaced at `change` in: whole, and never once the change has started. */
const stillBefore = (change: number): number => Math.min(Math.max(change - BEFORE_CHANGE, ENTRANCES), change - 1);

/** The frames of the video of `hook` to take stills of: the settled frame of each scene, and one before each change of its text. */
export function keyframePlan(edl: Edl, hook: number): { timed: TimedScene; frame: number }[] {
  return layoutScenes(edl, hook).scenes.flatMap((timed) => {
    const before = textChanges(timed, edl.bpm).map((change) => timed.from + stillBefore(change));
    return [...before, settledFrame(timed)].map((frame) => ({ timed, frame }));
  });
}

export type KeyframesOptions = { edl: Edl; site: SiteData; runDir: string; format: Format; hook: number };

/**
 * Renders the key frames of the video of `hook` in `format` from the bundle of `runDir` (see getServeUrl): each still
 * with the text the probe measured in it and its picture as a base64 JPEG. Throws if a frame comes out unmeasured.
 */
export async function renderKeyframes({ edl, site, runDir, format, hook }: KeyframesOptions): Promise<Still[]> {
  const { openBrowser, renderStill, selectComposition } = await import('@remotion/renderer');
  const serveUrl = await getServeUrl(runDir);
  const inputProps = { edl, site, format, hook, probe: true };
  const work = mkdtempSync(join(tmpdir(), 'keyframes-'));
  const browser = await openBrowser('chrome');
  try {
    const composition = await selectComposition({ serveUrl, id: `ad-${format}`, inputProps, puppeteerInstance: browser });
    const stills: Still[] = [];
    for (const [n, { timed, frame }] of keyframePlan(edl, hook).entries()) {
      const png = join(work, `${n}.png`);
      const jpg = join(work, `${n}.jpg`);
      let text: ProbeItem[] | undefined;
      await renderStill({
        composition,
        serveUrl,
        output: png,
        frame,
        inputProps,
        imageFormat: 'png',
        puppeteerInstance: browser,
        onBrowserLog: (log) => {
          text = readProbe(log.text, frame) ?? text;
        },
      });
      if (!text) throw new Error(`The key frame ${frame} came out without its text measured.`);
      await runFfmpeg(buildStillJpegArgs(png, jpg), 'make the picture of a key frame');
      stills.push({
        index: timed.index,
        role: timed.role,
        piece: timed.scene.piece,
        frame,
        path: timedScenePath(edl, hook, timed),
        text,
        jpegBase64: readFileSync(jpg).toString('base64'),
      });
    }
    return stills;
  } finally {
    await browser.close({ silent: true }).catch(() => {});
    rmSync(work, { recursive: true, force: true });
  }
}

// ---------- the task ----------

/** What `keyframesTask` leans on, so that a test can put its own: the renderer and the upload. */
export type KeyframesTaskDeps = { renderKeyframes: typeof renderKeyframes; upload: typeof uploadToPresigned };

/**
 * The handler of `keyframes` tasks: renders the key frames of the main hook in 9x16 from the capture in `runDir`, then
 * writes them, as the file the flow reads, to the place the task names. It throws if the task cannot be done (no usable
 * edit list, no place to write to, no capture on this VM), if a frame cannot be rendered and if the upload fails.
 */
export async function keyframesTask(task: TaskEnvelope, runDir: string, deps: KeyframesTaskDeps = { renderKeyframes, upload: uploadToPresigned }): Promise<KeyframesResult> {
  const { edl, hook, format } = parseKeyframesInput(task.input);
  const target = task.urls.keyframesJson;
  if (!target) throw new Error('The keyframes task came without a place to put the key frames.');
  const site = readSite(runDir);
  const stills = await deps.renderKeyframes({ edl, site, runDir, format, hook });
  const file: KeyframesFile = { stills };
  await deps.upload(target, JSON.stringify(file), 'application/json');
  return { ok: true, stills: stills.length };
}
