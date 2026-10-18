import { beatsToFrames, layoutScenes, type Edl, type Scene } from '@app/core';
import { describe, expect, it } from 'vitest';
import { buildStillJpegArgs, keyframePlan } from '../src/render/keyframes';
import { PROBE_PREFIX, readProbe } from '../src/video/probe';
import { captionIndex, captionSwapFrame, cycleIndex, wordEnterFrame } from '../src/video/rhythm';

const scene = (piece: Scene['piece'], beats: number, lines: Scene['lines'], extra: Partial<Scene> = {}): Scene => ({ piece, beats, lines, ...extra });
const framing = (text: string, atBeat?: number) => ({ text, kind: 'framing' as const, ...(atBeat === undefined ? {} : { atBeat }) });

// At 120 bpm a beat is exactly 15 frames, so every frame below can be counted by hand.
const edl = (body: Scene[], hooks: Scene[][] = [[scene('KineticHeadline', 4, [framing('Sell with no fees')])]]): Edl => ({
  lang: 'en',
  bpm: 120,
  style: { energy: 'bold', density: 'airy' },
  hooks,
  body,
  cta: scene('EndCard', 4, [framing('Start free')], { transitionIn: 'wipe' }),
  claims: [],
  musicPrompt: 'upbeat',
});

const frames = (plan: ReturnType<typeof keyframePlan>) => plan.map((p) => [p.timed.index, p.frame]);

describe('the key frames of a video', () => {
  it('takes each scene of the hook, the body and the cta once, settled: 8 frames before its end', () => {
    const plan = keyframePlan(edl([scene('ClaimStack', 6, [framing('One'), framing('Two')])]), 0);
    // Scenes: 0-60, 60-150, 150-210.
    expect(frames(plan)).toEqual([
      [0, 52],
      [1, 142],
      [2, 202],
    ]);
    expect(plan.map((p) => p.timed.role)).toEqual(['hook', 'body', 'cta']);
  });

  it('takes the video of the hook it is asked for', () => {
    const hooks = [[scene('KineticHeadline', 4, [framing('First')])], [scene('KineticHeadline', 2, [framing('Second')])]];
    const plan = keyframePlan(edl([], hooks), 1);
    expect(plan[0]?.timed.scene.lines[0]?.text).toBe('Second');
    expect(frames(plan)).toEqual([
      [0, 22],
      [1, 82],
    ]);
  });

  it('takes a caption that another replaces at its beat twice: just before the swap and settled', () => {
    const swap = scene('UiFocus', 6, [framing('Your shop in one link'), framing('Customers pay you directly', 3)], { shotId: 'm-s2', boxIndex: 0 });
    const plan = keyframePlan(edl([swap]), 0);
    // The scene starts at beat 4 (frame 60); beat 3 of it is beat 7, frame 105.
    expect(frames(plan)).toEqual([
      [0, 52],
      [1, 101],
      [1, 142],
      [2, 202],
    ]);
  });

  it('takes a word cycle once per word: each just before the next replaces it, the last one settled', () => {
    const cycle = scene('WordCycle', 6, [framing('Sell'), framing('shoes'), framing('books'), framing('courses')]);
    const plan = keyframePlan(edl([cycle]), 0);
    // Word k comes in on beat k + 1 of the scene, which starts at beat 4: "books" on beat 6 (frame 90), "courses" on beat 7 (105).
    expect(frames(plan)).toEqual([
      [0, 52],
      [1, 86],
      [1, 101],
      [1, 142],
      [2, 202],
    ]);
  });

  it('leaves out a word whose beat falls after the end of its scene', () => {
    const cycle = scene('WordCycle', 3, [framing('Sell'), framing('shoes'), framing('books'), framing('courses')]);
    const plan = keyframePlan(edl([cycle]), 0);
    // Only "shoes" (beat 1) and "books" (beat 2) are on screen in 3 beats; the scene runs 60-105.
    expect(frames(plan)).toEqual([
      [0, 52],
      [1, 86],
      [1, 97],
      [2, 157],
    ]);
  });

  it('takes the caption before an early swap once the scene has come in, and never once the swap has started', () => {
    // atBeat 1: the swap is on frame 75, 15 frames into the scene. 4 frames before it the caption and the card are
    // still coming in, so the still waits for frame 20 of the scene, but no later than the frame before the swap.
    const early = scene('UiFocus', 6, [framing('Your shop in one link'), framing('Customers pay you directly', 1)], { shotId: 'm-s2', boxIndex: 0 });
    expect(frames(keyframePlan(edl([early]), 0)).filter(([index]) => index === 1)).toEqual([
      [1, 74],
      [1, 142],
    ]);
    // atBeat 2 (frame 90, 30 frames in): 4 frames before the swap is past the entrances already.
    const second = scene('UiFocus', 6, [framing('Your shop in one link'), framing('Customers pay you directly', 2)], { shotId: 'm-s2', boxIndex: 0 });
    expect(frames(keyframePlan(edl([second]), 0)).filter(([index]) => index === 1)).toEqual([
      [1, 86],
      [1, 142],
    ]);
  });

  it('waits for the entrances when 4 frames before the swap comes too soon, as at 128 bpm', () => {
    // At 128 bpm a beat is about 14 frames: with atBeat 2 the still is 4 frames before the swap (24 frames into the
    // scene); with atBeat 1 the swap comes before frame 20, so the still is the frame before it.
    const at128 = { ...edl([scene('UiScroll', 6, [framing('One'), framing('Two', 2)], { shotId: 'm-s2' })]), bpm: 128 };
    const [, body] = layoutScenes(at128, 0).scenes;
    const swap = beatsToFrames(body!.startBeat + 2, 128);
    expect(keyframePlan(at128, 0).filter((p) => p.timed.index === 1)[0]?.frame).toBe(swap - 4);
    const early = { ...at128, body: [scene('UiScroll', 6, [framing('One'), framing('Two', 1)], { shotId: 'm-s2' })] };
    expect(keyframePlan(early, 0).filter((p) => p.timed.index === 1)[0]?.frame).toBe(beatsToFrames(body!.startBeat + 1, 128) - 1);
  });

  it('agrees with the pieces: each still before a change shows the text it replaces, the settled one the last', () => {
    for (const bpm of [90, 100, 112, 113.19, 120, 128])
      for (let atBeat = 1; atBeat < 6; atBeat++) {
        const lines = [framing('Your shop in one link'), framing('Customers pay you directly', atBeat)];
        const tempo = { ...edl([scene('UiFocus', 6, lines, { shotId: 'm-s2', boxIndex: 0 })]), bpm };
        const [before, settled] = keyframePlan(tempo, 0).filter((p) => p.timed.index === 1);
        const at = `atBeat ${atBeat} at ${bpm} bpm`;
        expect(captionIndex(lines, before!.frame - before!.timed.from, before!.timed, bpm), at).toBe(0);
        expect(captionIndex(lines, settled!.frame - settled!.timed.from, settled!.timed, bpm), at).toBe(1);
        // Clear of the entrances whenever the swap leaves room for it.
        expect(before!.frame - before!.timed.from, at).toBeGreaterThanOrEqual(Math.min(20, captionSwapFrame(lines, before!.timed, bpm)! - 1));
      }
    for (const bpm of [90, 112, 128]) {
      const cycle = scene('WordCycle', 6, [framing('Sell'), framing('shoes'), framing('books'), framing('courses')]);
      const plan = keyframePlan({ ...edl([cycle]), bpm }, 0).filter((p) => p.timed.index === 1);
      expect(plan.map((p) => cycleIndex(p.frame - p.timed.from, p.timed, bpm, 3))).toEqual([0, 1, 2]);
      // The first word is in, whole, by the still that shows it.
      expect(plan[0]!.frame - plan[0]!.timed.from).toBeGreaterThanOrEqual(wordEnterFrame(0, plan[0]!.timed, bpm) + 6);
    }
  });
});

describe('the picture of a key frame', () => {
  it('is a JPEG 720 px wide at quality 3', () => {
    expect(buildStillJpegArgs('w/52.png', 'w/52.jpg')).toEqual(['-v', 'error', '-y', '-i', 'w/52.png', '-vf', 'scale=720:-1', '-q:v', '3', 'w/52.jpg']);
  });
});

describe('the probe', () => {
  const item = { text: 'Start free', x: 1, y: 2, w: 3, h: 4, fontSize: 100, font: 'BrandDisplay 800 100%', colors: ['rgb(255, 255, 255)'], opacity: 1, bg: 'rgb(200, 30, 107)' };

  it('reads the text measured in the frame it is asked about', () => {
    expect(readProbe(`${PROBE_PREFIX}${JSON.stringify({ frame: 52, items: [item] })}`, 52)).toEqual([item]);
  });

  it('ignores what another frame measured and every other message of the page', () => {
    expect(readProbe(`${PROBE_PREFIX}${JSON.stringify({ frame: 51, items: [item] })}`, 52)).toBeUndefined();
    expect(readProbe('Download the React DevTools', 52)).toBeUndefined();
  });
});
