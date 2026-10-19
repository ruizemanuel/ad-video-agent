// Opt-in, with the other tests that need programs outside node (`pnpm --filter @app/vm test:browser`): it cuts a track
// that ends a little before the video, mixes it in with the real ffmpeg, and looks at the result with ffprobe and ffmpeg's
// own meters. It needs no browser and no network, only ffmpeg and ffprobe on the PATH.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { MAX_TRACK_SHORT_FALL_SECONDS } from '@app/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMusicArgs, buildMuxArgs, runFfmpeg } from '../../src/render/ffmpeg';

const run = promisify(execFile);

/** How long a stream of the file lasts, in seconds: `v:0` for the picture, `a:0` for the sound. */
async function streamSeconds(file: string, stream: 'v:0' | 'a:0'): Promise<number> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', stream, '-show_entries', 'stream=duration', '-of', 'csv=p=0', file]);
  return Number(stdout.trim());
}

/** The loudest sample of the audio between `from` and `from + seconds`, in dB (ffmpeg's volumedetect). */
async function peakDb(file: string, from: number, seconds: number): Promise<number> {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', '-ss', String(from), '-t', String(seconds), '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
  const match = /max_volume: (-?[\d.]+|-inf) dB/.exec(stderr);
  if (!match) throw new Error(`volumedetect said nothing:\n${stderr.slice(-400)}`);
  return match[1] === '-inf' ? -Infinity : Number(match[1]);
}

const VIDEO_SECONDS = 4;
// The track lasts all the coverage rule lets through: from its first beat, half a second short of the video.
const FIRST_BEAT = 0.2;
const TRACK_SECONDS = FIRST_BEAT + VIDEO_SECONDS - MAX_TRACK_SHORT_FALL_SECONDS;

let work: string;
let mixed: string;
let track: string;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'mux-'));
  const video = join(work, 'video.mp4');
  const wav = join(work, 'tone.wav');
  track = join(work, 'track.wav');
  mixed = join(work, 'mixed.mp4');
  await runFfmpeg(['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=270x480:rate=30:duration=${VIDEO_SECONDS}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video], 'make a test video');
  await runFfmpeg(['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${TRACK_SECONDS}`, '-af', 'volume=0.1', '-ar', '44100', wav], 'make a test tone');
  await runFfmpeg(buildMusicArgs({ wav, firstBeat: FIRST_BEAT, trackSeconds: TRACK_SECONDS, seconds: VIDEO_SECONDS, out: track }), 'cut the music');
  await runFfmpeg(buildMuxArgs({ video, audio: track, out: mixed }), 'mix the music into the video');
});

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

describe('a track that ends up to half a second before the video', () => {
  it('leaves the video its whole length, with sound all along', async () => {
    expect(await streamSeconds(mixed, 'v:0')).toBeCloseTo(VIDEO_SECONDS, 1);
    expect(Math.abs((await streamSeconds(mixed, 'a:0')) - VIDEO_SECONDS)).toBeLessThanOrEqual(0.1);
  });

  it('fades out before the track runs out, and is silent after it', async () => {
    const playing = TRACK_SECONDS - FIRST_BEAT;
    const middle = await peakDb(track, 1, 0.5);
    // The last tenth of a second of the music is well into the fade, and the padding after it is silence.
    expect(await peakDb(track, playing - 0.1, 0.1)).toBeLessThan(middle - 12);
    expect(await peakDb(track, playing + 0.1, 0.3)).toBeLessThan(-60);
  });
});
