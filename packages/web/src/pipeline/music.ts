// The music step: Lyria writes two tracks for the video, the code measures them (tempo, steadiness, first beat, level) and
// the one that suits the video is chosen by those figures. When neither does and the order's spending cap allows it, a
// third is asked for. When no track passes, the video goes out without music and says so. Every track is kept in Blob and
// every call is recorded on the order as it is made.
import { chooseTrack, FPS, layoutScenes, measureTrack, musicPrompt, parseWav, type Edl, type TrackMeasure } from '@app/core';
import type { BlobPort, MusicPort, Order, OrderStore } from '../ports';
import { canAfford, EST } from './budget';

/** How many tracks are asked for at first, and at most. */
const FIRST_CANDIDATES = 2;
const MAX_CANDIDATES = 3;

export type MusicDeps = {
  store: Pick<OrderStore, 'addCost' | 'orderCost'>;
  blob: Pick<BlobPort, 'put'>;
  music: MusicPort;
  /** SPEND_CAP_PER_ORDER_USD. */
  spendCap: number;
};

/** A track that was made. `measure` is null when it has no tempo to find (silence, noise, or something that is not music). */
export type Candidate = { path: string; measure: TrackMeasure | null };

/** The track the video uses, and what the render needs to know of it. */
export type ChosenTrack = { path: string; measuredBpm: number; firstBeat: number; seconds: number };

type Request = {
  orderId: string;
  prompt: string;
  /** The tempo the edit list asks for: the cuts land on its beats. */
  bpm: number;
  /** The length of the video the track plays under. */
  videoSeconds: number;
};

/** Where the track of a candidate is kept. `index` counts from 1. */
const candidatePath = (orderId: string, index: number): string => `orders/${orderId}/music/cand-${index}.wav`;

/**
 * One candidate: asks Lyria, records what the call cost, keeps the WAV at `orders/<id>/music/cand-<index>.wav` and
 * measures it. It stands alone, as one step of the flow, and does the same when it runs again for the same `index`
 * (it writes the same path; the new call is billed again, and recorded again). A track that cannot be measured is not a
 * failure of the step, which would only be retried and paid for again: it comes back with `measure: null`.
 */
export async function generateCandidate(input: Request & { index: number }, deps: MusicDeps): Promise<Candidate> {
  const { orderId, prompt, index, bpm, videoSeconds } = input;
  const { store, blob, music } = deps;
  const { wav, usd } = await music.generate(prompt);
  // Lyria has billed the track by now, whatever happens to it next.
  await store.addCost(orderId, `music:cand-${index}`, usd, 'card');
  const path = candidatePath(orderId, index);
  await blob.put(path, wav, 'audio/wav');
  try {
    const { mono, sampleRate } = parseWav(wav);
    return { path, measure: measureTrack(mono, sampleRate, bpm, videoSeconds) };
  } catch (error) {
    // Both only read bytes, and throw an Error when the track is not one they can read or find a beat in.
    if (error instanceof Error) return { path, measure: null };
    throw error;
  }
}

/**
 * The track to use among the candidates, by measurement, or null if none passes. When none does and the order can afford
 * another call, one more candidate is made and the choice is made again; never more than three in all.
 */
export async function pickTrack(input: Request & { candidates: Candidate[] }, deps: MusicDeps): Promise<ChosenTrack | null> {
  const { candidates: given, ...request } = input;
  const candidates = [...given];

  const choose = (): ChosenTrack | null => {
    const measured = candidates.flatMap(({ path, measure }) => (measure === null ? [] : [{ path, measure }]));
    const { chosen } = chooseTrack(
      measured.map(({ measure }) => measure),
      request.bpm,
      request.videoSeconds,
    );
    const best = chosen === null ? undefined : measured[chosen];
    if (best === undefined) return null;
    const { measuredBpm, firstBeat, seconds } = best.measure;
    return { path: best.path, measuredBpm, firstBeat, seconds };
  };

  const track = choose();
  if (track !== null || candidates.length >= MAX_CANDIDATES) return track;
  if (!canAfford(await deps.store.orderCost(request.orderId), EST.lyria, deps.spendCap)) return null;
  candidates.push(await generateCandidate({ ...request, index: candidates.length + 1 }, deps));
  return choose();
}

/**
 * The music of an order. Nothing is asked of Lyria when the order says no audio. The first two candidates are made
 * whatever the order has spent (the video is meant to have its music); the third only if the cap allows it. The result
 * is the chosen track, or null with the warning `music_unavailable` when none passes.
 */
export async function runMusic({
  order,
  edl,
  deps,
}: {
  order: Pick<Order, 'id' | 'request'>;
  edl: Edl;
  deps: MusicDeps;
}): Promise<{ track: ChosenTrack | null; warnings: string[] }> {
  if (order.request.audio === 'none') return { track: null, warnings: [] };

  const videoSeconds = layoutScenes(edl, 0).total / FPS;
  const request: Request = { orderId: order.id, prompt: musicPrompt(edl, videoSeconds), bpm: edl.bpm, videoSeconds };
  // One after the other: if Lyria fails on the first, the second is not paid for.
  const candidates: Candidate[] = [];
  for (let index = 1; index <= FIRST_CANDIDATES; index++) candidates.push(await generateCandidate({ ...request, index }, deps));

  const track = await pickTrack({ ...request, candidates }, deps);
  return track === null ? { track: null, warnings: ['music_unavailable'] } : { track, warnings: [] };
}
