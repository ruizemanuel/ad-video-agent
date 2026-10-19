// The video itself. Remotion renders the main hook, muted, to an H.264 MP4; when the order has music, ffmpeg cuts the
// track to the video, fades and normalizes it, and puts it under the render without touching the picture. The video is
// rendered once, without sound, and the music is added after: the composition's own `music` prop is not used in this
// service (see AdProps), because the run folder is copied into the bundle before the track exists.
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FPS, layoutScenes, trackCoversVideo, type Edl, type Format, type RenderResult, type SiteData, type TaskEnvelope } from '@app/core';
import { downloadToFile } from '../download';
import { uploadFileToPresigned } from '../upload';
import { getServeUrl } from './bundle';
import { buildMuxArgs, buildMusicArgs, runFfmpeg } from './ffmpeg';
import { parseRenderInput, readSite } from './input';

/** An e2-medium has 2 vCPUs and 4 GiB: two tabs of Chrome rendering frames is what it carries. */
const CONCURRENCY = 2;

export type RenderVideoOptions = { edl: Edl; site: SiteData; runDir: string; out: string; format: Format; hook: number };

/**
 * Renders the video of `hook` in `format` from the bundle of `runDir` (see getServeUrl) to `out`: H.264, with no audio
 * track at all. Says how many frames it has and how long they last.
 */
export async function renderVideo({ edl, site, runDir, out, format, hook }: RenderVideoOptions): Promise<{ frames: number; seconds: number }> {
  const { openBrowser, renderMedia, selectComposition } = await import('@remotion/renderer');
  const serveUrl = await getServeUrl(runDir);
  // No probe: it holds every frame while the page measures its text, and only the key frames need that.
  const inputProps = { edl, site, format, hook };
  const browser = await openBrowser('chrome');
  try {
    const composition = await selectComposition({ serveUrl, id: `ad-${format}`, inputProps, puppeteerInstance: browser });
    await renderMedia({ composition, serveUrl, codec: 'h264', muted: true, outputLocation: out, inputProps, concurrency: CONCURRENCY, puppeteerInstance: browser });
    return { frames: composition.durationInFrames, seconds: composition.durationInFrames / FPS };
  } finally {
    await browser.close({ silent: true }).catch(() => {});
  }
}

// ---------- the task ----------

// Cutting 20 seconds of audio is quick, and the mix copies the picture of a render of up to 200 MB: a slow disk is the
// worst that can happen to either.
const CUT_TIMEOUT_MS = 60_000;
const MIX_TIMEOUT_MS = 180_000;

/** What `renderTask` leans on, so that a test can put its own: the renderer, the transfers and ffmpeg. */
export type RenderTaskDeps = {
  renderVideo: typeof renderVideo;
  uploadFile: typeof uploadFileToPresigned;
  download: typeof downloadToFile;
  ffmpeg: typeof runFfmpeg;
};

const DEFAULT_DEPS: RenderTaskDeps = { renderVideo, uploadFile: uploadFileToPresigned, download: downloadToFile, ffmpeg: runFfmpeg };

/**
 * The handler of `render` tasks:
 * 1. renders the main hook in 9x16 muted and uploads it to `urls.muted`;
 * 2. with a track: downloads it from `urls.musicWav`, cuts it at its first beat to the video's length (fade out,
 *    -14 LUFS), mixes it under the render without re-encoding the picture and uploads the result to `urls.withMusic`.
 * What it makes lives in a folder of its own, removed when it ends, well or not. It throws if the task cannot be done
 * (no usable edit list, no places to write to or read from, a track that ends before the video, no capture on this VM)
 * and if the render, a transfer or ffmpeg fails.
 */
export async function renderTask(task: TaskEnvelope, runDir: string, deps: RenderTaskDeps = DEFAULT_DEPS): Promise<RenderResult> {
  const { edl, hook, format, music } = parseRenderInput(task.input);
  const { muted: mutedUrl, withMusic: withMusicUrl, musicWav: musicUrl } = task.urls;
  if (!mutedUrl) throw new Error('The render task came without a place to put the video.');
  if (music && !(withMusicUrl && musicUrl)) throw new Error('The render task has a track but no place to read it from or to put the video with it.');
  // The video lasts what its edit list says; the track has to cover that from its first beat on. The mix ends with the
  // shorter of the picture and the track (see buildMuxArgs), so a track that runs out would cut the video's end. The
  // service checks the same rule before it asks for music, so this is a safety net.
  const videoSeconds = layoutScenes(edl, hook).total / FPS;
  if (music && !trackCoversVideo(music, videoSeconds)) {
    throw new Error(`The track is shorter than the video: ${(music.seconds - Math.max(0, music.firstBeat)).toFixed(1)} s from its first beat, and the video lasts ${videoSeconds.toFixed(1)} s.`);
  }
  const site = readSite(runDir);

  const work = mkdtempSync(join(tmpdir(), 'render-'));
  try {
    const muted = join(work, 'hook-a-9x16-muted.mp4');
    const { frames, seconds } = await deps.renderVideo({ edl, site, runDir, out: muted, format, hook });
    await deps.uploadFile(mutedUrl, muted, 'video/mp4');
    const mutedBytes = statSync(muted).size;
    if (!music || !withMusicUrl || !musicUrl) return { ok: true, frames, seconds, mutedBytes, withMusicBytes: null };

    const wav = join(work, 'track-download.wav');
    const track = join(work, 'track.wav');
    const mixed = join(work, 'hook-a-9x16.mp4');
    await deps.download(musicUrl, wav);
    await deps.ffmpeg(buildMusicArgs({ wav, firstBeat: music.firstBeat, seconds, out: track }), 'cut the music', { timeoutMs: CUT_TIMEOUT_MS });
    await deps.ffmpeg(buildMuxArgs({ video: muted, audio: track, out: mixed }), 'mix the music into the video', { timeoutMs: MIX_TIMEOUT_MS });
    await deps.uploadFile(withMusicUrl, mixed, 'video/mp4');
    return { ok: true, frames, seconds, mutedBytes, withMusicBytes: statSync(mixed).size };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
