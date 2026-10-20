// The rhythm of the pieces, as plain math: what a piece shows at a frame, counted from the start of its scene (the
// frame a piece reads with useCurrentFrame). Every change of text lands on a beat of the whole video's grid, so a
// scene keeps the pulse wherever it falls; the key frames read the same changes (render/keyframes.ts).
import { beatsToFrames, type Line, type TimedScene } from '@app/core';

/** The frame of the scene on which its beat `beat` (a half beat too) falls, on the beat grid of the whole video. */
export const beatFrame = (timed: TimedScene, beat: number, bpm: number): number => beatsToFrames(timed.startBeat + beat, bpm) - timed.from;

// ---------- TypeIn ----------

// Typing starts once the bar has come in.
const TYPE_START = 6;
/** The share of the scene by which the typing is done. */
export const TYPED_BY = 0.6;

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
 * The words of a WordCycle (lines 1 on) are spread over the scene: each holds floor((beats - 1) / words) beats, two at
 * least in a scene validateEdl takes, from beat 1 on, and the last keeps what is left of the scene.
 */
const wordHold = ({ scene }: TimedScene): number => Math.floor((scene.beats - 1) / Math.max(1, scene.lines.length - 1));

/** The frame of the scene at which word k of a WordCycle (its line k + 1) comes in: beat 1 + k * hold (see wordHold). */
export const wordEnterFrame = (k: number, timed: TimedScene, bpm: number): number => beatFrame(timed, 1 + k * wordHold(timed), bpm);

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

/** The frame of the scene at which `lines[1]` replaces `lines[0]` (its atBeat), if it does within the scene. */
export const captionSwapFrame = (lines: readonly Line[], timed: TimedScene, bpm: number): number | undefined => {
  const at = lines[1]?.atBeat;
  return at === undefined || at >= timed.scene.beats ? undefined : beatFrame(timed, at, bpm);
};

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

// ---------- KineticHeadline ----------

/** The frame of the scene at which line i of a headline comes in: on beat i. */
export const lineEnterFrame = (i: number, bpm: number): number => beatsToFrames(i, bpm);

// ---------- EndCard ----------

// What a close of 6 beats or more does on its beats: the button comes in on beat 3 and is pressed on beat 4.5.
const BUTTON_BEAT = 3;
const PRESS_BEAT = 4.5;
// A shorter close keeps the press this many beats before its end (and the button a beat before the press), so the press
// is over by the settled frame. On half beats: 2.5 and 3.5 in 5 beats, 1.5 and 2.5 in 4 (the shortest validateEdl takes).
const AFTER_PRESS = 1.5;
const BUTTON_TO_PRESS = 1;
/** The frames the button takes to come in: it is in, and still, before it is pressed. */
export const BUTTON_IN = 14;

/**
 * The two steps of the EndCard, in frames of the scene: first the logo (and the tagline), then the button, which is
 * pressed. On beat 3 and beat 4.5 in a close of 6 beats or more; earlier, on half beats, in a shorter one.
 */
export const endCardSteps = (timed: TimedScene, bpm: number): { button: number; press: number } => {
  const pressBeat = Math.min(PRESS_BEAT, timed.scene.beats - AFTER_PRESS);
  const buttonBeat = Math.min(BUTTON_BEAT, pressBeat - BUTTON_TO_PRESS);
  return { button: Math.max(0, beatFrame(timed, buttonBeat, bpm)), press: Math.max(0, beatFrame(timed, pressBeat, bpm)) };
};
