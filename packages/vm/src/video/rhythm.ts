// The rhythm of the pieces, as plain math: what a piece shows at a frame, counted from the start of its scene (the
// frame a piece reads with useCurrentFrame). Every change of text lands on a beat of the whole video's grid, so a
// scene keeps the pulse wherever it falls; the key frames read the same changes (render/keyframes.ts). When each text
// comes in and goes is core's (timing.ts), which the edit list's checks read too.
import { beatFrame, captionSwapFrame, settledFrame, TYPED_BY, wordEnterFrame, type Line, type TimedScene } from '@app/core';

// ---------- TypeIn ----------

// Typing starts once the bar has come in; it is done at TYPED_BY of the scene.
const TYPE_START = 6;

/** How many characters (not UTF-16 units) of `text` are typed at `frame`: none until the bar is in, all at 60% of the scene. */
export const typedChars = (text: string, frame: number, duration: number): number => {
  const end = duration * TYPED_BY;
  const start = Math.min(TYPE_START, end / 3);
  const done = Math.min(1, Math.max(0, (frame - start) / (end - start)));
  return Math.floor(done * [...text].length);
};

/** TypeIn's button is pressed on the half beat nearest three quarters of the scene, well after the typing ends. */
export const typeInPressFrame = (timed: TimedScene, bpm: number): number => beatFrame(timed, Math.round(timed.scene.beats * 1.5) / 2, bpm);

// ---------- the pressed button ----------

export const PRESS_FRAMES = 6;
// The button holds down for this many frames, then comes back up by the end of the press.
const PRESS_HOLD = 2;

const smoothstep = (t: number): number => t * t * (3 - 2 * t);

/**
 * A button pressed at `pressAt`: down to 96% at once, with a glow that fades over the press, and back at rest
 * PRESS_FRAMES later. A click has no anticipation and no bounce.
 */
export const pressState = (frame: number, pressAt: number): { scale: number; glow: number } => {
  const t = frame - pressAt;
  if (t < 0 || t >= PRESS_FRAMES) return { scale: 1, glow: 0 };
  const up = smoothstep(Math.max(0, t - PRESS_HOLD) / (PRESS_FRAMES - PRESS_HOLD));
  return { scale: 0.96 + 0.04 * up, glow: 1 - t / PRESS_FRAMES };
};

// ---------- WordCycle ----------

/**
 * The word of a WordCycle that shows at `frame`: word k from its beat (see wordEnterFrame), the last one held to the
 * end. Before beat 1 only the prefix is in, and the word to come is the first: 0.
 */
export const cycleIndex = (frame: number, timed: TimedScene, bpm: number): number => {
  let index = 0;
  for (let k = 1; k < timed.scene.lines.length - 1; k++) if (frame >= wordEnterFrame(k, timed, bpm)) index = k;
  return index;
};

// ---------- the captions of the UI scenes ----------

const swapsCaption = (timed: TimedScene): boolean => timed.scene.piece === 'UiFocus' || timed.scene.piece === 'UiScroll';

/** The caption a UI scene shows at `frame`: 0, and 1 from the swap on (see captionSwapFrame). */
export const captionIndex = (lines: readonly Line[], frame: number, timed: TimedScene, bpm: number): number => {
  const swap = captionSwapFrame(lines, timed, bpm);
  return swap !== undefined && frame >= swap ? 1 : 0;
};

/**
 * The frames of the scene at which its text is replaced, within the scene: the caption of a UI scene at its atBeat, and
 * each word of a WordCycle after the first. The key frames take a still of the text before each of them.
 */
export const textChanges = (timed: TimedScene, bpm: number): number[] => {
  const { scene } = timed;
  if (scene.piece === 'WordCycle') return scene.lines.slice(2).map((_, k) => wordEnterFrame(k + 1, timed, bpm)).filter((frame) => frame < timed.duration);
  const swap = swapsCaption(timed) ? captionSwapFrame(scene.lines, timed, bpm) : undefined;
  return swap === undefined ? [] : [swap];
};

// ---------- the camera of the UI scenes ----------

/**
 * The frames of the scene over which the camera of a UI scene moves (see focusMove and scrollMove): UiFocus eases in from
 * frame 4 and lands at 72% of the scene, UiScroll glides from frame 6 and lands on the frame the scene is settled in (see
 * settledFrame), so it is still through the wipe out. Both have landed by that frame, the one the key frame review samples,
 * so the review sees where the camera lands.
 */
export const cameraFrames = (timed: TimedScene): { start: number; end: number } => {
  const settled = settledFrame(timed) - timed.from;
  return timed.scene.piece === 'UiScroll' ? { start: 6, end: settled } : { start: 4, end: Math.min(timed.duration * 0.72, settled) };
};
