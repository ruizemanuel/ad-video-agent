// The key frames of a video: a still of each scene once it has settled, with the text of the frame measured in the real
// DOM (the probe), for the code checks and the visual review. A scene whose text changes partway (a caption replaced at
// its `atBeat`, the words of a WordCycle) gets one still per text it shows, so every line is seen settled once.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { layoutScenes, settledFrame, timedScenePath, type Edl, type Format, type ProbeItem, type SiteData, type Still, type TimedScene } from '@app/core';
import { childEnv } from '../child-env';
import { readProbe } from '../video/probe';
import { textChanges } from '../video/rhythm';
import { getServeUrl } from './bundle';

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

/** ffmpeg arguments for the picture of a still: 720 px wide, JPEG quality 3. */
export const buildStillJpegArgs = (png: string, jpg: string): string[] => ['-v', 'error', '-y', '-i', png, '-vf', 'scale=720:-1', '-q:v', '3', jpg];

const run = promisify(execFile);

async function toJpeg(png: string, jpg: string): Promise<void> {
  try {
    // ffmpeg gets an environment of its own (see child-env).
    await run('ffmpeg', buildStillJpegArgs(png, jpg), { env: childEnv(), timeout: 30_000 });
  } catch (error) {
    const stderr = typeof (error as { stderr?: unknown }).stderr === 'string' ? (error as { stderr: string }).stderr : '';
    throw new Error(`ffmpeg could not make the picture of a key frame: ${stderr.trim().split('\n').at(-1) || (error instanceof Error ? error.name : 'unknown error')}`);
  }
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
      await toJpeg(png, jpg);
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
