// All timing lives here, in beats. Cuts are rounded from the cumulative beat count so they
// never drift off the pulse. So does the rhythm of the pieces: when each text comes in and goes.
import type { Edl, Line, Scene } from './edl';

export const FPS = 30;

// Frames of the brand wipe, centered on the cut.
export const WIPE_FRAMES = 12;

const MIN_SCENE_BEATS = 2;
/** The earliest beat a caption may be replaced at: the first one stays on screen about a second. */
export const MIN_AT_BEAT = 2;
/** The shortest EndCard: its two steps (the brand, then the button that is pressed) need the room. */
export const MIN_ENDCARD_BEATS = 4;

/** The fewest beats a WordCycle of `words` words may last: each word holds two beats, and the first comes in on beat 1, after one beat of the prefix alone. */
export const wordCycleMinBeats = (words: number): number => 2 * words + 1;

/**
 * The fewest beats a scene may last under the rules of validateEdl: 2, 3 when a caption is replaced (at beat 2 at the
 * earliest), two beats per word plus one for a WordCycle (each word holds at least two beats) and 4 for the EndCard.
 */
export const minSceneBeats = (scene: Scene): number =>
  Math.max(
    MIN_SCENE_BEATS,
    scene.lines.some((line) => line.atBeat !== undefined) ? MIN_AT_BEAT + 1 : 0,
    scene.piece === 'WordCycle' ? wordCycleMinBeats(scene.lines.length - 1) : 0,
    scene.piece === 'EndCard' ? MIN_ENDCARD_BEATS : 0,
  );

export const beatsToFrames = (beats: number, bpm: number, fps: number = FPS): number => Math.round((beats * 60 * fps) / bpm);

export type SceneRole = 'hook' | 'body' | 'cta';
export type TimedScene = { scene: Scene; role: SceneRole; index: number; from: number; duration: number; startBeat: number };

// The video of one hook: that hook, then the shared body, then the closing scene, back to back.
export const layoutScenes = (edl: Edl, hook: number): { scenes: TimedScene[]; total: number } => {
  const hookScenes = edl.hooks[hook];
  if (!hookScenes) throw new RangeError(`There is no hook ${hook}; the edit list has ${edl.hooks.length}.`);
  const list: { scene: Scene; role: SceneRole }[] = [
    ...hookScenes.map((scene) => ({ scene, role: 'hook' as const })),
    ...edl.body.map((scene) => ({ scene, role: 'body' as const })),
    { scene: edl.cta, role: 'cta' as const },
  ];
  let beat = 0;
  const scenes = list.map(({ scene, role }, index) => {
    const from = beatsToFrames(beat, edl.bpm);
    const to = beatsToFrames(beat + scene.beats, edl.bpm);
    const timed = { scene, role, index, from, duration: to - from, startBeat: beat };
    beat += scene.beats;
    return timed;
  });
  return { scenes, total: beatsToFrames(beat, edl.bpm) };
};

// Music does not follow the tempo the director asked for, so the render measures the track and moves
// every scene to its beats: a scene of N beats at the planned tempo becomes N * measured / planned.
// Rounding scene by scene would let the error pile up; instead each cut is the scaled cumulative beat
// count, rounded once, so a sequence ends within half a beat of where it should. A cut is never pushed
// closer to the one before it than the scene's minimum (minSceneBeats), and an atBeat stays in
// [MIN_AT_BEAT, beats - 1], so a retimed edit list keeps the rules the planned one met.
const sequenceRetimer = (plannedBpm: number, measuredBpm: number) => {
  let planned = 0;
  let cut = 0;
  return (scene: Scene): Scene => {
    planned += scene.beats;
    const next = Math.max(Math.round((planned * measuredBpm) / plannedBpm), cut + minSceneBeats(scene));
    const beats = next - cut;
    cut = next;
    const retimeLine = (line: Line): Line =>
      line.atBeat === undefined
        ? line
        : { ...line, atBeat: Math.min(Math.max(Math.round((line.atBeat * measuredBpm) / plannedBpm), MIN_AT_BEAT), beats - 1) };
    return { ...scene, beats, lines: scene.lines.map(retimeLine) };
  };
};

// A video is a hook, then the body, then the cta, back to back, and the body and the cta are shared by the
// three hooks. So each hook is retimed on its own, and the body and the cta are retimed together as one tail.
// Every video then ends within half a beat of its plan for the hook plus half a beat for the tail.
export const retimeForBpm = (edl: Edl, measuredBpm: number): Edl => {
  if (!Number.isFinite(measuredBpm) || measuredBpm <= 0) throw new RangeError(`The measured bpm must be a positive number, got ${measuredBpm}.`);
  const retimer = () => sequenceRetimer(edl.bpm, measuredBpm);
  const hooks = edl.hooks.map((hook) => hook.map(retimer()));
  const retimeTail = retimer();
  // The retimer remembers where the previous cut fell, so the scenes must go through it in playing order.
  const body = edl.body.map(retimeTail);
  const cta = retimeTail(edl.cta);
  return { ...edl, bpm: measuredBpm, hooks, body, cta };
};

// The frame a scene is settled in: entrances done, before the next wipe starts. Key frames and covers use it.
export const settledFrame = (t: TimedScene): number => t.from + t.duration - WIPE_FRAMES / 2 - 2;

// ---------- the rhythm of the pieces ----------
// When each text of a piece comes in and goes, as plain math, in frames of its scene (the frame a piece reads with
// useCurrentFrame). The VM's pieces draw their text with these, and the edit list's checks read the same, so the render
// and the checks cannot drift apart. Every change of text lands on a beat of the whole video's grid.

/** The frames a line of type takes to rise into place through its mask (RevealLines). */
export const REVEAL_FRAMES = 16;
/** The first caption of a UI scene starts to rise this many frames into the scene. */
export const CAPTION_DELAY = 2;
/**
 * A caption replaced at its atBeat fades into the next one over 6 frames from the beat: the one that goes is out in the
 * first 3, the one that comes is in from the 1st to the 6th, so the two never read on top of each other.
 */
export const CAPTION_SWAP = { out: 3, in: { from: 1, to: 6 } } as const;
/** A word of a WordCycle rolls in through its mask over this many frames from its beat, as the one before rolls out. */
export const WORD_ROLL = 6;
/** The first line of a headline that opens the video comes in this many frames into it, after the brand over it. */
export const AFTER_LOGO = 4;
/** A headline line is in this many frames after it starts to rise: the last one starts no later than that before the settled frame. */
export const LINE_IN = 12;
/** The brand of the close comes in this many frames into the scene, under the end of the wipe that usually brings it in. */
export const MARK_AT = 3;
/** The tagline of the close starts to rise this many frames into the scene, under the brand. */
export const TAGLINE_AT = MARK_AT + 6;
/** The frames the button of the close takes to come in: it is in, and still, before it is pressed. */
export const BUTTON_IN = 14;

/** The frame of the scene on which its beat `beat` (a half beat too) falls, on the beat grid of the whole video. */
export const beatFrame = (timed: TimedScene, beat: number, bpm: number): number => beatsToFrames(timed.startBeat + beat, bpm) - timed.from;

/**
 * The words of a WordCycle (lines 1 on) are spread over the scene: each holds floor((beats - 1) / words) beats, two at
 * least in a scene validateEdl takes, from beat 1 on, and the last keeps what is left of the scene.
 */
const wordHold = ({ scene }: TimedScene): number => Math.floor((scene.beats - 1) / Math.max(1, scene.lines.length - 1));

/** The frame of the scene at which word k of a WordCycle (its line k + 1) comes in: beat 1 + k * hold (see wordHold). */
export const wordEnterFrame = (k: number, timed: TimedScene, bpm: number): number => beatFrame(timed, 1 + k * wordHold(timed), bpm);

/** The frame of the scene at which `lines[1]` replaces `lines[0]` (its atBeat), if it does within the scene. */
export const captionSwapFrame = (lines: readonly Line[], timed: TimedScene, bpm: number): number | undefined => {
  const at = lines[1]?.atBeat;
  return at === undefined || at >= timed.scene.beats ? undefined : beatFrame(timed, at, bpm);
};

/** The frame of the scene at which line i of a headline comes in: on beat i. */
export const lineEnterFrame = (i: number, bpm: number): number => beatsToFrames(i, bpm);

/** A headline that opens the video carries the brand over it (its logo, or its name). */
export const opensWithBrand = (timed: TimedScene): boolean => timed.index === 0 && timed.scene.piece === 'KineticHeadline';

/**
 * The frame of the scene at which line i of a headline starts to rise: on beat i (see lineEnterFrame), not before the brand
 * when the headline opens the video, `stagger` frames later for the second half of a line split in two as it is set, and
 * no later than LINE_IN frames before the settled frame, so that a scene too short for its beats brings its lines in sooner.
 */
export const headlineLineStart = (i: number, timed: TimedScene, bpm: number, opening: boolean, stagger = 0): number => {
  const latest = settledFrame(timed) - timed.from - LINE_IN;
  return Math.max(0, Math.min(Math.max(lineEnterFrame(i, bpm), opening ? AFTER_LOGO : 0) + stagger, latest));
};

/** The frame of the scene at which line i of a ClaimStack comes in: the lines are spread over the scene, floor(beats / lines) beats apart (one at least). */
export const stackLineStart = (i: number, timed: TimedScene, bpm: number): number =>
  beatFrame(timed, i * Math.max(1, Math.floor(timed.scene.beats / Math.max(1, timed.scene.lines.length))), bpm);

// What a close of 6 beats or more does on its beats: the button comes in on beat 3 and is pressed on beat 4.5.
const BUTTON_BEAT = 3;
const PRESS_BEAT = 4.5;
// A shorter close keeps the press this many beats before its end (and the button a beat before the press), so the press
// is over by the settled frame. On half beats: 2.5 and 3.5 in 5 beats, 1.5 and 2.5 in 4 (the shortest validateEdl takes).
const AFTER_PRESS = 1.5;
const BUTTON_TO_PRESS = 1;

/**
 * The two steps of the EndCard, in frames of the scene: first the logo (and the tagline), then the button, which is
 * pressed. On beat 3 and beat 4.5 in a close of 6 beats or more; earlier, on half beats, in a shorter one.
 */
export const endCardSteps = (timed: TimedScene, bpm: number): { button: number; press: number } => {
  const pressBeat = Math.min(PRESS_BEAT, timed.scene.beats - AFTER_PRESS);
  const buttonBeat = Math.min(BUTTON_BEAT, pressBeat - BUTTON_TO_PRESS);
  return { button: Math.max(0, beatFrame(timed, buttonBeat, bpm)), press: Math.max(0, beatFrame(timed, pressBeat, bpm)) };
};
