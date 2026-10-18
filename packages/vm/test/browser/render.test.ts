// Opt-in (`pnpm --filter @app/vm test:browser`): captures the fixture site, renders the main hook in a real Chrome and mixes
// music into it with ffmpeg, then looks at the files with ffprobe and ffmpeg's loudness meter. It needs the network (Google
// Fonts for the capture), and ffmpeg and ffprobe on the PATH.
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { FORMATS, FPS, layoutScenes, type Edl, type RenderResult, type TaskEnvelope } from '@app/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capture, type CapturedSite } from '../../src/capture';
import { getServeUrl } from '../../src/render/bundle';
import { buildMuxArgs, buildMusicArgs, runFfmpeg } from '../../src/render/ffmpeg';
import { renderTask, renderVideo } from '../../src/render/video';
import { fixtureEdl } from '../support/edl';
import { serveFixtureSite } from './support/fixture-site';

const run = promisify(execFile);

type Stream = { codec_type: string; codec_name: string; width?: number; height?: number; r_frame_rate?: string };
type Probe = { duration: number; streams: Stream[] };

/** What ffprobe says of a file: the length of the container and each stream. */
async function probe(file: string): Promise<Probe> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,r_frame_rate', '-of', 'json', file]);
  const json = JSON.parse(stdout) as { format: { duration: string }; streams: Stream[] };
  return { duration: Number(json.format.duration), streams: json.streams };
}

/** The integrated loudness, in LUFS, that ffmpeg's EBU R128 meter reads from the audio of a file. */
async function integratedLoudness(file: string): Promise<number> {
  const { stderr } = await run('ffmpeg', ['-nostats', '-hide_banner', '-i', file, '-vn', '-af', 'ebur128', '-f', 'null', '-'], { maxBuffer: 1 << 26 });
  // The summary comes last: "Integrated loudness:\n    I:         -14.0 LUFS".
  const summary = stderr.slice(stderr.lastIndexOf('Integrated loudness'));
  const match = /I:\s+(-?[\d.]+) LUFS/.exec(summary);
  if (!match) throw new Error(`The meter did not read a loudness:\n${stderr.slice(-400)}`);
  return Number(match[1]);
}

let fixture: Awaited<ReturnType<typeof serveFixtureSite>>;
let dir: string;
let work: string;
let site: CapturedSite;
let edl: Edl;
/** The bundle the tests made, removed at the end. */
let bundleDir: string | undefined;

beforeAll(async () => {
  fixture = await serveFixtureSite();
  dir = mkdtempSync(join(tmpdir(), 'render-run-'));
  work = mkdtempSync(join(tmpdir(), 'render-work-'));
  const result = await capture({ url: fixture.url, extraUrls: [], followDemoLinks: 0 }, dir);
  if (!result.ok) throw new Error(`The capture failed: ${result.message}`);
  site = JSON.parse(readFileSync(join(dir, 'site.json'), 'utf8')) as CapturedSite;
  edl = fixtureEdl();
});
afterAll(async () => {
  await fixture?.close();
  if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (work) rmSync(work, { recursive: true, force: true });
});

describe('the muted render', () => {
  const out = () => join(work, 'hook-a-9x16-muted.mp4');
  let result: { frames: number; seconds: number };
  beforeAll(async () => {
    result = await renderVideo({ edl, site, runDir: dir, out: out(), format: '9x16', hook: 0 });
    // The one bundle renderVideo made for this run folder.
    bundleDir = await getServeUrl(dir);
  });

  it('renders a muted h264 MP4 of the planned length', async () => {
    const planned = layoutScenes(edl, 0).total;
    const { duration, streams } = await probe(out());

    expect(result).toEqual({ frames: planned, seconds: planned / FPS });
    expect(Math.abs(duration - planned / FPS)).toBeLessThanOrEqual(1 / FPS);
    expect(streams.filter((s) => s.codec_type === 'video')).toEqual([
      expect.objectContaining({ codec_name: 'h264', width: FORMATS['9x16'].width, height: FORMATS['9x16'].height, r_frame_rate: `${FPS}/1` }),
    ]);
    expect(streams.filter((s) => s.codec_type === 'audio')).toEqual([]);
  });

  it('muxes a sine track to about -14 LUFS, and leaves the picture as rendered', async () => {
    const { seconds } = result;
    const sine = join(work, 'sine.wav');
    const track = join(work, 'track.wav');
    const mixed = join(work, 'hook-a-9x16.mp4');
    // A quiet 440 Hz tone, longer than the video and starting 0.3 s before its first beat.
    await runFfmpeg(['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-af', 'volume=0.1', '-ar', '44100', sine], 'make a test tone');

    await runFfmpeg(buildMusicArgs({ wav: sine, firstBeat: 0.3, seconds, out: track }), 'cut the music');
    await runFfmpeg(buildMuxArgs({ video: out(), audio: track, out: mixed }), 'mix the music into the video');

    const { duration, streams } = await probe(mixed);
    const lufs = await integratedLoudness(mixed);
    expect(lufs).toBeGreaterThanOrEqual(-15);
    expect(lufs).toBeLessThanOrEqual(-13);
    expect(streams.find((s) => s.codec_type === 'audio')?.codec_name).toBe('aac');
    // The picture is the render, copied: same codec and size, and the same length to within an audio frame.
    expect(streams.find((s) => s.codec_type === 'video')).toMatchObject({ codec_name: 'h264', width: FORMATS['9x16'].width, height: FORMATS['9x16'].height });
    expect(Math.abs(duration - seconds)).toBeLessThanOrEqual(0.1);
  });
});

describe('the render task, against a store of its own', () => {
  let store: Server;
  /** What the store was given: by path, the bytes and the headers of the PUT. */
  const written = new Map<string, { bytes: Buffer; headers: Record<string, string | string[] | undefined> }>();
  let base: string;
  const wav = join(tmpdir(), `render-test-track-${process.pid}.wav`);

  beforeAll(async () => {
    // Ten and a half seconds of a tone: the track the task is told to cut from 0.5 s on.
    await runFfmpeg(['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=10.5', '-af', 'volume=0.2', '-ar', '44100', wav], 'make a test tone');
    store = createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      if (req.method === 'GET') return void res.writeHead(200, { 'content-type': 'audio/wav' }).end(readFileSync(wav));
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        written.set(path, { bytes: Buffer.concat(chunks), headers: req.headers });
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((done) => store.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(store.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((done) => store.close(() => done()));
    rmSync(wav, { force: true });
  });

  const taskWith = (music: boolean): TaskEnvelope => ({
    id: 't1',
    kind: 'render',
    input: { edl, hook: 0, format: '9x16', music: music ? { firstBeat: 0.5, seconds: 10.5, path: 'orders/o1/music/cand-1.wav' } : null },
    urls: { muted: `${base}/out/muted.mp4?sig=SECRET`, withMusic: `${base}/out/with-music.mp4?sig=SECRET`, musicWav: `${base}/music/cand-1.wav?sig=SECRET` },
  });

  it('uploads the muted video and the one with the music, as the files the client downloads', async () => {
    const result = await renderTask(taskWith(true), dir);

    const planned = layoutScenes(edl, 0).total;
    expect(result).toEqual({ ok: true, frames: planned, seconds: planned / FPS, mutedBytes: expect.any(Number), withMusicBytes: expect.any(Number) } satisfies RenderResult);
    const muted = written.get('/out/muted.mp4');
    const withMusic = written.get('/out/with-music.mp4');
    if (!result.ok || !muted || !withMusic) throw new Error('The task did not upload both videos.');
    expect(muted.bytes.length).toBe(result.mutedBytes);
    expect(withMusic.bytes.length).toBe(result.withMusicBytes);
    expect(muted.headers).toMatchObject({ 'x-content-type': 'video/mp4', 'x-vercel-blob-access': 'private', 'content-length': String(result.mutedBytes) });
    expect(withMusic.headers).toMatchObject({ 'x-content-type': 'video/mp4', 'content-length': String(result.withMusicBytes) });

    const files = { muted: join(work, 'got-muted.mp4'), withMusic: join(work, 'got-with-music.mp4') };
    writeFileSync(files.muted, muted.bytes);
    writeFileSync(files.withMusic, withMusic.bytes);
    expect((await probe(files.muted)).streams.map((s) => s.codec_type)).toEqual(['video']);
    expect((await probe(files.withMusic)).streams.map((s) => `${s.codec_type}:${s.codec_name}`).sort()).toEqual(['audio:aac', 'video:h264']);
    const lufs = await integratedLoudness(files.withMusic);
    expect(lufs).toBeGreaterThanOrEqual(-15);
    expect(lufs).toBeLessThanOrEqual(-13);
    expect(statSync(files.withMusic).size).toBeGreaterThan(0);
  });

  it('with no music uploads only the muted video', async () => {
    written.clear();

    const result = await renderTask(taskWith(false), dir);

    expect(result).toMatchObject({ ok: true, withMusicBytes: null });
    expect([...written.keys()]).toEqual(['/out/muted.mp4']);
  });
});
