import { beatsToFrames, BUTTON_IN, captionSwapFrame, endCardSteps, lineEnterFrame, settledFrame, wordEnterFrame, type Line, type Scene, type TimedScene } from '@app/core';
import { describe, expect, it } from 'vitest';
import { cameraFrames, captionIndex, cycleIndex, PRESS_FRAMES, pressState, textChanges, typedChars, typeInPressFrame } from '../src/video/rhythm';

const framing = (text: string, atBeat?: number): Line => ({ text, kind: 'framing', ...(atBeat === undefined ? {} : { atBeat }) });
const scene = (piece: Scene['piece'], beats: number, lines: Line[]): Scene => ({ piece, beats, lines });

/** A scene placed at `startBeat` of a video at `bpm`, as layoutScenes places it. */
const placed = (s: Scene, bpm: number, startBeat = 0): TimedScene => {
  const from = beatsToFrames(startBeat, bpm);
  return { scene: s, role: 'body', index: 1, from, duration: beatsToFrames(startBeat + s.beats, bpm) - from, startBeat };
};

describe('typing', () => {
  it('finishes typing at 60% of the scene', () => {
    expect(typedChars('tiendita.example', 0.6 * 90, 90)).toBe(16);
    expect(typedChars('tiendita.example', 0, 90)).toBe(0);
  });

  it('types one character after another and never more than the text', () => {
    const counts = Array.from({ length: 91 }, (_, frame) => typedChars('tiendita.example', frame, 90));
    for (let f = 1; f < counts.length; f++) expect(counts[f]).toBeGreaterThanOrEqual(counts[f - 1] ?? 0);
    expect(counts.at(-1)).toBe(16);
    // Typing starts once the bar has come in, not on the first frame.
    expect(typedChars('tiendita.example', 3, 90)).toBe(0);
  });

  it('counts characters, not UTF-16 units', () => {
    expect(typedChars('tienda 🛍', 0.6 * 90, 90)).toBe(8);
  });
});

describe('the pressed button', () => {
  it('presses the button at its beat', () => {
    expect(pressState(60, 60).scale).toBeCloseTo(0.96);
    expect(pressState(80, 60).scale).toBe(1);
  });

  it('goes down at once with a glow and is back at rest 6 frames later', () => {
    expect(pressState(59, 60)).toEqual({ scale: 1, glow: 0 });
    expect(pressState(60, 60).glow).toBe(1);
    expect(pressState(66, 60)).toEqual({ scale: 1, glow: 0 });
    for (let f = 61; f < 66; f++) {
      const { scale, glow } = pressState(f, 60);
      expect(scale).toBeGreaterThanOrEqual(0.96);
      expect(scale).toBeLessThanOrEqual(1);
      expect(glow).toBeLessThan(pressState(f - 1, 60).glow);
    }
  });
});

describe('the words of a WordCycle', () => {
  const WORDS = ['cards', 'transfers', 'cash'];
  const cycle = (count: number, beats: number): Scene => scene('WordCycle', beats, [framing('Get paid with'), ...WORDS.slice(0, count).map((word) => framing(word))]);
  const beat = (b: number, bpm = 112) => beatsToFrames(b, bpm);

  // Each word holds floor((beats - 1) / words) beats, at least 2 in a scene validateEdl takes; the last keeps the rest.
  const SPREADS: [description: string, count: number, beats: number, enters: number[]][] = [
    ['2 words over 5 beats', 2, 5, [1, 3]],
    ['2 words over 6 beats', 2, 6, [1, 3]],
    ['2 words over 8 beats (hold 3)', 2, 8, [1, 4]],
    ['3 words over 7 beats', 3, 7, [1, 3, 5]],
    ['3 words over 8 beats', 3, 8, [1, 3, 5]],
  ];

  it.each(SPREADS)('brings in the words of %s on the beats of their hold', (_, count, beats, enters) => {
    const timed = placed(cycle(count, beats), 112);
    expect(Array.from({ length: count }, (_, k) => wordEnterFrame(k, timed, 112))).toEqual(enters.map((b) => beat(b)));
  });

  it.each(SPREADS)('shows the word whose hold it is in %s, the prefix alone before the first and the last to the end', (_, count, beats, enters) => {
    const timed = placed(cycle(count, beats), 112);
    // Before beat 1 only the prefix is in: the word to come is the first.
    expect(cycleIndex(0, timed, 112)).toBe(0);
    enters.forEach((b, k) => {
      expect(cycleIndex(beat(b), timed, 112), `word ${k} on beat ${b}`).toBe(k);
      if (k > 0) expect(cycleIndex(beat(b) - 1, timed, 112), `the frame before beat ${b}`).toBe(k - 1);
    });
    // The last word keeps the rest of the scene.
    expect(cycleIndex(timed.duration - 1, timed, 112)).toBe(count - 1);
  });

  it('keeps every word on screen for at least two beats, the last one for the rest of the scene', () => {
    for (const bpm of [90, 112, 128])
      for (const [count, beats] of [[2, 5], [2, 7], [3, 7], [3, 8]] as const) {
        const timed = placed(cycle(count, beats), bpm);
        const enters = Array.from({ length: count }, (_, k) => wordEnterFrame(k, timed, bpm));
        const ends = [...enters.slice(1), timed.duration];
        ends.forEach((end, k) => expect(end - enters[k]!, `word ${k} of ${count} over ${beats} beats at ${bpm} bpm`).toBeGreaterThanOrEqual(beat(2, bpm) - 1));
      }
  });

  it('lands each word on a beat of the whole video, not of the scene', () => {
    // 3 words over 7 beats, from beat 7 of the video: the words come in on beats 8, 10 and 12.
    const timed = placed(cycle(3, 7), 113.19, 7);
    expect(wordEnterFrame(1, timed, 113.19)).toBe(beatsToFrames(10, 113.19) - timed.from);
    expect(wordEnterFrame(2, timed, 113.19)).toBe(beatsToFrames(12, 113.19) - timed.from);
    expect(cycleIndex(beatsToFrames(10, 113.19) - timed.from - 1, timed, 113.19)).toBe(0);
    expect(cycleIndex(beatsToFrames(10, 113.19) - timed.from, timed, 113.19)).toBe(1);
    expect(cycleIndex(beatsToFrames(12, 113.19) - timed.from, timed, 113.19)).toBe(2);
  });
});

describe('the captions of a UI scene', () => {
  const ui = (lines: Line[], beats = 6) => scene('UiFocus', beats, lines);

  it('swaps the caption at atBeat', () => {
    const lines = [framing('Your shop in one link'), framing('Customers pay you directly', 2)];
    const timed = placed(ui(lines), 112);
    expect(captionSwapFrame(lines, timed, 112)).toBe(beatsToFrames(2, 112));
    expect(captionIndex(lines, 0, timed, 112)).toBe(0);
    expect(captionIndex(lines, beatsToFrames(2, 112) - 1, timed, 112)).toBe(0);
    expect(captionIndex(lines, beatsToFrames(2, 112), timed, 112)).toBe(1);
    expect(captionIndex(lines, timed.duration - 1, timed, 112)).toBe(1);
  });

  it('keeps one caption when no line has an atBeat inside the scene', () => {
    const together = [framing('Your shop'), framing('in one link')];
    expect(captionSwapFrame(together, placed(ui(together), 112), 112)).toBeUndefined();
    expect(captionIndex(together, 100, placed(ui(together), 112), 112)).toBe(0);
    const late = [framing('Your shop'), framing('in one link', 6)];
    expect(captionSwapFrame(late, placed(ui(late), 112), 112)).toBeUndefined();
  });

  it('swaps on a beat of the whole video', () => {
    const lines = [framing('Your shop in one link'), framing('Customers pay you directly', 3)];
    const timed = placed(ui(lines), 113.19, 5);
    expect(captionSwapFrame(lines, timed, 113.19)).toBe(beatsToFrames(8, 113.19) - timed.from);
  });
});

describe('the camera of a UI scene', () => {
  it('glides UiScroll from frame 6 to the settled frame, the one the key frame review samples', () => {
    // 6 beats at 120 bpm: 90 frames, settled 8 frames before the end.
    const timed = placed(scene('UiScroll', 6, [framing('Mirá')]), 120, 4);
    expect(cameraFrames(timed)).toEqual({ start: 6, end: 82 });
    expect(cameraFrames(timed).end).toBe(settledFrame(timed) - timed.from);
  });

  it('lands UiFocus at 72% of the scene, and never after the settled frame', () => {
    expect(cameraFrames(placed(scene('UiFocus', 6, [framing('Mirá')]), 120, 4))).toEqual({ start: 4, end: 64.8 });
    // 2 beats at 128 bpm: 28 frames, of which 72% (20.16) would come after the settled frame (20).
    const short = placed(scene('UiFocus', 2, [framing('Mirá')]), 128, 2);
    expect(short.duration).toBe(28);
    expect(cameraFrames(short)).toEqual({ start: 4, end: settledFrame(short) - short.from });
  });
});

describe('the changes of text in a scene', () => {
  it('lists the caption swap of a UI scene and every word after the first of a WordCycle, within the scene', () => {
    const swap = scene('UiScroll', 6, [framing('One'), framing('Two', 4)]);
    expect(textChanges(placed(swap, 120), 120)).toEqual([60]);
    const cycle = scene('WordCycle', 7, [framing('Sell'), framing('shoes'), framing('books'), framing('courses')]);
    // "books" comes in on beat 3 and "courses" on beat 5 (15 frames a beat at 120 bpm); "shoes" is the first, in from beat 1.
    expect(textChanges(placed(cycle, 120), 120)).toEqual([45, 75]);
    const pair = scene('WordCycle', 8, [framing('Sell'), framing('shoes'), framing('books')]);
    expect(textChanges(placed(pair, 120), 120)).toEqual([60]);
    expect(textChanges(placed(scene('KineticHeadline', 4, [framing('One'), framing('Two', 2)]), 120), 120)).toEqual([]);
  });
});

describe('the lines of a headline', () => {
  it('reveals headline line i on beat i', () => {
    expect(lineEnterFrame(2, 112)).toBe(beatsToFrames(2, 112));
    expect(lineEnterFrame(0, 112)).toBe(0);
  });
});

describe('the two steps of the EndCard', () => {
  const close = (beats: number) => scene('EndCard', beats, [framing('Start free'), framing('Your shop in one link.')]);

  it('brings the button in on beat 3 and presses it on beat 4.5 of a 6-beat close', () => {
    const timed = placed(close(6), 112, 24);
    expect(endCardSteps(timed, 112)).toEqual({
      button: beatsToFrames(27, 112) - timed.from,
      press: beatsToFrames(28.5, 112) - timed.from,
    });
  });

  it('keeps those beats in a longer close', () => {
    const timed = placed(close(8), 112);
    expect(endCardSteps(timed, 112)).toEqual({ button: beatsToFrames(3, 112), press: beatsToFrames(4.5, 112) });
  });

  it('moves both earlier, on half beats, in a shorter close: 2.5 and 3.5 in 5 beats, 1.5 and 2.5 in 4', () => {
    expect(endCardSteps(placed(close(5), 112), 112)).toEqual({ button: beatsToFrames(2.5, 112), press: beatsToFrames(3.5, 112) });
    expect(endCardSteps(placed(close(4), 112), 112)).toEqual({ button: beatsToFrames(1.5, 112), press: beatsToFrames(2.5, 112) });
  });

  it('has the button in before the press and the press over by the settled frame, from 4 to 8 beats at 90 to 128 bpm', () => {
    for (const bpm of [90, 100, 112, 113.19, 120, 128])
      for (const beats of [4, 5, 6, 7, 8])
        for (const startBeat of [0, 5, 13, 22]) {
          const timed = placed(close(beats), bpm, startBeat);
          const { button, press } = endCardSteps(timed, bpm);
          const at = `${beats} beats at ${bpm} bpm from beat ${startBeat}`;
          expect(button + BUTTON_IN, at).toBeLessThanOrEqual(press);
          expect(press + PRESS_FRAMES, at).toBeLessThanOrEqual(settledFrame(timed) - timed.from);
        }
  });
});

describe('the press of a TypeIn', () => {
  it('presses on the half beat nearest three quarters of the scene, after the typing', () => {
    const typeIn = (beats: number) => scene('TypeIn', beats, [framing('tiendita.example')]);
    expect(typeInPressFrame(placed(typeIn(4), 112), 112)).toBe(beatsToFrames(3, 112));
    expect(typeInPressFrame(placed(typeIn(2), 112), 112)).toBe(beatsToFrames(1.5, 112));
    expect(typeInPressFrame(placed(typeIn(3), 112), 112)).toBe(beatsToFrames(2.5, 112));
    const late = placed(typeIn(4), 112, 3);
    expect(typeInPressFrame(late, 112)).toBe(beatsToFrames(6, 112) - late.from);
    for (const beats of [2, 3, 4, 5, 6, 7, 8]) {
      const timed = placed(typeIn(beats), 128);
      expect(typeInPressFrame(timed, 128)).toBeGreaterThan(timed.duration * 0.6);
    }
  });
});
