import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FatalError } from 'workflow';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FPS, layoutScenes, MUSIC_MODELS, musicPrompt } from '@app/core';
import { clickWav, encodeWav } from '@app/core/testing';
import { FileBlob } from '../src/adapters/fake/blob';
import { FakeMusic } from '../src/adapters/fake/music';
import { FileStore } from '../src/adapters/fake/store';
import { LyriaMusic, type LyriaClient } from '../src/adapters/real/music';
import { failedCandidate, generateCandidate, modelForCandidate, musicRequest, pickTrack, runMusic, type Candidate, type MusicDeps } from '../src/pipeline/music';
import { MusicOutputInvalid, type CostKind, type MusicPort, type Order } from '../src/ports';
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
const silence = () => encodeWav([new Float32Array(22 * 44100)], { sampleRate: 44100, bits: 16 });

// Whether the blob at `path` holds exactly `bytes`. (toEqual on megabytes of audio takes seconds.)
const stored = async (path: string, bytes: Uint8Array): Promise<boolean> => Buffer.from(await blob.get(path)).equals(bytes);
const isStored = (path: string): Promise<boolean> => blob.get(path).then(() => true, () => false);

// Lyria, call by call: a track is given back, an error is thrown. It counts its calls, and a track says it was made by the
// model it was asked for.
const scripted = (outcomes: (Uint8Array | Error)[]): MusicPort & { calls: number } => {
  const port: MusicPort & { calls: number } = {
    calls: 0,
    async generate(_prompt, model) {
      const outcome = outcomes[port.calls];
      port.calls += 1;
      if (outcome === undefined) throw new Error('the script has no outcome for this call');
      if (outcome instanceof Error) throw outcome;
      return { wav: outcome, model, usd: LYRIA_USD };
    },
  };
  return port;
};
const billedRefusal = () => new MusicOutputInvalid('Lyria did not answer with a WAV file (audio/mpeg).', LYRIA_USD);

type Cost = { orderId: string; item: string; usd: number; kind: CostKind };

let orders = 0;
let id: string;
let music: FakeMusic;
let costs: Cost[];
let deps: MusicDeps;

// The store, writing down every cost it is given.
const recording = (): MusicDeps['store'] => ({
  addCost: async (orderId, item, usd, kind) => {
    costs.push({ orderId, item, usd, kind });
    await store.addCost(orderId, item, usd, kind);
  },
  orderCost: (orderId) => store.orderCost(orderId),
});

const orderWith = (audio: 'music' | 'none' | 'voice'): Pick<Order, 'id' | 'request'> => ({ id, request: { url: 'https://example.com', audio } });
const run = (audio: 'music' | 'none' | 'voice' = 'music', port: MusicPort = music) => runMusic({ order: orderWith(audio), edl, deps: { ...deps, music: port } });

beforeEach(() => {
  orders += 1;
  id = `ord_music${orders}`;
  music = new FakeMusic();
  costs = [];
  deps = { store: recording(), blob, music, spendCap: CAP };
});

describe('musicRequest', () => {
  it('asks for the prompt, the tempo and the length of the edit list, so the flow does not work them out again', () => {
    expect(musicRequest('ord_x', edl)).toEqual({ orderId: 'ord_x', prompt: PROMPT, bpm: edl.bpm, videoSeconds: VIDEO_SECONDS });
  });
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

  it('delivers without music and warns when no candidate passes, saying why each failed', async () => {
    music.queue = [track(140, -6), track(140, -6), track(140, -6)];
    const result = await run();
    expect(result).toMatchObject({ track: null, warnings: ['music_unavailable'] });
    expect(result.rejected).toEqual([
      { index: 1, model: 'lyria-3.5', reason: 'bpm' },
      { index: 2, model: 'lyria-3-pro-preview', reason: 'bpm' },
      { index: 3, model: 'lyria-3.5', reason: 'bpm' },
    ]);
    // Three tries, and no more.
    expect(music.calls).toBe(3);
  });

  it('does not ask for a third candidate past the budget', async () => {
    await store.addCost(id, 'earlier calls', 2.45, 'card');
    music.queue = [track(140, -6), track(140, -6), track(113, -6)];
    expect(await run()).toMatchObject({ track: null, warnings: ['music_unavailable'] });
    expect(music.calls).toBe(2);
  });

  it('does not ask for a third candidate when it would take the order just over the cap', async () => {
    // 2.27 + 2 x 0.08 = 2.43 before the third, and the third would make it 2.51.
    await store.addCost(id, 'earlier calls', 2.27, 'card');
    music.queue = [track(140, -6), track(140, -6), track(113, -6)];
    expect(await run()).toMatchObject({ track: null, warnings: ['music_unavailable'] });
    expect(music.calls).toBe(2);
  });

  it('asks for the third candidate when it fits the cap exactly', async () => {
    // 2.26 + 2 x 0.08 = 2.42 is spent before the third, and the third brings it to 2.5: within the cap.
    await store.addCost(id, 'earlier calls', 2.26, 'card');
    music.queue = [track(140, -6), track(140, -6), track(113, -6)];
    expect((await run()).track?.path).toBe(`orders/${id}/music/cand-3.wav`);
    expect(music.calls).toBe(3);
  });

  it('stores the WAVs under orders/<id>/music and records 0.08 per call, as a card cost named for the candidate', async () => {
    const [first, second] = [track(113, -10), track(113, -6)];
    music.queue = [first, second];
    await run();
    expect(await stored(`orders/${id}/music/cand-1.wav`, first)).toBe(true);
    expect(await stored(`orders/${id}/music/cand-2.wav`, second)).toBe(true);
    expect(costs).toEqual([
      { orderId: id, item: 'music:cand-1', usd: LYRIA_USD, kind: 'card' },
      { orderId: id, item: 'music:cand-2', usd: LYRIA_USD, kind: 'card' },
    ]);
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
    const result = await run();
    expect(result.track?.path).toBe(`orders/${id}/music/cand-2.wav`);
    expect(result.rejected).toEqual([{ index: 1, model: 'lyria-3.5', reason: 'too-short' }]);
  });

  it('counts a track it cannot measure as one that failed, not as an error', async () => {
    music.queue = [silence(), track(113, -6)];
    const result = await run();
    expect(result.track?.path).toBe(`orders/${id}/music/cand-2.wav`);
    expect(music.calls).toBe(2);
    expect(result.rejected).toEqual([{ index: 1, model: 'lyria-3.5', reason: 'unmeasurable', detail: expect.stringContaining('could not measure the tempo') }]);
  });

  it('delivers without music and warns when every track is silent', async () => {
    music.queue = [silence(), silence(), silence()];
    expect(await run()).toMatchObject({ track: null, warnings: ['music_unavailable'] });
  });

  it('counts a Lyria call that throws as a candidate that failed, and keeps the other track', async () => {
    music.queue = [track(113, -6)];
    music.failAt = [2];
    const result = await run();
    expect(result.track?.path).toBe(`orders/${id}/music/cand-1.wav`);
    expect(result.warnings).toEqual([]);
    expect(result.rejected).toEqual([{ index: 2, model: 'lyria-3-pro-preview', reason: 'failed', detail: 'Error' }]);
    // Only the call that gave a track was billed.
    expect(await store.orderCost(id)).toBeCloseTo(LYRIA_USD, 6);
    // One track is enough: nothing more is asked for.
    expect(music.calls).toBe(2);
  });

  it('asks for a third candidate when both calls threw', async () => {
    music.failAt = [1, 2];
    const result = await run();
    expect(music.calls).toBe(3);
    expect(result.track?.path).toBe(`orders/${id}/music/cand-3.wav`);
    expect(result.rejected).toEqual([
      { index: 1, model: 'lyria-3.5', reason: 'failed', detail: 'Error' },
      { index: 2, model: 'lyria-3-pro-preview', reason: 'failed', detail: 'Error' },
    ]);
  });

  it('delivers without music and warns when every call threw, having paid for none', async () => {
    music.failAt = [1, 2, 3];
    expect(await run()).toMatchObject({ track: null, warnings: ['music_unavailable'] });
    expect(music.calls).toBe(3);
    expect(costs).toEqual([]);
  });

  it('counts an answer Lyria billed and the code refused as a failed candidate that was paid for', async () => {
    const port = scripted([billedRefusal(), track(113, -6)]);
    const result = await run('music', port);
    expect(result.track?.path).toBe(`orders/${id}/music/cand-2.wav`);
    expect(result.rejected).toEqual([{ index: 1, model: 'lyria-3.5', reason: 'failed', detail: 'Lyria did not answer with a WAV file (audio/mpeg).' }]);
    expect(costs.map(({ item, usd }) => [item, usd])).toEqual([
      ['music:cand-1', LYRIA_USD],
      ['music:cand-2', LYRIA_USD],
    ]);
  });

  it('counts what the refused answers cost when it decides about a third candidate', async () => {
    // 2.27 spent, and the two refused answers were paid for: 2.43. A third would take the order to 2.51.
    await store.addCost(id, 'earlier calls', 2.27, 'card');
    const port = scripted([billedRefusal(), billedRefusal(), track(113, -6)]);
    const result = await run('music', port);
    expect(result.track).toBeNull();
    expect(port.calls).toBe(2);
    expect(await store.orderCost(id)).toBeCloseTo(2.27 + 2 * LYRIA_USD, 6);
  });

  it('works with the track the double makes when it is told nothing', async () => {
    const { track: chosen, warnings } = await run();
    expect(warnings).toEqual([]);
    expect(chosen?.measuredBpm).toBeCloseTo(edl.bpm, 0);
    expect(chosen?.seconds).toBeGreaterThanOrEqual(VIDEO_SECONDS);
    expect(music.calls).toBe(2);
  });

  describe('the models of the candidates', () => {
    it('asks the first two candidates, which are always made together, for one track of each model: Lyria 3.5 and Lyria 3 Pro', async () => {
      music.queue = [track(113, -10), track(113, -6)];
      await run();
      expect(music.models).toEqual(['lyria-3.5', 'lyria-3-pro-preview']);
    });

    it('asks the third candidate, when neither of the first passes, for Lyria 3.5', async () => {
      music.queue = [track(140, -6), track(140, -6), track(113, -6)];
      await run();
      expect(music.models).toEqual(['lyria-3.5', 'lyria-3-pro-preview', 'lyria-3.5']);
    });

    it('asks for the models in the order of MUSIC_MODELS, whatever comes of the candidates', async () => {
      music.failAt = [1, 2, 3];
      await run();
      expect(music.models).toEqual([...MUSIC_MODELS]);
    });

    it('names the model that made the chosen track: Lyria 3.5 for the first', async () => {
      music.queue = [track(113, -6), track(113, -10)];
      expect((await run()).track).toMatchObject({ path: `orders/${id}/music/cand-1.wav`, model: 'lyria-3.5' });
    });

    it('names the model that made the chosen track: Lyria 3 Pro for the second', async () => {
      music.queue = [track(113, -10), track(113, -6)];
      expect((await run()).track).toMatchObject({ path: `orders/${id}/music/cand-2.wav`, model: 'lyria-3-pro-preview' });
    });

    it('names the model that made the chosen track: Lyria 3.5 again for the third, at the price of the others', async () => {
      music.queue = [track(140, -6), track(140, -6), track(113, -6)];
      const result = await run();
      expect(result.track).toMatchObject({ path: `orders/${id}/music/cand-3.wav`, model: 'lyria-3.5' });
      expect(costs).toEqual([1, 2, 3].map((n) => ({ orderId: id, item: `music:cand-${n}`, usd: LYRIA_USD, kind: 'card' })));
    });

    it('names the model the track says it was made by, not the one of its number', async () => {
      const port = scripted([track(140, -6), track(140, -6), track(113, -6)]);
      const generate = port.generate.bind(port);
      port.generate = async (prompt, model) => ({ ...(await generate(prompt, model)), model: 'lyria-3-pro-preview' });
      expect((await run('music', port)).track).toMatchObject({ path: `orders/${id}/music/cand-3.wav`, model: 'lyria-3-pro-preview' });
    });

    it('says in the rejections which model made the candidate that failed a check: Lyria 3.5 for the first', async () => {
      music.queue = [track(140, -6), track(113, -6)];
      expect((await run()).rejected).toEqual([{ index: 1, model: 'lyria-3.5', reason: 'bpm' }]);
    });

    it('says in the rejections which model made the candidate that failed a check: Lyria 3 Pro for the second', async () => {
      music.queue = [track(113, -6), track(140, -6)];
      expect((await run()).rejected).toEqual([{ index: 2, model: 'lyria-3-pro-preview', reason: 'bpm' }]);
    });

    it('says in the rejections the model of a candidate that could not be measured', async () => {
      music.queue = [track(113, -6), silence()];
      expect((await run()).rejected).toEqual([{ index: 2, model: 'lyria-3-pro-preview', reason: 'unmeasurable', detail: expect.any(String) }]);
    });

    it('says in the rejections the model of a candidate whose call failed', async () => {
      music.queue = [track(113, -6)];
      music.failAt = [2];
      expect((await run()).rejected).toEqual([{ index: 2, model: 'lyria-3-pro-preview', reason: 'failed', detail: 'Error' }]);
    });
  });
});

describe('modelForCandidate', () => {
  it('gives the model of each candidate, numbered from 1: Lyria 3.5, Lyria 3 Pro and Lyria 3.5', () => {
    expect([1, 2, 3].map(modelForCandidate)).toEqual(['lyria-3.5', 'lyria-3-pro-preview', 'lyria-3.5']);
  });

  it('is the list of MUSIC_MODELS, in order', () => {
    expect(MUSIC_MODELS.map((_, k) => modelForCandidate(k + 1))).toEqual([...MUSIC_MODELS]);
  });

  it.each([0, 4, -1, 1.5, Number.NaN])('refuses a candidate numbered %s: there is no model for it', (index) => {
    expect(() => modelForCandidate(index)).toThrow(RangeError);
  });
});

describe('generateCandidate', () => {
  const args = (index = 1) => ({ ...musicRequest(id, edl), index });

  it('generates a track, stores it and measures it', async () => {
    const wav = track(113, -6);
    music.queue = [wav];
    const candidate = await generateCandidate(args(), deps);
    expect(candidate).toMatchObject({ index: 1, path: `orders/${id}/music/cand-1.wav`, problem: null });
    expect(await stored(`orders/${id}/music/cand-1.wav`, wav)).toBe(true);
    expect(music.prompts).toEqual([PROMPT]);
    expect(candidate.measure).toMatchObject({ seconds: 22 });
    expect(candidate.measure?.measuredBpm).toBeCloseTo(113, 0);
    expect(candidate.measure?.energyDb).toBeGreaterThan(-30);
  });

  it('records the cost of the call on the order once, as a card cost named for the candidate', async () => {
    music.queue = [track(113, -6)];
    await generateCandidate(args(2), deps);
    expect(costs).toEqual([{ orderId: id, item: 'music:cand-2', usd: LYRIA_USD, kind: 'card' }]);
  });

  it('records the cost even if the track cannot be stored, since Lyria has billed it', async () => {
    music.queue = [track(113, -6)];
    const broken = { ...deps, blob: { put: async () => Promise.reject(new Error('blob is down')) } };
    await expect(generateCandidate(args(), broken)).rejects.toThrow('blob is down');
    expect(costs).toHaveLength(1);
  });

  it('says there is no measure for a track with no beat, and still stores it and records its cost', async () => {
    const quiet = silence();
    music.queue = [quiet];
    const candidate = await generateCandidate(args(), deps);
    expect(candidate).toMatchObject({ index: 1, path: `orders/${id}/music/cand-1.wav`, measure: null });
    expect(candidate.problem).toContain('could not measure the tempo');
    expect(await stored(`orders/${id}/music/cand-1.wav`, quiet)).toBe(true);
    expect(costs).toHaveLength(1);
  });

  it('says there is no measure for a RIFF file that is not a WAV it can read', async () => {
    music.queue = [new TextEncoder().encode('RIFF....WAVEjunk')];
    const candidate = await generateCandidate(args(), deps);
    expect(candidate.measure).toBeNull();
    expect(candidate.problem).toBe('WAV has no fmt chunk');
  });

  it('writes to the same path when it runs again for the same candidate, as a retried step does', async () => {
    const [first, second] = [track(113, -10), track(113, -6)];
    music.queue = [first, second];
    const a = await generateCandidate(args(), deps);
    const b = await generateCandidate(args(), deps);
    expect(b.path).toBe(a.path);
    expect(await stored(b.path ?? '', second)).toBe(true);
    // Both calls were billed.
    expect(await store.orderCost(id)).toBeCloseTo(2 * LYRIA_USD, 6);
  });

  describe('when Lyria answers with something that is not a WAV', () => {
    // The real adapter over a stand-in client: what it refuses is billed, and the pipeline has to know.
    const lyria = (reply: Awaited<ReturnType<LyriaClient['interactions']['create']>>) =>
      new LyriaMusic({ interactions: { create: async () => reply } });
    const mp3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]).toString('base64');

    it('records what the call cost, once, and fails for good', async () => {
      const failure = await generateCandidate(args(), { ...deps, music: lyria({ output_audio: { data: mp3, mime_type: 'audio/mpeg' } }) }).catch((error: unknown) => error);
      expect(FatalError.is(failure)).toBe(true);
      expect(failure).toBeInstanceOf(MusicOutputInvalid);
      expect(costs).toEqual([{ orderId: id, item: 'music:cand-1', usd: LYRIA_USD, kind: 'card' }]);
      expect(await store.orderCost(id)).toBeCloseTo(LYRIA_USD, 6);
    });

    it('records the cost of an answer with no audio too', async () => {
      const failure = await generateCandidate(args(), { ...deps, music: lyria({}) }).catch((error: unknown) => error);
      expect(FatalError.is(failure)).toBe(true);
      expect(costs).toEqual([{ orderId: id, item: 'music:cand-1', usd: LYRIA_USD, kind: 'card' }]);
    });

    it('keeps nothing in the blob store', async () => {
      await generateCandidate(args(), { ...deps, music: lyria({ output_audio: { data: mp3 } }) }).catch(() => undefined);
      expect(await isStored(`orders/${id}/music/cand-1.wav`)).toBe(false);
    });
  });

  it('records nothing for a call that fails without an answer, and lets the error through', async () => {
    const failure = await generateCandidate(args(), { ...deps, music: scripted([new Error('503 Service Unavailable')]) }).catch((error: unknown) => error);
    expect(failure).toEqual(new Error('503 Service Unavailable'));
    expect(costs).toEqual([]);
  });

  describe('the model of the candidate', () => {
    it.each([
      [1, 'lyria-3.5'],
      [2, 'lyria-3-pro-preview'],
      [3, 'lyria-3.5'],
    ] as const)('asks for the model of its number: candidate %i asks for %s, and keeps it', async (index, model) => {
      music.queue = [track(113, -6)];
      const candidate = await generateCandidate(args(index), deps);
      expect(music.models).toEqual([model]);
      expect(candidate).toMatchObject({ index, model });
    });

    it('asks for the same model when it runs again for the same candidate, as a retried step does', async () => {
      music.queue = [track(113, -10), track(113, -6), track(113, -10), track(113, -6)];
      await generateCandidate(args(2), deps);
      await generateCandidate(args(2), deps);
      await generateCandidate(args(1), deps);
      await generateCandidate(args(1), deps);
      expect(music.models).toEqual(['lyria-3-pro-preview', 'lyria-3-pro-preview', 'lyria-3.5', 'lyria-3.5']);
    });

    it('keeps the model the track says it was made by', async () => {
      const port = scripted([track(113, -6)]);
      const generate = port.generate.bind(port);
      port.generate = async (prompt) => generate(prompt, 'lyria-3-pro-preview');
      expect(await generateCandidate(args(1), { ...deps, music: port })).toMatchObject({ index: 1, model: 'lyria-3-pro-preview' });
    });

    it.each([0, 4])('asks Lyria for nothing, and records nothing, for a candidate numbered %i', async (index) => {
      const failure = await generateCandidate(args(index), deps).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(RangeError);
      expect(music.calls).toBe(0);
      expect(costs).toEqual([]);
    });
  });
});

describe('failedCandidate', () => {
  it('stands for a candidate that has no track, and says only the kind of error', () => {
    expect(failedCandidate(2, new Error('the request held the prompt'))).toEqual({ index: 2, model: 'lyria-3-pro-preview', path: null, measure: null, problem: 'Error' });
  });

  it('says the HTTP status of the error when it has one', () => {
    const error = Object.assign(new Error('503 down'), { name: 'InternalServerError', status: 503 });
    expect(failedCandidate(1, error).problem).toBe('InternalServerError (HTTP 503)');
  });

  it('keeps what the adapter says of an answer it refused, which is written for that', () => {
    expect(failedCandidate(1, billedRefusal()).problem).toBe('Lyria did not answer with a WAV file (audio/mpeg).');
  });

  it('is not an Error, so a thing that was thrown and is not one is named as such', () => {
    expect(failedCandidate(1, 'boom').problem).toBe('unknown error');
  });

  it('names the model the candidate was asked for, by its number', () => {
    expect([1, 2, 3].map((index) => failedCandidate(index, new Error('x')).model)).toEqual(['lyria-3.5', 'lyria-3-pro-preview', 'lyria-3.5']);
  });
});

describe('pickTrack', () => {
  const base = () => musicRequest(id, edl);
  const made = async (...indexes: number[]): Promise<Candidate[]> => {
    const candidates: Candidate[] = [];
    for (const index of indexes) candidates.push(await generateCandidate({ ...base(), index }, deps));
    return candidates;
  };

  it('keeps the track that passes and asks for no more', async () => {
    music.queue = [track(113, -6), track(140, -6)];
    const candidates = await made(1, 2);
    const picked = await pickTrack({ ...base(), candidates }, deps);
    expect(picked.track?.path).toBe(`orders/${id}/music/cand-1.wav`);
    expect(picked.rejected).toEqual([{ index: 2, model: 'lyria-3-pro-preview', reason: 'bpm' }]);
    expect(picked.candidates).toEqual(candidates);
    expect(music.calls).toBe(2);
  });

  it('names the jump as the reason a track that jumps is not chosen, and asks for another', async () => {
    music.queue = [track(113, -6), track(113, -10)];
    const [first] = await made(1);
    if (first?.measure == null) throw new Error('the first candidate was not measured');
    const candidates = [{ ...first, measure: { ...first.measure, maxJumpMs: 40 } }];
    const picked = await pickTrack({ ...base(), candidates }, deps);
    expect(picked.rejected).toEqual([{ index: 1, model: 'lyria-3.5', reason: 'jump' }]);
    expect(picked.track?.path).toBe(`orders/${id}/music/cand-2.wav`);
    expect(music.calls).toBe(2);
  });

  it('gives the tempo, the first beat and the length of the track it chose', async () => {
    music.queue = [track(113, -6)];
    const [first] = await made(1);
    const { track: chosen } = await pickTrack({ ...base(), candidates: first ? [first] : [] }, deps);
    expect(chosen).toEqual({
      path: first?.path,
      model: 'lyria-3.5',
      measuredBpm: first?.measure?.measuredBpm,
      firstBeat: first?.measure?.firstBeat,
      seconds: first?.measure?.seconds,
    });
  });

  it('numbers the extra candidate after the highest one it was given, so a dropped candidate does not make two collide', async () => {
    // Candidate 1 failed and was left out: the ones given are 2 alone. The extra one is 3, and 2 is not overwritten.
    music.queue = [track(140, -6), track(113, -6)];
    const [second] = await made(2);
    const picked = await pickTrack({ ...base(), candidates: second ? [second] : [] }, deps);
    expect(picked.track?.path).toBe(`orders/${id}/music/cand-3.wav`);
    expect(picked.candidates.map((c) => c.index)).toEqual([2, 3]);
    // The extra candidate asks for the model of its number: the third is Lyria 3.5, after the second (Lyria 3 Pro) that was given.
    expect(music.models).toEqual(['lyria-3-pro-preview', 'lyria-3.5']);
    expect(picked.track?.model).toBe('lyria-3.5');
  });

  it('asks for the model of its number when the extra candidate is the second, after a first that failed', async () => {
    music.queue = [track(113, -6)];
    const picked = await pickTrack({ ...base(), candidates: [failedCandidate(1, new Error('x'))] }, deps);
    expect(picked.candidates.map((c) => c.index)).toEqual([1, 2]);
    expect(music.models).toEqual(['lyria-3-pro-preview']);
    expect(picked.track).toMatchObject({ path: `orders/${id}/music/cand-2.wav`, model: 'lyria-3-pro-preview' });
  });

  it('counts the candidates that failed, if it is given them', async () => {
    music.queue = [track(113, -6)];
    const candidates = [failedCandidate(1, new Error('x')), failedCandidate(2, new Error('x'))];
    const picked = await pickTrack({ ...base(), candidates }, deps);
    expect(picked.track?.path).toBe(`orders/${id}/music/cand-3.wav`);
    expect(picked.rejected).toEqual([
      { index: 1, model: 'lyria-3.5', reason: 'failed', detail: 'Error' },
      { index: 2, model: 'lyria-3-pro-preview', reason: 'failed', detail: 'Error' },
    ]);
  });

  it('asks for at most three candidates in all', async () => {
    music.queue = [track(140, -6), track(140, -6), track(140, -6), track(113, -6)];
    const candidates = await made(1, 2);
    const picked = await pickTrack({ ...base(), candidates }, deps);
    expect(picked.track).toBeNull();
    expect(music.calls).toBe(3);
    // Given three, it asks for no more.
    expect(await pickTrack({ ...base(), candidates: picked.candidates }, deps)).toMatchObject({ track: null });
    expect(music.calls).toBe(3);
  });

  it('asks for no more once the highest candidate it was given is the third, even if the others were left out', async () => {
    const picked = await pickTrack({ ...base(), candidates: [failedCandidate(3, new Error('x'))] }, deps);
    expect(picked.track).toBeNull();
    expect(music.calls).toBe(0);
  });

  it('turns a Lyria call that throws, in the extra candidate, into a failed one', async () => {
    music.failAt = [1];
    const picked = await pickTrack({ ...base(), candidates: [] }, deps);
    expect(picked.track).toBeNull();
    expect(picked.candidates).toEqual([{ index: 1, model: 'lyria-3.5', path: null, measure: null, problem: 'Error' }]);
  });
});
