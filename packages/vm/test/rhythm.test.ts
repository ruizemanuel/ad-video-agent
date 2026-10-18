import { beatsToFrames, settledFrame, type Line, type Scene, type TimedScene } from '@app/core';
import { describe, expect, it } from 'vitest';
import { captionIndex, captionSwapFrame, cycleIndex, endCardSteps, lineEnterFrame, pressState, textChanges, typedChars, typeInPressFrame, wordEnterFrame } from '../src/video/rhythm';

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
  const cycle = scene('WordCycle', 6, [framing('Get paid with'), framing('cards'), framing('transfers'), framing('cash')]);

  it('shows one word per beat', () => {
    const timed = placed(cycle, 112);
    const beat = (b: number) => beatsToFrames(b, 112);
    // Before beat 1 only the prefix is in: the word to come is the first.
    expect(cycleIndex(0, timed, 112, 3)).toBe(0);
    expect(wordEnterFrame(0, timed, 112)).toBe(beat(1));
    expect(cycleIndex(beat(1), timed, 112, 3)).toBe(0);
    expect(cycleIndex(beat(2) - 1, timed, 112, 3)).toBe(0);
    expect(cycleIndex(beat(2), timed, 112, 3)).toBe(1);
    expect(cycleIndex(beat(3), timed, 112, 3)).toBe(2);
    // The last word holds to the end of the scene.
    expect(cycleIndex(beat(5), timed, 112, 3)).toBe(2);
    expect(cycleIndex(timed.duration - 1, timed, 112, 3)).toBe(2);
  });

  it('lands each word on a beat of the whole video, not of the scene', () => {
    const timed = placed(cycle, 113.19, 7);
    expect(wordEnterFrame(1, timed, 113.19)).toBe(beatsToFrames(9, 113.19) - timed.from);
    expect(cycleIndex(beatsToFrames(9, 113.19) - timed.from - 1, timed, 113.19, 3)).toBe(0);
    expect(cycleIndex(beatsToFrames(9, 113.19) - timed.from, timed, 113.19, 3)).toBe(1);
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

describe('the changes of text in a scene', () => {
  it('lists the caption swap of a UI scene and every word after the first of a WordCycle, within the scene', () => {
    const swap = scene('UiScroll', 6, [framing('One'), framing('Two', 4)]);
    expect(textChanges(placed(swap, 120), 120)).toEqual([60]);
    const cycle = scene('WordCycle', 3, [framing('Sell'), framing('shoes'), framing('books'), framing('courses')]);
    // "books" comes in on beat 2; "courses" would on beat 3, the end of the scene.
    expect(textChanges(placed(cycle, 120), 120)).toEqual([30]);
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

  it('keeps the proportions in a shorter close, with the button in and pressed before the settled frame', () => {
    const four = placed(close(4), 112);
    expect(endCardSteps(four, 112)).toEqual({ button: beatsToFrames(2, 112), press: beatsToFrames(3, 112) });
    for (const bpm of [90, 112, 128])
      for (const beats of [2, 3, 4, 5, 6]) {
        const timed = placed(close(beats), bpm);
        const { button, press } = endCardSteps(timed, bpm);
        const settled = settledFrame(timed) - timed.from;
        expect(button, `${beats} beats at ${bpm}`).toBeLessThanOrEqual(settled - 14);
        expect(press, `${beats} beats at ${bpm}`).toBeGreaterThan(button);
        expect(press, `${beats} beats at ${bpm}`).toBeLessThan(timed.duration);
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
