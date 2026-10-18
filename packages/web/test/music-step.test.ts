import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FPS, layoutScenes, musicPrompt } from '@app/core';
import { clickWav, encodeWav } from '@app/core/testing';
import { FileBlob } from '../src/adapters/fake/blob';
import { FakeMusic } from '../src/adapters/fake/music';
import { FileStore } from '../src/adapters/fake/store';
import { generateCandidate, pickTrack, runMusic, type MusicDeps } from '../src/pipeline/music';
import type { Order } from '../src/ports';
import { edlShop as shopEdl } from './support/shop';

const edl = shopEdl();
// The length of the video the music plays under: the prompt and the measuring both ask for it.
const VIDEO_SECONDS = layoutScenes(edl, 0).total / FPS;
const PROMPT = musicPrompt(edl, VIDEO_SECONDS);
const CAP = 2.5;
const LYRIA_USD = 0.08;

const dir = await mkdtemp(join(tmpdir(), 'music-step-'));
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
const store = new FileStore(dir);
const blob = new FileBlob(dir);

// A track for this video (112 bpm asked, 19.3 s long): hits long enough to read as music, so the start is not weak.
// `seconds` is longer than the video by default, so the track is not too short.
const track = (bpm: number, gainDb: number, seconds = 22) => clickWav({ bpm, seconds, offset: 0.2, gainDb, clickSeconds: 0.25 });

// Whether the blob at `path` holds exactly `bytes`. (toEqual on megabytes of audio takes seconds.)
const stored = async (path: string, bytes: Uint8Array): Promise<boolean> => Buffer.from(await blob.get(path)).equals(bytes);

let orders = 0;
let id: string;
let music: FakeMusic;
let deps: MusicDeps;

const orderWith = (audio: 'music' | 'none' | 'voice'): Pick<Order, 'id' | 'request'> => ({ id, request: { url: 'https://example.com', audio } });
const run = (audio: 'music' | 'none' | 'voice' = 'music') => runMusic({ order: orderWith(audio), edl, deps });

beforeEach(() => {
  orders += 1;
  id = `ord_music${orders}`;
  music = new FakeMusic();
  deps = { store, blob, music, spendCap: CAP };
});

describe('runMusic', () => {
  it('skips Lyria when audio is none', async () => {
    expect(await run('none')).toEqual({ track: null, warnings: [] });
    expect(music.calls).toBe(0);
    expect(await store.orderCost(id)).toBe(0);
  });

  it('generates two candidates and keeps the more energetic valid one', async () => {
    music.queue = [track(113, -10), track(113, -6)];
    const { track: chosen, warnings } = await run();
    expect(music.calls).toBe(2);
    expect(warnings).toEqual([]);
    expect(chosen).toMatchObject({ path: `orders/${id}/music/cand-2.wav`, seconds: 22 });
    expect(chosen?.measuredBpm).toBeCloseTo(113, 0);
    expect(chosen?.firstBeat).toBeCloseTo(0.2, 1);
  });

  it('keeps the first when it is the more energetic', async () => {
    music.queue = [track(113, -6), track(113, -10)];
    expect((await run()).track?.path).toBe(`orders/${id}/music/cand-1.wav`);
  });

  it('prefers a quieter track that passes to a louder one that does not', async () => {
    music.queue = [track(140, -6), track(113, -10)];
    const { track: chosen } = await run();
    expect(chosen?.path).toBe(`orders/${id}/music/cand-2.wav`);
    expect(music.calls).toBe(2);
  });

  it('asks for a third candidate when neither passes', async () => {
    music.queue = [track(140, -6), track(140, -6), track(113, -6)];
    const { track: chosen, warnings } = await run();
    expect(music.calls).toBe(3);
    expect(warnings).toEqual([]);
    expect(chosen?.path).toBe(`orders/${id}/music/cand-3.wav`);
  });

  it('delivers without music and warns when no candidate passes', async () => {
    music.queue = [track(140, -6), track(140, -6), track(140, -6)];
    expect(await run()).toEqual({ track: null, warnings: ['music_unavailable'] });
    // Three tries, and no more.
    expect(music.calls).toBe(3);
  });

  it('does not ask for a third candidate past the budget', async () => {
    await store.addCost(id, 'earlier calls', 2.45, 'card');
    music.queue = [track(140, -6), track(140, -6), track(113, -6)];
    expect(await run()).toEqual({ track: null, warnings: ['music_unavailable'] });
    expect(music.calls).toBe(2);
  });

  it('asks for the third candidate when it fits the cap exactly', async () => {
    // 2.26 + 2 x 0.08 = 2.42 is spent before the third, and the third brings it to 2.5: within the cap.
    await store.addCost(id, 'earlier calls', 2.26, 'card');
    music.queue = [track(140, -6), track(140, -6), track(113, -6)];
    expect((await run()).track?.path).toBe(`orders/${id}/music/cand-3.wav`);
    expect(music.calls).toBe(3);
  });

  it('stores the WAVs under orders/<id>/music and records 0.08 per call', async () => {
    const [first, second] = [track(113, -10), track(113, -6)];
    music.queue = [first, second];
    await run();
    expect(await stored(`orders/${id}/music/cand-1.wav`, first)).toBe(true);
    expect(await stored(`orders/${id}/music/cand-2.wav`, second)).toBe(true);
    expect(await store.orderCost(id)).toBeCloseTo(2 * LYRIA_USD, 6);
  });

  it('asks Lyria for the prompt of the edit list, at the length of its video', async () => {
    music.queue = [track(113, -10), track(113, -6)];
    await run();
    expect(music.prompts).toEqual([PROMPT, PROMPT]);
  });

  it('measures against the length of the video: a track shorter than it does not pass', async () => {
    // Louder, but it ends before the video does.
    music.queue = [track(113, -6, 15), track(113, -10)];
    expect((await run()).track?.path).toBe(`orders/${id}/music/cand-2.wav`);
  });

  it('counts a track it cannot measure as one that failed, not as an error', async () => {
    const silence = encodeWav([new Float32Array(22 * 44100)], { sampleRate: 44100, bits: 16 });
    music.queue = [silence, track(113, -6)];
    const { track: chosen } = await run();
    expect(chosen?.path).toBe(`orders/${id}/music/cand-2.wav`);
    expect(music.calls).toBe(2);
  });

  it('delivers without music and warns when every track is silent', async () => {
    const silence = encodeWav([new Float32Array(22 * 44100)], { sampleRate: 44100, bits: 16 });
    music.queue = [silence, silence, silence];
    expect(await run()).toEqual({ track: null, warnings: ['music_unavailable'] });
  });

  it('lets a failed Lyria call fail the step, after recording what the earlier ones cost', async () => {
    music.queue = [track(113, -6)];
    music.failAt = 2;
    await expect(run()).rejects.toThrow('Lyria is down');
    expect(await store.orderCost(id)).toBeCloseTo(LYRIA_USD, 6);
  });

  it('works with the track the double makes when it is told nothing', async () => {
    const { track: chosen, warnings } = await run();
    expect(warnings).toEqual([]);
    expect(chosen?.measuredBpm).toBeCloseTo(edl.bpm, 0);
    expect(chosen?.seconds).toBeGreaterThanOrEqual(VIDEO_SECONDS);
    expect(music.calls).toBe(2);
  });
});

describe('generateCandidate', () => {
  const args = () => ({ orderId: id, prompt: PROMPT, index: 1, bpm: edl.bpm, videoSeconds: VIDEO_SECONDS });

  it('generates a track, stores it and measures it', async () => {
    const wav = track(113, -6);
    music.queue = [wav];
    const { path, measure } = await generateCandidate(args(), deps);
    expect(path).toBe(`orders/${id}/music/cand-1.wav`);
    expect(await stored(path, wav)).toBe(true);
    expect(music.prompts).toEqual([PROMPT]);
    expect(measure).toMatchObject({ seconds: 22 });
    expect(measure?.measuredBpm).toBeCloseTo(113, 0);
    expect(measure?.energyDb).toBeGreaterThan(-30);
  });

  it('records the cost of the call on the order', async () => {
    music.queue = [track(113, -6)];
    await generateCandidate(args(), deps);
    expect(await store.orderCost(id)).toBeCloseTo(LYRIA_USD, 6);
  });

  it('records the cost even if the track cannot be stored, since Lyria has billed it', async () => {
    music.queue = [track(113, -6)];
    const broken = { ...deps, blob: { put: async () => Promise.reject(new Error('blob is down')) } };
    await expect(generateCandidate(args(), broken)).rejects.toThrow('blob is down');
    expect(await store.orderCost(id)).toBeCloseTo(LYRIA_USD, 6);
  });

  it('says there is no measure for a track with no beat, and still stores it and records its cost', async () => {
    const silence = encodeWav([new Float32Array(22 * 44100)], { sampleRate: 44100, bits: 16 });
    music.queue = [silence];
    const { path, measure } = await generateCandidate(args(), deps);
    expect(measure).toBeNull();
    expect(await stored(path, silence)).toBe(true);
    expect(await store.orderCost(id)).toBeCloseTo(LYRIA_USD, 6);
  });

  it('says there is no measure for a RIFF file that is not a WAV it can read', async () => {
    const broken = new TextEncoder().encode('RIFF....WAVEjunk');
    music.queue = [broken];
    expect((await generateCandidate(args(), deps)).measure).toBeNull();
  });

  it('writes to the same path when it runs again for the same candidate, as a retried step does', async () => {
    const [first, second] = [track(113, -10), track(113, -6)];
    music.queue = [first, second];
    const a = await generateCandidate(args(), deps);
    const b = await generateCandidate(args(), deps);
    expect(b.path).toBe(a.path);
    expect(await stored(b.path, second)).toBe(true);
    // Both calls were billed.
    expect(await store.orderCost(id)).toBeCloseTo(2 * LYRIA_USD, 6);
  });
});

describe('pickTrack', () => {
  const base = () => ({ orderId: id, prompt: PROMPT, bpm: edl.bpm, videoSeconds: VIDEO_SECONDS });

  it('keeps the track that passes and asks for no more', async () => {
    music.queue = [track(113, -6), track(140, -6)];
    const candidates = [await generateCandidate({ ...base(), index: 1 }, deps), await generateCandidate({ ...base(), index: 2 }, deps)];
    const chosen = await pickTrack({ ...base(), candidates }, deps);
    expect(chosen?.path).toBe(`orders/${id}/music/cand-1.wav`);
    expect(music.calls).toBe(2);
  });

  it('numbers the extra candidate after the ones it was given', async () => {
    music.queue = [track(140, -6), track(113, -6)];
    const first = await generateCandidate({ ...base(), index: 1 }, deps);
    const chosen = await pickTrack({ ...base(), candidates: [first] }, deps);
    expect(chosen?.path).toBe(`orders/${id}/music/cand-2.wav`);
  });

  it('asks for at most one extra candidate', async () => {
    music.queue = [track(140, -6), track(140, -6), track(140, -6), track(113, -6)];
    const candidates = [await generateCandidate({ ...base(), index: 1 }, deps), await generateCandidate({ ...base(), index: 2 }, deps)];
    expect(await pickTrack({ ...base(), candidates }, deps)).toBeNull();
    expect(music.calls).toBe(3);
  });

  it('gives the tempo, the first beat and the length of the track it chose', async () => {
    music.queue = [track(113, -6)];
    const first = await generateCandidate({ ...base(), index: 1 }, deps);
    const chosen = await pickTrack({ ...base(), candidates: [first] }, deps);
    expect(chosen).toEqual({
      path: first.path,
      measuredBpm: first.measure?.measuredBpm,
      firstBeat: first.measure?.firstBeat,
      seconds: first.measure?.seconds,
    });
  });
});
