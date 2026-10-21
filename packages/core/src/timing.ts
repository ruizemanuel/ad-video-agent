// All timing lives here, in beats: where the cuts fall (rounded from the cumulative beat count, so they never drift off
// the pulse), when each text of a piece comes in and goes, how long a text needs to stay on screen to be read, and how an
// edit list moves to the tempo measured on its music.
import type { Edl, Line, Scene } from './edl';

export const FPS = 30;

// Frames of the brand wipe, centered on the cut.
export const WIPE_FRAMES = 12;

const MIN_SCENE_BEATS = 2;
/** The earliest beat a caption may be replaced at. */
export const MIN_AT_BEAT = 2;
/** The fewest beats of a UI scene whose caption is replaced (an atBeat): in fewer, neither caption is on screen long enough to be read. */
export const MIN_SWAP_BEATS = 7;
/** The shortest EndCard: its two steps (the brand, then the button that is pressed) need the room. */
export const MIN_ENDCARD_BEATS = 4;

/** The fewest beats a WordCycle of `words` words may last: each word holds two beats, and the first comes in on beat 1, after one beat of the prefix alone. */
export const wordCycleMinBeats = (words: number): number => 2 * words + 1;

/**
 * The fewest beats a scene may last under the structure rules of validateEdl: 2, 7 when a caption is replaced, two beats
 * per word plus one for a WordCycle (each word holds at least two beats) and 4 for the EndCard. How long its texts need to
 * be read depends on the tempo and on where the scene plays as well (see readingBeats).
 */
export const minSceneBeats = (scene: Scene): number =>
  Math.max(
    MIN_SCENE_BEATS,
    scene.lines.some((line) => line.atBeat !== undefined) ? MIN_SWAP_BEATS : 0,
    scene.piece === 'WordCycle' ? wordCycleMinBeats(scene.lines.length - 1) : 0,
    scene.piece === 'EndCard' ? MIN_ENDCARD_BEATS : 0,
  );

export const beatsToFrames = (beats: number, bpm: number, fps: number = FPS): number => Math.round((beats * 60 * fps) / bpm);

export type SceneRole = 'hook' | 'body' | 'cta';
export type TimedScene = { scene: Scene; role: SceneRole; index: number; from: number; duration: number; startBeat: number };

/** A scene placed in its video: the `index`-th, from beat `startBeat`, its cuts rounded from the cumulative beat count. */
const placeScene = (scene: Scene, role: SceneRole, index: number, startBeat: number, bpm: number): TimedScene => {
  const from = beatsToFrames(startBeat, bpm);
  return { scene, role, index, from, duration: beatsToFrames(startBeat + scene.beats, bpm) - from, startBeat };
};

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
    const timed = placeScene(scene, role, index, beat, edl.bpm);
    beat += scene.beats;
    return timed;
  });
  return { scenes, total: beatsToFrames(beat, edl.bpm) };
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

// What a close of 6 beats or more does on its beats: the button comes in on beat 2 and is pressed on beat 4.5. On beat 2
// the button of a 6-beat close stays on screen long enough to be read (see readingSeconds) with a site's call to action at
// every tempo the music comes at (20 characters at 147 bpm, 25 at 128); on beat 3 it did not, at 111 bpm already.
const BUTTON_BEAT = 2;
const PRESS_BEAT = 4.5;
// A shorter close keeps the press this many beats before its end (and the button a beat before the press), so the press
// is over by the settled frame. On half beats: 2.5 and 3.5 in 5 beats, 1.5 and 2.5 in 4 (the shortest validateEdl takes).
const AFTER_PRESS = 1.5;
const BUTTON_TO_PRESS = 1;

/**
 * The two steps of the EndCard, in frames of the scene: first the logo (and the tagline), then the button, which is
 * pressed. On beat 2 and beat 4.5 in a close of 6 beats or more; earlier, on half beats, in a shorter one.
 */
export const endCardSteps = (timed: TimedScene, bpm: number): { button: number; press: number } => {
  const pressBeat = Math.min(PRESS_BEAT, timed.scene.beats - AFTER_PRESS);
  const buttonBeat = Math.min(BUTTON_BEAT, pressBeat - BUTTON_TO_PRESS);
  return { button: Math.max(0, beatFrame(timed, buttonBeat, bpm)), press: Math.max(0, beatFrame(timed, pressBeat, bpm)) };
};

// ---------- reading ----------
// The ad works on mute, so its texts are read like subtitles: cold, over moving product shots. Each one stays whole on
// screen, from when it is fully in to when it starts to leave, at least as long as subtitle guidelines ask: 5/6 s per
// event and 17 characters a second (Netflix's Timed Text Style Guide: its general requirements, and its Spanish guide for
// adult programs) and 0.3 s per word (BBC Subtitle Guidelines), whichever is longest. A text that builds up (the lines of
// a headline or a stack, the words of a WordCycle under its prefix) asks it of each new part.

const READING = { minSeconds: 5 / 6, charsPerSecond: 17, secondsPerWord: 0.3 } as const;
/** A window this many frames short of the need still passes: a text reads a little before its entrance has quite settled. */
export const READING_TOLERANCE_FRAMES = 2;
// Ignores the error of floating point (0.3 * 4 * 30 is 36.00000000000001).
const EPSILON = 1e-9;

/** What the reading rule counts in a text: its characters (not UTF-16 units) and its words. */
export const readingCounts = (text: string): { chars: number; words: number } => ({ chars: [...text].length, words: text.split(/\s+/).filter(Boolean).length });

/** The seconds `text` has to stay whole on screen to be read: max(5/6 s, characters / 17, 0.3 s × words). */
export const readingSeconds = (text: string): number => {
  const { chars, words } = readingCounts(text);
  return Math.max(READING.minSeconds, chars / READING.charsPerSecond, READING.secondsPerWord * words);
};

/** A text a scene shows (`line`: its first line in the scene's lines), and the frames of the scene it is fully in at and starts to leave at. */
export type TextWindow = { line: number; text: string; fullyIn: number; leaves: number };

/** Whether a text stays whole on screen long enough to be read (see readingSeconds), within READING_TOLERANCE_FRAMES. */
export const isReadable = (w: TextWindow): boolean => w.leaves - w.fullyIn + READING_TOLERANCE_FRAMES + EPSILON >= readingSeconds(w.text) * FPS;

/** The most characters and words a text can have and be read in a window of `frames` frames; undefined under 5/6 s. */
export const readableIn = (frames: number): { chars: number; words: number } | undefined => {
  const seconds = (frames + READING_TOLERANCE_FRAMES) / FPS + EPSILON;
  if (seconds < READING.minSeconds) return undefined;
  return { chars: Math.floor(seconds * READING.charsPerSecond), words: Math.floor(seconds / READING.secondsPerWord) };
};

/**
 * Every text the scene shows, with the frames of the scene it is whole on screen between: from when every word of it is in
 * and its entrance has settled, to when it starts to leave (the caption that replaces it, the next word, the wipe into the
 * next scene, or the cut). `wipeOut`: a wipe brings the next scene in, and covers this one from WIPE_FRAMES / 2 before the
 * cut. A TypeIn is left out: what it types is read as it is typed.
 */
export const textWindows = (timed: TimedScene, bpm: number, wipeOut: boolean): TextWindow[] => {
  const { scene } = timed;
  const lines = scene.lines;
  const end = timed.duration - (wipeOut ? WIPE_FRAMES / 2 : 0);
  // A wipe that brings this scene in covers it until WIPE_FRAMES / 2 after the cut.
  const clear = timed.index > 0 && scene.transitionIn === 'wipe' ? WIPE_FRAMES / 2 : 0;
  const window = (line: number, text: string, fullyIn: number, leaves: number): TextWindow => ({ line, text, fullyIn: Math.max(fullyIn, clear), leaves: Math.min(leaves, end) });
  const joined = (from: number): string => lines.slice(from).map((l) => l.text).join(' ');
  switch (scene.piece) {
    case 'UiFocus':
    case 'UiScroll': {
      if (!lines[0]) return [];
      const swap = captionSwapFrame(lines, timed, bpm);
      if (swap === undefined) return [window(0, joined(0), CAPTION_DELAY + REVEAL_FRAMES, end)];
      return [window(0, lines[0].text, CAPTION_DELAY + REVEAL_FRAMES, swap), window(1, joined(1), swap + CAPTION_SWAP.in.to, end)];
    }
    case 'KineticHeadline':
      return lines.map((line, i) => window(i, line.text, headlineLineStart(i, timed, bpm, opensWithBrand(timed)) + REVEAL_FRAMES, end));
    case 'ClaimStack':
      return lines.map((line, i) => window(i, line.text, stackLineStart(i, timed, bpm) + REVEAL_FRAMES, end));
    case 'WordCycle': {
      const [prefix, ...words] = lines;
      if (!prefix) return [];
      const enters = words.map((_, k) => wordEnterFrame(k, timed, bpm));
      return [window(0, prefix.text, REVEAL_FRAMES, end), ...words.map((word, k) => window(k + 1, word.text, (enters[k] ?? 0) + WORD_ROLL, enters[k + 1] ?? end))];
    }
    case 'EndCard': {
      const [button, tagline] = lines;
      const steps = endCardSteps(timed, bpm);
      return [
        ...(button ? [window(0, button.text, steps.button + BUTTON_IN, end)] : []),
        ...(tagline ? [window(1, tagline.text, TAGLINE_AT + REVEAL_FRAMES, end)] : []),
      ];
    }
    case 'TypeIn':
      return [];
  }
};

/** Where a scene plays in its video: its role and place in the list, the beat it starts on, and whether a wipe brings the next scene in. */
export type Placement = { role: SceneRole; index: number; startBeat: number; wipeOut: boolean };

/** The texts of the scene, placed at `at` in a video at `bpm`, that are not on screen long enough to be read. */
export const unreadTexts = (scene: Scene, at: Placement, bpm: number): TextWindow[] =>
  textWindows(placeScene(scene, at.role, at.index, at.startBeat, bpm), bpm, at.wipeOut).filter((w) => !isReadable(w));

/** Whether the scene is a UiFocus or a UiScroll whose caption is replaced: a second line with an atBeat. */
export const swapsCaption = (scene: Scene): boolean => (scene.piece === 'UiFocus' || scene.piece === 'UiScroll') && scene.lines[1]?.atBeat !== undefined;

/** The scene with every atBeat of its lines at `atBeat`. */
const withAtBeat = (scene: Scene, atBeat: number): Scene => ({ ...scene, lines: scene.lines.map((line) => (line.atBeat === undefined ? line : { ...line, atBeat })) });

/** The atBeats at which every text of a scene whose caption is replaced is read, in order; none for any other scene. */
export const readableAtBeats = (scene: Scene, at: Placement, bpm: number): number[] => {
  if (!swapsCaption(scene)) return [];
  const atBeats = Array.from({ length: Math.max(0, scene.beats - MIN_AT_BEAT) }, (_, i) => MIN_AT_BEAT + i);
  return atBeats.filter((atBeat) => unreadTexts(withAtBeat(scene, atBeat), at, bpm).length === 0);
};

/**
 * The fewest beats, from `min` to `max`, in which every text of the scene is read when it plays at `at` (on the same
 * beat), with the atBeats that do it when its caption is replaced. Undefined when no length in that range does.
 */
export const readingBeats = (scene: Scene, at: Placement, bpm: number, min: number, max: number): { beats: number; atBeats: number[] } | undefined => {
  for (let beats = Math.max(1, min); beats <= max; beats++) {
    const sized = { ...scene, beats };
    const atBeats = readableAtBeats(sized, at, bpm);
    if (swapsCaption(scene) ? atBeats.length > 0 : unreadTexts(sized, at, bpm).length === 0) return { beats, atBeats };
  }
  return undefined;
};

// ---------- the retime ----------

// How many beats past where rounding puts a cut the retime looks for one that gets every text of the scene read.
const RETIME_REACH = 8;

type Sequence = { scene: Scene; role: SceneRole }[];
/** Where a sequence starts in its video: the index of its first scene, and its first beat in the plan and once retimed. */
type SequenceStart = { index: number; planned: number; measured: number };

// Music does not follow the tempo the director asked for, so the render measures the track and moves every scene to its
// beats: a scene of N beats at the planned tempo becomes N * measured / planned. Rounding scene by scene would let the
// error pile up; instead each cut is the scaled cumulative beat count, rounded once, so a sequence ends within half a beat
// of where it should. A cut is never pushed closer to the one before it than the scene's minimum (minSceneBeats), nor
// than its texts need to be read when the planned scene had them read: it then falls on the first beat from there that
// gets them read (see readingBeats). An atBeat moves with the tempo, within [MIN_AT_BEAT, beats - 1] and, when the
// planned scene had both captions read, within the atBeats that keep them read. So a retimed edit list keeps the rules
// the planned one met, at the cost of a beat now and then.
const retimeSequence = (scenes: Sequence, after: Scene | undefined, start: SequenceStart, plannedBpm: number, measuredBpm: number): Scene[] => {
  let planned = 0;
  let cut = 0;
  const scaled = (beats: number): number => Math.round((beats * measuredBpm) / plannedBpm);
  return scenes.map(({ scene, role }, k) => {
    const index = start.index + k;
    const wipeOut = (scenes[k + 1]?.scene ?? after)?.transitionIn === 'wipe';
    const read = unreadTexts(scene, { role, index, startBeat: start.planned + planned, wipeOut }, plannedBpm).length === 0;
    planned += scene.beats;
    const floor = Math.max(scaled(planned) - cut, minSceneBeats(scene));
    const at: Placement = { role, index, startBeat: start.measured + cut, wipeOut };
    const fit = read ? readingBeats(scene, at, measuredBpm, floor, floor + RETIME_REACH) : undefined;
    const beats = fit?.beats ?? floor;
    cut += beats;
    // The atBeats that keep both captions read are consecutive: the first caption gains what the second loses.
    const [lowest, highest] = fit?.atBeats.length ? [fit.atBeats[0] ?? MIN_AT_BEAT, fit.atBeats.at(-1) ?? beats - 1] : [MIN_AT_BEAT, beats - 1];
    const retimeLine = (line: Line): Line => (line.atBeat === undefined ? line : { ...line, atBeat: Math.min(Math.max(scaled(line.atBeat), lowest), highest) });
    return { ...scene, beats, lines: scene.lines.map(retimeLine) };
  });
};

const sumBeats = (scenes: readonly Scene[]): number => scenes.reduce((beats, scene) => beats + scene.beats, 0);

// A video is a hook, then the body, then the cta, back to back, and the body and the cta are shared by the three hooks.
// So each hook is retimed on its own, and the body and the cta together, as one tail placed after the main hook (hook 0),
// where validateEdl checks them. Every video then ends within half a beat of its plan for the hook plus half a beat for
// the tail, and the beats its texts need to be read.
export const retimeForBpm = (edl: Edl, measuredBpm: number): Edl => {
  if (!Number.isFinite(measuredBpm) || measuredBpm <= 0) throw new RangeError(`The measured bpm must be a positive number, got ${measuredBpm}.`);
  const tail: Sequence = [...edl.body.map((scene) => ({ scene, role: 'body' as const })), { scene: edl.cta, role: 'cta' as const }];
  const retime = (scenes: Sequence, after: Scene | undefined, start: SequenceStart): Scene[] => retimeSequence(scenes, after, start, edl.bpm, measuredBpm);
  const hooks = edl.hooks.map((hook) => retime(hook.map((scene) => ({ scene, role: 'hook' as const })), tail[0]?.scene, { index: 0, planned: 0, measured: 0 }));
  const main = { index: edl.hooks[0]?.length ?? 0, planned: sumBeats(edl.hooks[0] ?? []), measured: sumBeats(hooks[0] ?? []) };
  const retimed = retime(tail, undefined, main);
  return { ...edl, bpm: measuredBpm, hooks, body: retimed.slice(0, -1), cta: retimed.at(-1) ?? edl.cta };
};
