// Music: the Lyria tracks are measured (tempo, steadiness, first beat, level) and the one that suits the video is
// chosen by code. Lyria does not honor the tempo or the length asked for in the prompt, and a model asked to
// pick by ear justified its choices with invented figures, so nothing here is a judgment call.
/// <reference path="./music-tempo.d.ts" />
import MusicTempo from 'music-tempo';
import type { Edl } from './edl';
import { FPS, layoutScenes, retimedVideoSeconds } from './timing';

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
  // Time of the first beat, in the file: the first hit on the beat grid, where the render starts the track (for a track
  // that opens on a soft count-in, its first strong beat).
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
  // The largest skip inside the part of the track the video plays, in ms (see largestJump): a track that skips once (a
  // few ms of it cut out or played twice) and plays on from there, off the grid. Absent from older measures, which count as 0.
  maxJumpMs?: number;
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
// How many beats on each side of a split the onsets are compared over when looking for a skip, at most (see largestJump):
// enough to hold the pattern of the groove, few enough that two skips a few bars apart are not blurred into one.
const JUMP_WINDOW_BEATS = 4;
// How many beats a side a split needs at least. The windows shrink to it at the edges of the part the video plays, so that
// a skip in its first or last beats is measured too.
const JUMP_MIN_SIDE_BEATS = 2;
// How far the onsets after a split are looked for from where they were before it, as a share of a beat: clear of a 16th
// note (a quarter of a beat), so that the groove's own 16ths are never taken for a skip.
const JUMP_SEARCH = 1 / 6;
// The resolution of the onset pattern of a beat, and so of a skip, in seconds.
const PATTERN_BIN_SECONDS = 0.001;
// How many of the tracker's onsets each window of a split must hold for the split to count, per beat of the window and
// rounded up (2 for 4 beats, 1 for 2). A window without onsets says nothing: a ring-out, a reverb tail or a held note is
// above AUDIBLE_DBFS, but its pattern is flat, and a flat pattern lines up as well at any shift within JUMP_SEARCH, so it
// would read as a skip of any size up to that.
const JUMP_MIN_ONSETS_PER_BEAT = 1 / 2;
// A sample above this level is sound; below it is the digital silence Lyria puts before some tracks.
const AUDIBLE_DBFS = -60;
// How near a beat of the grid the tracker must have heard an onset for that beat to be a hit, in seconds.
const ONSET_TOLERANCE_SECONDS = 0.04;
// How far before the first sound the start may go, in seconds: the grid line of the hit that opens a track can fall a
// few milliseconds before its first sample.
const BEFORE_SOUND_TOLERANCE_SECONDS = 0.05;
// The lead-in: the beats from the first sound, 0 to MAX_LEAD_IN_BEATS, that a track may take to get going (two bars of
// 4/4). A track that opens on a soft count-in is cut at its first strong beat, and only a beat of the lead-in can be it.
// It is also how late a start chooseTrack lets through. Every count here is of the beats of the music, 60 / the measured
// tempo, and not of the tracker's grid, which can run at double or half time. The lead-in's edge is not the 8th beat
// itself but LEAD_IN_EDGE_BEATS past it: 8.5 beats from the first sound, in the search and in the late-start check alike.
const MAX_LEAD_IN_BEATS = 8;
// The lead-in ends this far past its last beat. The grid sits a few ms before or after the first sound, so a groove on
// beat 8 would otherwise fall on either side of the line by a hair; half a beat keeps it in and leaves beat 9 out.
const LEAD_IN_EDGE_BEATS = 0.5;
// How many beats past the lead-in the strong beats are told from, so that a groove that comes in on the last beat of the
// lead-in is measured against the groove itself, and not only against the count-in before it.
const GROOVE_LOOKAHEAD_BEATS = 4;
// How far under the loudest beat of the lead-in (dB) a beat may be and still count as strong: a fill into the groove can
// be a hit of its own and still sit well under the groove.
const GROOVE_MARGIN_DB = 6;

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

const median = (xs: number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

// The tracker's onset envelope (its spectral flux, a frame every `frameSeconds` from the start of the file) at `time`,
// read on the straight line between the two frames around it. Outside the track it is 0, the envelope's mean.
const onsetsAt = (flux: number[], frameSeconds: number, time: number): number => {
  const frame = time / frameSeconds;
  const i = Math.floor(frame);
  if (i < 0 || i + 1 >= flux.length) return 0;
  const along = frame - i;
  return (flux[i] ?? 0) * (1 - along) + (flux[i + 1] ?? 0) * along;
};

// How far the onset pattern `after` sits from `before` (two patterns of one beat, mean removed, a bin per
// PATTERN_BIN_SECONDS), in seconds, within `reach` bins either way: the shift that lines them up best, that is, the
// largest of their cross-correlations, taken around the beat (a pattern of one beat wraps around), and refined between
// two bins by a parabola through the best one and its neighbours.
const shiftBetween = (before: Float64Array, after: Float64Array, reach: number): number => {
  const bins = before.length;
  const scores = Array.from({ length: 2 * reach + 1 }, (_, k) => {
    let sum = 0;
    for (let i = 0; i < bins; i++) sum += (before[i] ?? 0) * (after[(i + k - reach + bins) % bins] ?? 0);
    return sum;
  });
  let best = 0;
  scores.forEach((score, k) => {
    if (score > (scores[best] ?? 0)) best = k;
  });
  let shift = best - reach;
  const [left, peak, right] = [scores[best - 1], scores[best], scores[best + 1]];
  if (left !== undefined && peak !== undefined && right !== undefined) {
    const curvature = left - 2 * peak + right;
    if (curvature < 0) shift += (0.5 * (left - right)) / curvature;
  }
  return shift * PATTERN_BIN_SECONDS;
};

// The largest skip among the beats `beats` (the grid of the part the video plays, a beat of `beatSeconds` apart), in
// seconds: a track that skips once (Lyria cuts or repeats a few ms of it) and plays on from there, so that on one side of
// the skip the cuts of the video fall off the beat. The tracker's beats cannot tell it: they come in steps of a frame, and
// the residual spreads one skip over the whole fit (a 40 ms skip reads as about 20 ms).
// So it reads the onsets themselves (the tracker's envelope, `spectralFlux`). At every split between two beats, with up to
// JUMP_WINDOW_BEATS beats on each side (at least JUMP_MIN_SIDE_BEATS), the onsets of the beats before it are folded over
// one beat into a pattern, and so are those of the beats after it; the skip at the split is how far the pattern after sits
// from the one before (shiftBetween), looked for within JUMP_SEARCH of a beat. A split counts only when the tracker heard
// onsets (its `events`) in both windows, at least JUMP_MIN_ONSETS_PER_BEAT per beat. A track drifts a little against the grid
// between its skips (a skip tilts the fitted tempo against itself), so the drift per beat, the median of the skips per beat
// over the splits with full windows, is taken out of each split for the beats between the middles of its two windows.
const largestJump = (
  { spectralFlux: flux, events }: Pick<MusicTempo, 'spectralFlux' | 'events'>,
  frameSeconds: number,
  beats: number[],
  beatSeconds: number,
): number => {
  const bins = Math.round(beatSeconds / PATTERN_BIN_SECONDS);
  // The onsets of each beat, from half a beat before it to half a beat after.
  const around = beats.map((beat) =>
    Float64Array.from({ length: bins }, (_, i) => onsetsAt(flux, frameSeconds, beat - beatSeconds / 2 + i * PATTERN_BIN_SECONDS)),
  );
  // How many of the tracker's onsets it heard in the same span of each beat.
  const heard = beats.map((beat) => events.filter((time) => time >= beat - beatSeconds / 2 && time < beat + beatSeconds / 2).length);
  // Whether the beats from `from` to `to` (not included) hold enough onsets to tell where their pattern sits.
  const heardEnough = (from: number, to: number) =>
    heard.slice(from, to).reduce((sum, count) => sum + count, 0) >= Math.ceil((to - from) * JUMP_MIN_ONSETS_PER_BEAT);
  // The beats from `from` to `to` (not included) folded over one beat, mean removed.
  const pattern = (from: number, to: number): Float64Array => {
    const sum = new Float64Array(bins);
    for (const beat of around.slice(from, to)) beat.forEach((x, i) => (sum[i] = (sum[i] ?? 0) + x));
    const mean = sum.reduce((total, x) => total + x, 0) / bins;
    return sum.map((x) => x - mean);
  };
  const reach = Math.round((beatSeconds * JUMP_SEARCH) / PATTERN_BIN_SECONDS);
  const splits: { skip: number; side: number }[] = [];
  for (let split = JUMP_MIN_SIDE_BEATS; split + JUMP_MIN_SIDE_BEATS <= beats.length; split++) {
    const side = Math.min(JUMP_WINDOW_BEATS, split, beats.length - split);
    if (!heardEnough(split - side, split) || !heardEnough(split, split + side)) continue;
    splits.push({ skip: shiftBetween(pattern(split - side, split), pattern(split, split + side), reach), side });
  }
  const full = splits.filter(({ side }) => side === JUMP_WINDOW_BEATS);
  const drift = full.length > 0 ? median(full.map(({ skip }) => skip / JUMP_WINDOW_BEATS)) : 0;
  return splits.reduce((largest, { skip, side }) => Math.max(largest, Math.abs(skip - side * drift)), 0);
};

// Measures a mono track. `videoSeconds` is the length of the video the track will play under: the energy is measured over
// it from the first beat (the whole track if left out, or if the track is shorter), and the skips over it too, up to the
// end of the sound if that comes first.
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
  // A beat of the music: the tracker's beat, folded with the tempo (see the start below).
  const beatSeconds = 60 / folded;

  const audible = 10 ** (AUDIBLE_DBFS / 20);
  const firstSound = mono.findIndex((x) => Math.abs(x) > audible);
  const audioStart = firstSound < 0 ? 0 : firstSound / sampleRate;
  // Where the sound ends: past it there is only digital silence. (A ring-out before it has no onsets either; see
  // JUMP_MIN_ONSETS_PER_BEAT.)
  const audioEnd = (mono.findLastIndex((x) => Math.abs(x) > audible) + 1) / sampleRate;
  // Level (dBFS) of the quarter of a second from `time`: is there a hit there.
  const levelAt = (time: number) => rmsDb(mono, sampleRate, time, time + START_WINDOW_SECONDS);
  // The start: the grid's first beat, moved back a beat at a time while the beat before it is a hit the video can open
  // on (the tracker heard an onset there, it is as loud as chooseTrack asks of a start, and it is not before the first
  // sound). The tracker can come in after the first hit, on a figure that follows it, and the grid's first beat is then
  // one on which nothing plays.
  const isHit = (time: number) =>
    time >= audioStart - BEFORE_SOUND_TOLERANCE_SECONDS &&
    tracker.events.some((onset) => Math.abs(onset - time) <= ONSET_TOLERANCE_SECONDS) &&
    levelAt(time) >= MIN_START_RMS_DB;
  let start = phase;
  while (isHit(start - slope)) start -= slope;
  // Only a weak start moves (one that chooseTrack would call weak: a track that opens on a soft count-in, ticks and then a
  // fill). It goes on, a beat of the music at a time and on the phase it has, to the first beat of the lead-in that is a
  // hit and a strong one, that is, within GROOVE_MARGIN_DB of the loudest beat from the start to the end of the lead-in
  // and a little past it. A fill into the groove is a hit but not a strong one, so the cut lands on the groove. If no beat
  // qualifies the start stays, and the track is still a weak start. A beat is a beat of the music (60 / the folded tempo),
  // which is the tracker's beat when it follows the music, twice it when the tracker runs at double time (the steps then
  // keep to the beats of the music, and do not land on an 8th note off them) and half of it at half time (they skip none).
  // A step that falls between two grid lines is judged the same way.
  if (round(levelAt(start), 1) < MIN_START_RMS_DB) {
    const leadInEnd = audioStart + (MAX_LEAD_IN_BEATS + LEAD_IN_EDGE_BEATS) * beatSeconds;
    const steps: { time: number; level: number }[] = [];
    for (let n = 0; start + n * beatSeconds <= leadInEnd + GROOVE_LOOKAHEAD_BEATS * beatSeconds; n++) {
      const time = start + n * beatSeconds;
      steps.push({ time, level: levelAt(time) });
    }
    const loudest = Math.max(...steps.map((step) => step.level));
    const strong = steps.find((step) => step.time > start && step.time <= leadInEnd && step.level >= loudest - GROOVE_MARGIN_DB && isHit(step.time));
    if (strong) start = strong.time;
  }

  // The beats of the part the video plays, on the grid from the start at a beat of the music: over the length of the
  // video, or to the end of the sound if it comes first (or if the length is not given). Unlike the fit, not only those of
  // the first ANALYSIS_SECONDS.
  const playedEnd = Math.min(start + videoSeconds, audioEnd);
  const played: number[] = [];
  for (let k = 0; start + k * beatSeconds <= playedEnd; k++) played.push(start + k * beatSeconds);

  return {
    seconds: round(mono.length / sampleRate, 2),
    measuredBpm: round(folded, 2),
    firstBeat: round(start, 3),
    beatResidualMs: Math.round(residual * 1000),
    // To the tenth of a dB: a difference no ear hears is a tie, and ties go to the better tempo (chooseTrack).
    startRmsDb: round(levelAt(start), 1),
    energyDb: round(rmsDb(mono, sampleRate, start, start + videoSeconds), 1),
    audioStart: round(audioStart, 3),
    droppedBeats: dropped,
    maxJumpMs: Math.round(largestJump(tracker, hopSize / sampleRate, played, beatSeconds) * 1000),
  };
};

export type RejectReason = 'bpm' | 'unsteady' | 'jump' | 'late-start' | 'weak-start' | 'too-short';
export type TrackChoice = { chosen: number | null; rejected: { index: number; reason: RejectReason }[] };

/** How far from the tempo asked for a track may come, as a share of it: further than this and the cuts would have to move too much. */
export const MAX_BPM_DEVIATION = 0.15;
const MAX_RESIDUAL_MS = 30;
// The largest skip (TrackMeasure.maxJumpMs) a track may have inside the part the video plays. Set by ear: of the skips
// measured on real Lyria tracks, the user heard the one of 38 ms (in a delivered video) and two of 80 to 100 ms as the
// audio cutting or speeding up, and did not hear those of 28 ms and 17 ms. A skip of 40 ms passes the residual (it reads
// about 20 ms).
const MAX_JUMP_MS = 33;
const MIN_START_RMS_DB = -30;

/** The length of the video a track plays under: a number, or the length at the track's tempo (see retimedVideoSeconds). */
export type VideoLength = number | ((measuredBpm: number) => number);

/**
 * How far short of the video a track may fall, in seconds. The render fades a track out where it ends and fills the rest
 * of the video with silence, so a track that runs out early leaves the end of the video silent: half a second of the
 * close, which is a fade anyway, is let through. A silent end is better than an ad with no music.
 */
export const MAX_TRACK_SHORT_FALL_SECONDS = 0.5;

/**
 * Whether a track lasts a video of `videoSeconds` from its first beat, where the render starts it (a first beat before the
 * start of the file counts as the start), allowing MAX_TRACK_SHORT_FALL_SECONDS. The choice of the track applies it (see
 * chooseTrack), the service again before it asks for a render with music, and the VM before it renders.
 */
export const trackCoversVideo = (track: { seconds: number; firstBeat: number }, videoSeconds: number): boolean =>
  track.seconds - Math.max(0, track.firstBeat) >= videoSeconds - MAX_TRACK_SHORT_FALL_SECONDS;

// The first check a track fails, if any.
const rejection = (track: TrackMeasure, requestedBpm: number, videoSeconds: VideoLength): RejectReason | undefined => {
  if (Math.abs(track.measuredBpm - requestedBpm) / requestedBpm > MAX_BPM_DEVIATION) return 'bpm';
  if (track.beatResidualMs > MAX_RESIDUAL_MS) return 'unsteady';
  // A track measured before the jump was kept has none to check.
  if ((track.maxJumpMs ?? 0) > MAX_JUMP_MS) return 'jump';
  // The render cuts the track from its first beat, so a short intro costs nothing; this only keeps out a track that takes
  // long to get going: past the lead-in, that is, more than MAX_LEAD_IN_BEATS beats (and the edge) at its tempo. It
  // counts from the first sound, because the silence before it is never heard.
  if (track.firstBeat - (track.audioStart ?? 0) > ((MAX_LEAD_IN_BEATS + LEAD_IN_EDGE_BEATS) * 60) / track.measuredBpm) return 'late-start';
  if (track.startRmsDb < MIN_START_RMS_DB) return 'weak-start';
  if (!trackCoversVideo(track, typeof videoSeconds === 'number' ? videoSeconds : videoSeconds(track.measuredBpm))) return 'too-short';
  return undefined;
};

// Picks the index of the track to use: among those that pass every check, the most energetic; on a tie, the
// one whose tempo is closest to the request; on a tie of that too, the first. `chosen` is null when none pass. A track
// has to last the video from its first beat by the render's own rule (trackCoversVideo): given by tempo, the video is the
// one the render makes under that track (the edit list moved to its tempo), so the render never refuses a track chosen.
export const chooseTrack = (cands: TrackMeasure[], requestedBpm: number, videoSeconds: VideoLength): TrackChoice => {
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

// The tempos a chosen track can come at are sampled this far apart, to find how long the video can last once retimed.
const RETIMED_RANGE_STEP_BPM = 0.1;

/**
 * The shortest and the longest the main video can last once moved to the tempo of its music (see retimedVideoSeconds),
 * over the tempos a chosen track can come at: within MAX_BPM_DEVIATION of the one asked for, every 0.1 bpm.
 */
export const retimedVideoRange = (edl: Edl): { shortest: number; longest: number } => {
  const lowest = edl.bpm * (1 - MAX_BPM_DEVIATION);
  const steps = Math.round((2 * edl.bpm * MAX_BPM_DEVIATION) / RETIMED_RANGE_STEP_BPM);
  const lengths = Array.from({ length: steps + 1 }, (_, i) => retimedVideoSeconds(edl, lowest + i * RETIMED_RANGE_STEP_BPM));
  return { shortest: Math.min(...lengths), longest: Math.max(...lengths) };
};

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
