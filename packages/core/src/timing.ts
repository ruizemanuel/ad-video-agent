// All timing lives here, in beats. Cuts are rounded from the cumulative beat count so they
// never drift off the pulse.
import type { Edl, Line, Scene } from './edl';

export const FPS = 30;

// Frames of the brand wipe, centered on the cut.
export const WIPE_FRAMES = 12;

const MIN_SCENE_BEATS = 2;

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
// closer than 2 beats to the one before it.
const sequenceRetimer = (plannedBpm: number, measuredBpm: number) => {
  let planned = 0;
  let cut = 0;
  return (scene: Scene): Scene => {
    planned += scene.beats;
    const next = Math.max(Math.round((planned * measuredBpm) / plannedBpm), cut + MIN_SCENE_BEATS);
    const beats = next - cut;
    cut = next;
    const retimeLine = (line: Line): Line =>
      line.atBeat === undefined
        ? line
        : { ...line, atBeat: Math.min(Math.max(Math.round((line.atBeat * measuredBpm) / plannedBpm), 1), beats - 1) };
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
