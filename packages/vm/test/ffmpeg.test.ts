import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDirectorJpegArgs, buildMuxArgs, buildMusicArgs, buildStillJpegArgs, runFfmpeg } from '../src/render/ffmpeg';

describe('the music of the video', () => {
  it('cuts, fades and normalizes the track', () =>
    expect(buildMusicArgs({ wav: 'm.wav', firstBeat: 0.12, seconds: 19.07, out: 't.wav' })).toEqual([
      '-v', 'error', '-y', '-ss', '0.120', '-t', '19.070', '-i', 'm.wav', '-af', 'afade=t=out:st=18.570:d=0.5,loudnorm=I=-14:TP=-1.5:LRA=11', '-ar', '48000', 't.wav',
    ]));

  it('starts at the start of the track when the first beat is not a time', () => {
    for (const firstBeat of [-0.3, Number.NaN]) {
      expect(buildMusicArgs({ wav: 'm.wav', firstBeat, seconds: 10, out: 't.wav' }).slice(3, 5)).toEqual(['-ss', '0.000']);
    }
  });

  it('never starts the fade before the track does', () => {
    const args = buildMusicArgs({ wav: 'm.wav', firstBeat: 0, seconds: 0.3, out: 't.wav' });
    expect(args[args.indexOf('-af') + 1]).toMatch(/^afade=t=out:st=0\.000:d=0\.3/);
  });
});

describe('the mix', () => {
  it('muxes without re-encoding the video', () =>
    expect(buildMuxArgs({ video: 'v.mp4', audio: 't.wav', out: 'o.mp4' })).toEqual([
      '-v', 'error', '-y', '-i', 'v.mp4', '-i', 't.wav', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', 'o.mp4',
    ]));
});

describe('the pictures', () => {
  it('of a key frame are JPEGs 720 px wide at quality 3', () => {
    expect(buildStillJpegArgs('w/52.png', 'w/52.jpg')).toEqual(['-v', 'error', '-y', '-i', 'w/52.png', '-vf', 'scale=720:-1', '-q:v', '3', 'w/52.jpg']);
  });

  it('for the director are JPEGs 480 px wide at quality 4', () => {
    expect(buildDirectorJpegArgs('run/media/m-s2.png', 'run/director/m-s2.jpg')).toEqual([
      '-v', 'error', '-y', '-i', 'run/media/m-s2.png', '-vf', 'scale=480:-1', '-q:v', '4', 'run/director/m-s2.jpg',
    ]);
  });
});

// The runner starts `program` with the arguments it is given. These tests start node in ffmpeg's place, to see how a
// program that fails, hangs or is not there is reported.
const node = (script: string) => ({ program: process.execPath, args: ['-e', script] });

describe('runFfmpeg', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('resolves when the program ends well', async () => {
    const { program, args } = node('process.exit(0)');
    await expect(runFfmpeg(args, 'do something', { program })).resolves.toBeUndefined();
  });

  it('says what it was doing and the last line the program wrote to stderr', async () => {
    const { program, args } = node("console.error('first line\\nInvalid data found when processing input\\n'); process.exit(1)");

    const error = await runFfmpeg(args, 'cut the music', { program }).catch((e: unknown) => e);

    expect((error as Error).message).toBe('ffmpeg could not cut the music: Invalid data found when processing input');
  });

  it('says when ffmpeg is not on the PATH', async () => {
    const error = await runFfmpeg(['-version'], 'cut the music', { program: 'ffmpeg-that-is-not-installed' }).catch((e: unknown) => e);

    expect((error as Error).message).toBe('ffmpeg could not cut the music: ffmpeg is not on the PATH');
  });

  it('says when the program took too long, and stops it', async () => {
    const { program, args } = node('setTimeout(() => {}, 60000)');

    const error = await runFfmpeg(args, 'mix the music', { program, timeoutMs: 300 }).catch((e: unknown) => e);

    expect((error as Error).message).toBe('ffmpeg could not mix the music: it did not finish in time');
  });

  it('gives the program the few variables a program needs, and not the order permit', async () => {
    vi.stubEnv('VM_TOKEN', 'permit');
    // Exits 3 when it sees the permit, 0 when it does not.
    const { program, args } = node("process.exit(process.env.VM_TOKEN === undefined ? 0 : 3)");

    await expect(runFfmpeg(args, 'do something', { program })).resolves.toBeUndefined();
  });
});
