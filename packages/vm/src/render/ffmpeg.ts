// Everything the VM asks of ffmpeg, in one place: the arguments of each job (plain functions of their inputs, so the
// tests can read them) and the one way of running it. ffmpeg works on the files of the run: the pictures of the key
// frames and of the director, the cut of the music and the mix of the music into the video.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { childEnv } from '../child-env';

// ---------- the pictures ----------

/** ffmpeg arguments for the picture of a key frame: 720 px wide, JPEG quality 3. */
export const buildStillJpegArgs = (png: string, jpg: string): string[] => ['-v', 'error', '-y', '-i', png, '-vf', 'scale=720:-1', '-q:v', '3', jpg];

/** ffmpeg arguments for a picture of the director: 480 px wide, JPEG quality 4. */
export const buildDirectorJpegArgs = (png: string, jpg: string): string[] => ['-v', 'error', '-y', '-i', png, '-vf', 'scale=480:-1', '-q:v', '4', jpg];

// ---------- the music ----------

// The track ends on a fade, because Lyria ignores the length it is asked for; and it is brought to the loudness
// platforms play at (-14 LUFS, true peak -1.5 dB), so that the video is neither far under nor over the ads around it.
const FADE_SECONDS = 0.5;
const LOUDNORM = 'loudnorm=I=-14:TP=-1.5:LRA=11';
const SAMPLE_RATE = 48_000;

/** ffmpeg takes seconds with a decimal point, here to the millisecond. */
const secondsArg = (seconds: number): string => seconds.toFixed(3);

export type MusicCut = {
  /** The generated track. */
  wav: string;
  /** Where its first beat falls, in seconds: the cut starts there, so the video's first cut lands on a beat. Under 0 or unknown, the cut starts at 0. */
  firstBeat: number;
  /** The length of the cut: the video's. */
  seconds: number;
  out: string;
};

/** ffmpeg arguments to cut the track at its first beat to the video's length, fade it out and normalize it to -14 LUFS. */
export const buildMusicArgs = ({ wav, firstBeat, seconds, out }: MusicCut): string[] => {
  const start = Number.isFinite(firstBeat) ? Math.max(0, firstBeat) : 0;
  const fade = Math.min(FADE_SECONDS, seconds);
  return [
    '-v', 'error', '-y',
    '-ss', secondsArg(start),
    '-t', secondsArg(seconds),
    '-i', wav,
    '-af', `afade=t=out:st=${secondsArg(Math.max(0, seconds - fade))}:d=${fade},${LOUDNORM}`,
    '-ar', String(SAMPLE_RATE),
    out,
  ];
};

/** ffmpeg arguments to put the audio under the video without re-encoding the video: the render is the picture, copied as it is. */
export const buildMuxArgs = ({ video, audio, out }: { video: string; audio: string; out: string }): string[] => [
  '-v', 'error', '-y',
  '-i', video,
  '-i', audio,
  '-map', '0:v',
  '-map', '1:a',
  '-c:v', 'copy',
  '-c:a', 'aac',
  '-b:a', '192k',
  '-shortest',
  out,
];

// ---------- the runner ----------

const run = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 30_000;

export type RunOptions = {
  /** For a test to start something else in ffmpeg's place. */
  program?: string;
  timeoutMs?: number;
};

/** Why a program did not end well, in a line: ffmpeg's own last word on it, or what happened to it. */
function reasonOf(error: unknown): string {
  const failure = error as { code?: unknown; killed?: unknown; stderr?: unknown };
  if (failure.code === 'ENOENT') return 'ffmpeg is not on the PATH';
  if (failure.killed === true) return 'it did not finish in time';
  const stderr = typeof failure.stderr === 'string' ? failure.stderr : '';
  return stderr.trim().split('\n').at(-1)?.trim() || (error instanceof Error ? error.name : 'unknown error');
}

/**
 * Runs ffmpeg with `args`. `what` finishes the sentence "ffmpeg could not ...", for the error. ffmpeg gets an
 * environment of its own (see child-env): it reads files a site influences, and it has no use for the order permit.
 */
export async function runFfmpeg(args: readonly string[], what: string, { program = 'ffmpeg', timeoutMs = DEFAULT_TIMEOUT_MS }: RunOptions = {}): Promise<void> {
  try {
    await run(program, [...args], { env: childEnv(), timeout: timeoutMs });
  } catch (error) {
    throw new Error(`ffmpeg could not ${what}: ${reasonOf(error)}`);
  }
}
