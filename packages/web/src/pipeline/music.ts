// The music step: Lyria writes two tracks for the video, the code measures them (tempo, steadiness, first beat, level) and
// the one that suits the video is chosen by those figures. When neither does and the order's spending cap allows it, a
// third is asked for. When no track passes, the video goes out without music and says so. Every track is kept in Blob and
// every call is recorded on the order as it is made. A candidate that does not come (Lyria fails, or its track cannot be
// measured) is one that did not pass, never a failure of the order. Each candidate asks for the model of its number
// (MUSIC_MODELS: Lyria 3.5 for the first two, Lyria 3 Pro for the third) and keeps it: the chosen track says which made it.
import {
  chooseTrack,
  FPS,
  layoutScenes,
  measureTrack,
  MUSIC_MODELS,
  musicPrompt,
  parseWav,
  type Edl,
  type MusicModel,
  type RejectReason,
  type TrackMeasure,
} from '@app/core';
import { MusicOutputInvalid, type BlobPort, type MusicPort, type Order, type OrderStore } from '../ports';
import { canAfford, EST } from './budget';

/** How many tracks are asked for at first, and at most: one per model of MUSIC_MODELS. Candidates are numbered from 1. */
const FIRST_CANDIDATES = 2;
const MAX_CANDIDATES = MUSIC_MODELS.length;

/** The model the candidate with this number (from 1) is asked of. A RangeError for a number no candidate has. */
export function modelForCandidate(index: number): MusicModel {
  const model = Number.isInteger(index) ? MUSIC_MODELS[index - 1] : undefined;
  if (model === undefined) throw new RangeError(`There is no candidate ${index}: they are numbered from 1 to ${MAX_CANDIDATES}.`);
  return model;
}

export type MusicDeps = {
  store: Pick<OrderStore, 'addCost' | 'orderCost'>;
  blob: Pick<BlobPort, 'put'>;
  music: MusicPort;
  /** SPEND_CAP_PER_ORDER_USD. */
  spendCap: number;
};

/** What every candidate of an order is asked for: the same prompt, measured against the same tempo and length. */
export type MusicRequest = {
  orderId: string;
  prompt: string;
  /** The tempo the edit list asks for: the cuts land on its beats. */
  bpm: number;
  /** The length of the video the track plays under. */
  videoSeconds: number;
};

/** The request for the music of an order, from its edit list. The flow asks here and does not work these out again. */
export function musicRequest(orderId: string, edl: Edl): MusicRequest {
  const videoSeconds = layoutScenes(edl, 0).total / FPS;
  return { orderId, prompt: musicPrompt(edl, videoSeconds), bpm: edl.bpm, videoSeconds };
}

/**
 * One candidate, as the flow keeps it. `model` is the one that made the track (or, when there is none, the one asked for).
 * `measure` is null when it cannot be chosen: `path` is then null if Lyria gave no track (the call failed), or the track's
 * own if it has no tempo to find (silence, noise, something that is not music). `problem` says why, and is null otherwise.
 * All of it is plain data, so it can be the result of a workflow step.
 */
export type Candidate = { index: number; model: MusicModel; path: string | null; measure: TrackMeasure | null; problem: string | null };

/** The track the video uses, and what the render needs to know of it. `model` made it: music.md says so. */
export type ChosenTrack = { path: string; model: MusicModel; measuredBpm: number; firstBeat: number; seconds: number };

/** Why a candidate was not chosen: the check it failed, or that it could not be measured, or that Lyria gave no track. */
export type Rejection = { index: number; reason: RejectReason | 'unmeasurable' | 'failed'; detail?: string };

// What went wrong, said without what was sent or got back: the SDK's errors carry the request and the provider's answer.
// The kind of error and the HTTP status are enough to tell a Lyria that is down from one that refuses.
const describeFailure = (error: unknown): string => {
  if (error instanceof MusicOutputInvalid) return error.message;
  const name = error instanceof Error ? error.name : 'unknown error';
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' ? `${name} (HTTP ${status})` : name;
};

/** The candidate for a Lyria call that failed, for the flow to build when the step that made it ran out of tries. */
export const failedCandidate = (index: number, error: unknown): Candidate => ({
  index,
  model: modelForCandidate(index),
  path: null,
  measure: null,
  problem: describeFailure(error),
});

/**
 * One candidate: asks Lyria for the model of its number, records what the call cost, keeps the WAV at
 * `orders/<id>/music/cand-<index>.wav` and measures it. It stands alone, as one step of the flow, and does the same when
 * it runs again for the same `index` (it asks the same model and writes the same path; the new call is billed again, and
 * recorded again). A track that cannot be measured is not a failure of the step, which would only be retried and paid
 * for again: it comes back with `measure: null`.
 *
 * It throws when the call fails. When Lyria billed an answer it could not use (`MusicOutputInvalid`), that cost is
 * recorded before the error goes on. A candidate no model is listed for (a RangeError) asks for nothing.
 */
export async function generateCandidate(input: MusicRequest & { index: number }, deps: MusicDeps): Promise<Candidate> {
  const { orderId, prompt, index, bpm, videoSeconds } = input;
  const { store, blob, music } = deps;
  const item = `music:cand-${index}`;
  const requested = modelForCandidate(index);

  let answer: Awaited<ReturnType<MusicPort['generate']>>;
  try {
    answer = await music.generate(prompt, requested);
  } catch (error) {
    if (error instanceof MusicOutputInvalid) await store.addCost(orderId, item, error.usd, 'card');
    throw error;
  }
  // Lyria has billed the track by now, whatever happens to it next.
  await store.addCost(orderId, item, answer.usd, 'card');
  const path = `orders/${orderId}/music/cand-${index}.wav`;
  await blob.put(path, answer.wav, 'audio/wav');
  // The candidate keeps the model that made the track, as the port says it.
  const { model } = answer;
  try {
    const { mono, sampleRate } = parseWav(answer.wav);
    return { index, model, path, measure: measureTrack(mono, sampleRate, bpm, videoSeconds), problem: null };
  } catch (error) {
    // Both only read bytes, and throw an Error when the track is not one they can read or find a beat in.
    if (error instanceof Error) return { index, model, path, measure: null, problem: error.message };
    throw error;
  }
}

// A candidate, or the candidate that a failure leaves.
async function attemptCandidate(input: MusicRequest & { index: number }, deps: MusicDeps): Promise<Candidate> {
  try {
    return await generateCandidate(input, deps);
  } catch (error) {
    return failedCandidate(input.index, error);
  }
}

export type MusicPick = {
  /** The track to use, or null if no candidate passes. */
  track: ChosenTrack | null;
  /** The candidates it was given, and the one it asked for, if any. */
  candidates: Candidate[];
  /** Every candidate that was not chosen because of a check, or because it had no measure, and why. */
  rejected: Rejection[];
};

// The choice among the candidates that can be measured, and the reasons for the ones that cannot be chosen.
const choose = (candidates: Candidate[], bpm: number, videoSeconds: number): Pick<MusicPick, 'track' | 'rejected'> => {
  const measured = candidates.flatMap((candidate) => (candidate.measure === null ? [] : [{ candidate, measure: candidate.measure }]));
  const choice = chooseTrack(
    measured.map(({ measure }) => measure),
    bpm,
    videoSeconds,
  );
  const unmeasured = candidates
    .filter((candidate) => candidate.measure === null)
    .map<Rejection>(({ index, path, problem }) => ({
      index,
      reason: path === null ? 'failed' : 'unmeasurable',
      ...(problem === null ? {} : { detail: problem }),
    }));
  const failedChecks = choice.rejected.flatMap(({ index, reason }) => {
    const entry = measured[index];
    return entry === undefined ? [] : [{ index: entry.candidate.index, reason }];
  });
  const rejected = [...unmeasured, ...failedChecks].sort((a, b) => a.index - b.index);

  const best = choice.chosen === null ? undefined : measured[choice.chosen];
  if (best === undefined || best.candidate.path === null) return { track: null, rejected };
  const { measuredBpm, firstBeat, seconds } = best.measure;
  return { track: { path: best.candidate.path, model: best.candidate.model, measuredBpm, firstBeat, seconds }, rejected };
};

/**
 * The track to use among the candidates, by measurement. Give it every candidate made so far, those that failed too (see
 * `failedCandidate`). When none passes and the order can afford another call, one more candidate is made (numbered after
 * the highest one given, so no candidate is written over) and the choice is made again; never more than three in all. A
 * Lyria call that fails there is one more candidate that did not pass.
 */
export async function pickTrack(input: MusicRequest & { candidates: Candidate[] }, deps: MusicDeps): Promise<MusicPick> {
  const { candidates: given, ...request } = input;
  const candidates = [...given];

  let pick = choose(candidates, request.bpm, request.videoSeconds);
  const index = Math.max(0, ...candidates.map((candidate) => candidate.index)) + 1;
  if (pick.track === null && index <= MAX_CANDIDATES && canAfford(await deps.store.orderCost(request.orderId), EST.lyria, deps.spendCap)) {
    candidates.push(await attemptCandidate({ ...request, index }, deps));
    pick = choose(candidates, request.bpm, request.videoSeconds);
  }
  return { ...pick, candidates };
}

/**
 * The music of an order. Nothing is asked of Lyria when the order says no audio. The first two candidates are made
 * whatever the order has spent (the video is meant to have its music); the third only if the cap allows it. The result
 * is the chosen track, or null with the warning `music_unavailable` when none passes. `rejected` says why the candidates
 * that were not chosen were not (it is there whenever Lyria was asked), for the flow to log.
 */
export async function runMusic({
  order,
  edl,
  deps,
}: {
  order: Pick<Order, 'id' | 'request'>;
  edl: Edl;
  deps: MusicDeps;
}): Promise<{ track: ChosenTrack | null; warnings: string[]; rejected?: Rejection[] }> {
  if (order.request.audio === 'none') return { track: null, warnings: [] };

  const request = musicRequest(order.id, edl);
  // One after the other: if Lyria is down on the first, the second is not paid for.
  const candidates: Candidate[] = [];
  for (let index = 1; index <= FIRST_CANDIDATES; index++) candidates.push(await attemptCandidate({ ...request, index }, deps));

  const { track, rejected } = await pickTrack({ ...request, candidates }, deps);
  return { track, warnings: track === null ? ['music_unavailable'] : [], rejected };
}
