import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { RenderInput, TaskEnvelope } from '@app/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMuxArgs, buildMusicArgs } from '../src/render/ffmpeg';
import { renderTask } from '../src/render/video';
import { FIXTURE_FRAMES, FIXTURE_SECONDS, fixtureEdl, fixtureSite, writeCapturedSite } from './support/edl';

const URLS = {
  muted: 'https://store.example/orders/o1/out/hook-a-9x16-muted.mp4?signature=SECRET1',
  withMusic: 'https://store.example/orders/o1/out/hook-a-9x16.mp4?signature=SECRET2',
  musicWav: 'https://store.example/orders/o1/music/cand-1.wav?signature=SECRET3',
};
const MUTED_BYTES = 1234;
const MIXED_BYTES = 1500;
const MUSIC = { firstBeat: 0.12, seconds: 30, path: 'orders/o1/music/cand-1.wav' };

const task = (input: unknown, urls: Record<string, string> = URLS): TaskEnvelope => ({ id: 't1', kind: 'render', input, urls });
const input = (music: RenderInput['music'] = MUSIC, extra: Record<string, unknown> = {}) => ({ edl: fixtureEdl(), hook: 0, format: '9x16', music, ...extra });

describe('renderTask', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'render-task-'));
    writeCapturedSite(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Doubles that write files of known sizes and say, in `events`, what was done and in which order. */
  const setup = () => {
    const events: string[] = [];
    const files: string[] = [];
    const d = {
      renderVideo: vi.fn(async (options: { out: string }) => {
        events.push('render');
        files.push(options.out);
        writeFileSync(options.out, Buffer.alloc(MUTED_BYTES));
        return { frames: FIXTURE_FRAMES, seconds: FIXTURE_SECONDS };
      }),
      uploadFile: vi.fn(async (url: string, _path: string, _type: string) => {
        events.push(`upload ${Object.entries(URLS).find(([, u]) => u === url)?.[0]}`);
      }),
      download: vi.fn(async (_url: string, dest: string) => {
        events.push('download');
        files.push(dest);
        writeFileSync(dest, 'RIFF');
        return 4;
      }),
      ffmpeg: vi.fn(async (args: readonly string[], what: string, _options?: { timeoutMs?: number }) => {
        events.push(what);
        files.push(String(args.at(-1)));
        writeFileSync(String(args.at(-1)), Buffer.alloc(what.startsWith('mix') ? MIXED_BYTES : 10));
      }),
    };
    return { d, events, files };
  };

  it('renders the hook muted and uploads it, and with no track that is all', async () => {
    const { d, events } = setup();

    const result = await renderTask(task(input(null), { muted: URLS.muted }), dir, d);

    expect(result).toEqual({ ok: true, frames: FIXTURE_FRAMES, seconds: FIXTURE_SECONDS, mutedBytes: MUTED_BYTES, withMusicBytes: null });
    expect(events).toEqual(['render', 'upload muted']);
    expect(d.renderVideo).toHaveBeenCalledWith({ edl: fixtureEdl(), site: fixtureSite(), runDir: dir, out: expect.stringMatching(/hook-a-9x16-muted\.mp4$/), format: '9x16', hook: 0 });
    const [url, path, type] = d.uploadFile.mock.calls[0] ?? [];
    expect([url, type]).toEqual([URLS.muted, 'video/mp4']);
    expect(path).toBe(d.renderVideo.mock.calls[0]?.[0].out);
    expect(d.download).not.toHaveBeenCalled();
    expect(d.ffmpeg).not.toHaveBeenCalled();
  });

  it('takes a task without a track key as one without music', async () => {
    const { d } = setup();

    const result = await renderTask(task({ edl: fixtureEdl(), hook: 0, format: '9x16' }, { muted: URLS.muted }), dir, d);

    expect(result).toMatchObject({ ok: true, withMusicBytes: null });
  });

  it('with a track: downloads it, cuts it at its first beat to the length of the video, mixes it in and uploads both videos', async () => {
    const { d, events } = setup();

    const result = await renderTask(task(input()), dir, d);

    expect(result).toEqual({ ok: true, frames: FIXTURE_FRAMES, seconds: FIXTURE_SECONDS, mutedBytes: MUTED_BYTES, withMusicBytes: MIXED_BYTES });
    expect(events).toEqual(['render', 'upload muted', 'download', 'cut the music', 'mix the music into the video', 'upload withMusic']);

    const [wavUrl, wav] = d.download.mock.calls[0] ?? [];
    expect(wavUrl).toBe(URLS.musicWav);
    const [cut, mux] = d.ffmpeg.mock.calls;
    const muted = d.renderVideo.mock.calls[0]?.[0].out ?? '';
    // The cut is of the downloaded file, of the video's length, starting at the track's first beat.
    const track = String(cut?.[0].at(-1));
    expect(cut?.[0]).toEqual(buildMusicArgs({ wav: wav ?? '', firstBeat: 0.12, seconds: FIXTURE_SECONDS, out: track }));
    // The mix keeps the render as it is and puts the cut under it.
    const mixed = String(mux?.[0].at(-1));
    expect(mux?.[0]).toEqual(buildMuxArgs({ video: muted, audio: track, out: mixed }));
    expect(basename(mixed)).toBe('hook-a-9x16.mp4');
    expect(d.uploadFile.mock.calls[1]).toEqual([URLS.withMusic, mixed, 'video/mp4']);
  });

  it('gives the programs enough time for a 200 MB file', async () => {
    const { d } = setup();

    await renderTask(task(input()), dir, d);

    expect(d.ffmpeg).toHaveBeenCalledTimes(2);
    for (const call of d.ffmpeg.mock.calls) expect(call[2]?.timeoutMs).toBeGreaterThanOrEqual(60_000);
  });

  it('keeps nothing on the disk of the VM when it ends well', async () => {
    const { d, files } = setup();

    await renderTask(task(input()), dir, d);

    expect(files.length).toBeGreaterThan(2);
    for (const file of files) expect(existsSync(file), file).toBe(false);
    expect(existsSync(dirname(files[0] ?? ''))).toBe(false);
  });

  it('keeps nothing on the disk of the VM when it fails halfway, and lets the failure through', async () => {
    const { d, files } = setup();
    d.ffmpeg.mockRejectedValueOnce(new Error('ffmpeg could not cut the music: Invalid data found when processing input'));

    await expect(renderTask(task(input()), dir, d)).rejects.toThrow(/could not cut the music/);

    expect(d.uploadFile).toHaveBeenCalledTimes(1);
    expect(existsSync(dirname(files[0] ?? ''))).toBe(false);
  });

  it('uploads nothing when the video cannot be rendered', async () => {
    const { d } = setup();
    d.renderVideo.mockRejectedValue(new Error('Rendering failed.'));

    await expect(renderTask(task(input()), dir, d)).rejects.toThrow(/Rendering failed/);

    expect(d.uploadFile).not.toHaveBeenCalled();
  });

  it('lets a failed upload through, with no URL in what it says', async () => {
    const { d } = setup();
    d.uploadFile.mockRejectedValue(new Error('The upload was refused (HTTP 403).'));

    const error = await renderTask(task(input()), dir, d).catch((e: unknown) => e);

    expect((error as Error).message).toBe('The upload was refused (HTTP 403).');
    expect(d.download).not.toHaveBeenCalled();
  });

  it('refuses, before rendering anything, a track that ends before the video does', async () => {
    const { d } = setup();

    // 7 s of video from the first beat on needs a track of 7.12 s or more; this one has 6.
    await expect(renderTask(task(input({ ...MUSIC, seconds: 6 })), dir, d)).rejects.toThrow(/shorter than the video/);

    expect(d.renderVideo).not.toHaveBeenCalled();
    expect(d.uploadFile).not.toHaveBeenCalled();
  });

  it('puts up with a track that falls half a second short or less: the mix is then as long as the track', async () => {
    const { d } = setup();

    const result = await renderTask(task(input({ ...MUSIC, seconds: FIXTURE_SECONDS + MUSIC.firstBeat - 0.4 })), dir, d);

    expect(result).toMatchObject({ ok: true, withMusicBytes: MIXED_BYTES });
  });

  it.each([
    ['the place to put the muted video', { withMusic: URLS.withMusic, musicWav: URLS.musicWav }],
    ['the place to put the video with music', { muted: URLS.muted, musicWav: URLS.musicWav }],
    ['the place to read the track from', { muted: URLS.muted, withMusic: URLS.withMusic }],
  ])('refuses, before rendering anything, a task without %s', async (_what, urls) => {
    const { d } = setup();

    await expect(renderTask(task(input(), urls), dir, d)).rejects.toThrow(/place to/);

    expect(d.renderVideo).not.toHaveBeenCalled();
  });

  it.each([
    ['has no edit list', input(null, { edl: undefined })],
    ['has another hook', input(null, { hook: 2 })],
    ['has another format', input(null, { format: '4x5' })],
    ['has a track without a first beat', input({ seconds: 30, path: 'p' } as never)],
    ['has a track of no length', input({ ...MUSIC, seconds: 0 })],
    ['has a track that is not an object', input('cand-1.wav' as never)],
  ])('refuses, before rendering anything, a task that %s', async (_what, body) => {
    const { d } = setup();

    await expect(renderTask(task(body), dir, d)).rejects.toThrow();

    expect(d.renderVideo).not.toHaveBeenCalled();
  });

  it('says so, before rendering anything, when the capture is not on this VM', async () => {
    const { d } = setup();
    rmSync(join(dir, 'site.json'));

    await expect(renderTask(task(input()), dir, d)).rejects.toThrow(/no capture/);

    expect(d.renderVideo).not.toHaveBeenCalled();
  });
});
