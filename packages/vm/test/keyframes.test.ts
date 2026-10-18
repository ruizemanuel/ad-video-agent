import type { Edl, Scene } from '@app/core';
import { describe, expect, it } from 'vitest';
import { buildStillJpegArgs, keyframePlan } from '../src/render/keyframes';
import { PROBE_PREFIX, readProbe } from '../src/video/probe';

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
