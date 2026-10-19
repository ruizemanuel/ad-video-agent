// Music: the Lyria tracks are measured (tempo, steadiness, first beat, level) and the one that suits the video is
// chosen by code. Lyria does not honor the tempo or the length asked for in the prompt, and a model asked to
// pick by ear justified its choices with invented figures, so nothing here is a judgment call.
/// <reference path="./music-tempo.d.ts" />
import MusicTempo from 'music-tempo';
import type { Edl } from './edl';
import { FPS, layoutScenes } from './timing';

export type Wav = { sampleRate: number; channels: number; mono: Float32Array };

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

type Reader = (view: DataView, at: number) => number;

// Sample readers, by encoding and container size in bits. Integers are scaled to -1..1.
const readers: Record<string, Reader> = {
  pcm16: (view, at) => view.getInt16(at, true) / 0x8000,
  pcm24: (view, at) => (view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16)) / 0x800000,
  pcm32: (view, at) => view.getInt32(at, true) / 0x80000000,
  float32: (view, at) => view.getFloat32(at, true),
};

// Reads a WAV file into a mono signal (the channels averaged), the form the tempo tracker takes.
// Unknown chunks are skipped, and a data chunk that promises more bytes than the file holds (an encoder that
// streamed its output and could not go back to fix the size) is read up to the end of the file.
export const parseWav = (bytes: Uint8Array): Wav => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');

  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | undefined;
  let data: { start: number; length: number } | undefined;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ' && size >= 16 && body + size <= bytes.length) {
      let format = view.getUint16(body, true);
      // WAVE_FORMAT_EXTENSIBLE keeps the real format in the first two bytes of a sub-format GUID.
      if (format === FORMAT_EXTENSIBLE && size >= 26) format = view.getUint16(body + 24, true);
      fmt = { format, channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    } else if (id === 'data' && data === undefined) {
      data = { start: body, length: Math.min(size, bytes.length - body) };
    }
    at = body + size + (size % 2);
  }
  if (!fmt) throw new Error('WAV has no fmt chunk');
  if (!data) throw new Error('WAV has no data chunk');

  const encoding = fmt.format === FORMAT_PCM ? `pcm${fmt.bits}` : fmt.format === FORMAT_FLOAT ? `float${fmt.bits}` : '';
  const read = readers[encoding];
  if (!read || fmt.channels < 1 || fmt.sampleRate < 1) {
    throw new Error(`unsupported WAV encoding (format ${fmt.format}, ${fmt.bits} bits, ${fmt.channels} channels, ${fmt.sampleRate} Hz)`);
  }

  const bytesPerSample = fmt.bits / 8;
  const frames = Math.floor(data.length / (bytesPerSample * fmt.channels));
  const mono = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    const first = data.start + frame * bytesPerSample * fmt.channels;
    let sum = 0;
    for (let channel = 0; channel < fmt.channels; channel++) sum += read(view, first + channel * bytesPerSample);
    mono[frame] = sum / fmt.channels;
  }
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, mono };
};

export type TrackMeasure = {
  // Length of the track.
  seconds: number;
  // Tempo of the track, folded to the octave nearest the one asked for.
  measuredBpm: number;
  // Time of the first beat, in the file: the first hit on the beat grid, where the render starts the track.
  firstBeat: number;
  // How far the beats stray from an evenly spaced grid, in ms (root mean square). Low means a steady groove.
  beatResidualMs: number;
  // Level (RMS, dBFS) of the first quarter of a second from the first beat: is there a hit where the video starts.
  startRmsDb: number;
  // Level (RMS, dBFS) from the first beat over the length of the video.
  energyDb: number;
  // Time of the first sound (the first sample above AUDIBLE_DBFS): Lyria puts up to a couple of seconds of digital
  // silence before some tracks. Measures taken before it was kept have none, and count it as 0.
  audioStart?: number;
  // How many of the tracker's beats were left out of the grid as off the groove (see fitBeats). Absent from older measures.
  droppedBeats?: number;
};

// The tracker finds the tempo from the first 25 s: what a video of this product uses of the track.
const ANALYSIS_SECONDS = 25;
const MIN_BEATS = 4;
const START_WINDOW_SECONDS = 0.25;
const SILENCE_DB = -120;
// The tracker looks at 10 ms steps whatever the sample rate; its hop is 441 samples, which is 10 ms at 44.1 kHz only.
const FRAME_SECONDS = 0.01;
// A beat further off the grid than this share of a beat (a 32nd note) is one the tracker took off the groove.
const MAX_BEAT_OFFSET = 1 / 8;
// The share of the tracker's beats, counted from the first, that may be left out of the grid: how the track opens.
const MAX_DROPPED_SHARE = 0.15;
// A sample above this level is sound; below it is the digital silence Lyria puts before some tracks.
const AUDIBLE_DBFS = -60;
// How near a beat of the grid the tracker must have heard an onset for that beat to be a hit, in seconds.
const ONSET_TOLERANCE_SECONDS = 0.04;
// How far before the first sound the start may go, in seconds: the grid line of the hit that opens a track can fall a
// few milliseconds before its first sample.
const BEFORE_SOUND_TOLERANCE_SECONDS = 0.05;

const round = (x: number, decimals: number) => Math.round(x * 10 ** decimals) / 10 ** decimals;

// Level of mono[from..to) in dBFS (seconds in, clamped to the track). An empty or silent stretch is SILENCE_DB.
const rmsDb = (mono: Float32Array, sampleRate: number, from: number, to: number): number => {
  const start = Math.max(0, Math.round(from * sampleRate));
  const end = Math.min(mono.length, Math.round(to * sampleRate));
  if (end <= start) return SILENCE_DB;
  let sum = 0;
  for (let i = start; i < end; i++) sum += (mono[i] ?? 0) ** 2;
  return Math.max(SILENCE_DB, 10 * Math.log10(sum / (end - start)));
};

type Beat = { index: number; time: number };
type Line = { phase: number; slope: number; deviations: number[] };

// A least-squares line through beats numbered by their place in the tracker's list (time = phase + slope * index), and
// how far each beat is off it.
const lineThrough = (beats: Beat[]): Line => {
  const meanIndex = beats.reduce((sum, beat) => sum + beat.index, 0) / beats.length;
  const meanTime = beats.reduce((sum, beat) => sum + beat.time, 0) / beats.length;
  let covariance = 0;
  let variance = 0;
  for (const { index, time } of beats) {
    covariance += (index - meanIndex) * (time - meanTime);
    variance += (index - meanIndex) ** 2;
  }
  const slope = covariance / variance;
  const phase = meanTime - slope * meanIndex;
  return { phase, slope, deviations: beats.map(({ index, time }) => time - (phase + slope * index)) };
};

// The beat grid of a track: a line through the tracker's beats, without the few it took off the groove as the track
// opened. A tracker can take its first beats from a figure that sits off the beat (an intro a 16th ahead of it) before
// it finds the groove, and those few beats tilt the line and make a steady track read as unsteady. So while one of the
// first 15 % of the beats (MAX_DROPPED_SHARE) is more than MAX_BEAT_OFFSET of a beat off the line, the one furthest off
// is left out and the line fitted again. Only the opening is forgiven: a beat off the grid later in the track counts,
// however few there are. The residual is the root mean square of what the kept beats are off the line.
const fitBeats = (times: number[]): { phase: number; slope: number; residual: number; dropped: number } => {
  const opening = Math.floor(times.length * MAX_DROPPED_SHARE);
  let kept: Beat[] = times.map((time, index) => ({ index, time }));
  for (;;) {
    const { phase, slope, deviations } = lineThrough(kept);
    const off = deviations.map(Math.abs);
    // The beat of the opening furthest off the line, if one is off by more than MAX_BEAT_OFFSET.
    let worst = -1;
    kept.forEach((beat, i) => {
      const x = off[i] ?? 0;
      if (beat.index < opening && x > slope * MAX_BEAT_OFFSET && (worst < 0 || x > (off[worst] ?? 0))) worst = i;
    });
    if (worst < 0) {
      const residual = Math.sqrt(deviations.reduce((sum, x) => sum + x ** 2, 0) / kept.length);
      return { phase, slope, residual, dropped: times.length - kept.length };
    }
    kept = kept.filter((_, i) => i !== worst);
  }
};

// Measures a mono track. `videoSeconds` is the length of the video the track will play under, for the energy
// (the whole track from its first beat if left out, or if the track is shorter).
// Throws when there is no tempo to find: silence, noise, or less than a few seconds of music.
export const measureTrack = (mono: Float32Array, sampleRate: number, requestedBpm: number, videoSeconds: number = Infinity): TrackMeasure => {
  const hopSize = Math.round(sampleRate * FRAME_SECONDS);
  let tracker: MusicTempo;
  try {
    tracker = new MusicTempo(mono, { hopSize, timeStep: hopSize / sampleRate });
  } catch (failure) {
    // The library throws strings.
    throw new Error(`could not measure the tempo of the track: ${String(failure)}`);
  }
  // The beats of the first 25 s, and the grid through them (fitBeats). Its slope is a better tempo than the tracker's
  // own, and what is left over says how steady the groove is.
  const beats = tracker.beats.filter((time) => time < ANALYSIS_SECONDS);
  if (beats.length < MIN_BEATS) {
    throw new Error(`could not measure the tempo of the track: only ${beats.length} beats in the first ${ANALYSIS_SECONDS} s`);
  }
  const { phase, slope, residual, dropped } = fitBeats(beats);

  // Beat trackers often lock onto half or double time: fold to the octave closest to the request.
  const fitted = 60 / slope;
  const folded = [fitted / 2, fitted, fitted * 2].reduce((best, bpm) => (Math.abs(bpm - requestedBpm) < Math.abs(best - requestedBpm) ? bpm : best));

  const audible = 10 ** (AUDIBLE_DBFS / 20);
  const firstSound = mono.findIndex((x) => Math.abs(x) > audible);
  const audioStart = firstSound < 0 ? 0 : firstSound / sampleRate;
  // The start: the grid's first beat, moved back a beat at a time while the beat before it is a hit the video can open
  // on (the tracker heard an onset there, it is as loud as chooseTrack asks of a start, and it is not before the first
  // sound). The tracker can come in after the first hit, on a figure that follows it, and the grid's first beat is then
  // one on which nothing plays.
  const isHit = (time: number) =>
    time >= audioStart - BEFORE_SOUND_TOLERANCE_SECONDS &&
    tracker.events.some((onset) => Math.abs(onset - time) <= ONSET_TOLERANCE_SECONDS) &&
    rmsDb(mono, sampleRate, time, time + START_WINDOW_SECONDS) >= MIN_START_RMS_DB;
  let start = phase;
  while (isHit(start - slope)) start -= slope;

  return {
    seconds: round(mono.length / sampleRate, 2),
    measuredBpm: round(folded, 2),
    firstBeat: round(start, 3),
    beatResidualMs: Math.round(residual * 1000),
    // To the tenth of a dB: a difference no ear hears is a tie, and ties go to the better tempo (chooseTrack).
    startRmsDb: round(rmsDb(mono, sampleRate, start, start + START_WINDOW_SECONDS), 1),
    energyDb: round(rmsDb(mono, sampleRate, start, start + videoSeconds), 1),
    audioStart: round(audioStart, 3),
    droppedBeats: dropped,
  };
};

export type RejectReason = 'bpm' | 'unsteady' | 'late-start' | 'weak-start' | 'too-short';
export type TrackChoice = { chosen: number | null; rejected: { index: number; reason: RejectReason }[] };

const MAX_BPM_DEVIATION = 0.15; // of the requested tempo: further than this and the cuts would have to move too much
const MAX_RESIDUAL_MS = 30;
// The render cuts the track from its first beat, so a short intro costs nothing; this only keeps out a track that
// takes long to get going. It counts from the first sound: the silence before it is never heard.
const MAX_FIRST_BEAT_SECONDS = 2;
const MIN_START_RMS_DB = -30;

// The first check a track fails, if any.
const rejection = (track: TrackMeasure, requestedBpm: number, videoSeconds: number): RejectReason | undefined => {
  if (Math.abs(track.measuredBpm - requestedBpm) / requestedBpm > MAX_BPM_DEVIATION) return 'bpm';
  if (track.beatResidualMs > MAX_RESIDUAL_MS) return 'unsteady';
  if (track.firstBeat - (track.audioStart ?? 0) > MAX_FIRST_BEAT_SECONDS) return 'late-start';
  if (track.startRmsDb < MIN_START_RMS_DB) return 'weak-start';
  if (track.seconds - track.firstBeat < videoSeconds) return 'too-short';
  return undefined;
};

// Picks the index of the track to use: among those that pass every check, the most energetic; on a tie, the
// one whose tempo is closest to the request; on a tie of that too, the first. `chosen` is null when none pass.
export const chooseTrack = (cands: TrackMeasure[], requestedBpm: number, videoSeconds: number): TrackChoice => {
  const rejected: TrackChoice['rejected'] = [];
  let chosen: number | null = null;
  let best: TrackMeasure | undefined;
  const deviation = (track: TrackMeasure) => Math.abs(track.measuredBpm - requestedBpm);
  for (const [index, track] of cands.entries()) {
    const reason = rejection(track, requestedBpm, videoSeconds);
    if (reason) rejected.push({ index, reason });
    else if (!best || track.energyDb > best.energyDb || (track.energyDb === best.energyDb && deviation(track) < deviation(best))) {
      best = track;
      chosen = index;
    }
  }
  return { chosen, rejected };
};

/**
 * How far short of the video a track may fall, in seconds. The render fades a track out where it ends and fills the rest
 * of the video with silence, so a track that runs out early leaves the end of the video silent: half a second of the
 * close, which is a fade anyway, is let through.
 */
export const MAX_TRACK_SHORT_FALL_SECONDS = 0.5;

/**
 * Whether a track lasts a video of `videoSeconds` from its first beat, where the render starts it (a first beat before the
 * start of the file counts as the start), allowing MAX_TRACK_SHORT_FALL_SECONDS. The service checks it before it asks
 * for a render with music, and the VM again before it renders.
 */
export const trackCoversVideo = (track: { seconds: number; firstBeat: number }, videoSeconds: number): boolean =>
  track.seconds - Math.max(0, track.firstBeat) >= videoSeconds - MAX_TRACK_SHORT_FALL_SECONDS;

// m:ss of a whole number of seconds.
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

// The prompt for Lyria: the direction of the edit list, the tempo, the length and where the video changes
// section (from the main hook, hooks[0]). Lyria has no fields for tempo or length, so they go in the prompt
// and the track is measured afterwards.
export const musicPrompt = (edl: Edl, videoSeconds: number): string => {
  const { scenes } = layoutScenes(edl, 0);
  const startOf = (from: number | undefined) => Math.round((from ?? 0) / FPS);
  const length = Math.ceil(videoSeconds);
  // The body starts the section after the hook; the end card starts the last one.
  const bodyStart = startOf(scenes.find((scene) => scene.role !== 'hook')?.from);
  const ctaStart = startOf(scenes.find((scene) => scene.role === 'cta')?.from);
  return [
    edl.musicPrompt,
    'Instrumental only, no vocals.',
    `Tempo: exactly ${edl.bpm} BPM, steady, 4/4, with a clear beat from the very first second.`,
    `Length: ${length} seconds in total.`,
    'Structure:',
    `[0:00 - ${clock(bodyStart)}] Intro: a confident hit on the first downbeat and the groove starts right away.`,
    `[${clock(bodyStart)} - ${clock(ctaStart)}] Main groove, building gently.`,
    `[${clock(ctaStart)} - ${clock(length)}] Clean ending that resolves on a final hit at ${clock(length)}, then silence.`,
  ].join('\n');
};
