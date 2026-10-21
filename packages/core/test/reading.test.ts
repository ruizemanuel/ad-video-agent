import { describe, expect, it } from 'vitest';
import {
  BUTTON_IN,
  CAPTION_DELAY,
  CAPTION_SWAP,
  FPS,
  READING_TOLERANCE_FRAMES,
  REVEAL_FRAMES,
  TAGLINE_AT,
  WIPE_FRAMES,
  WORD_ROLL,
  beatsToFrames,
  captionRoom,
  isReadable,
  layoutScenes,
  readableIn,
  readingSeconds,
  textWindows,
  validateEdl,
  type Edl,
  type Line,
  type Scene,
  type TextWindow,
  type TimedScene,
} from '../src/index';
import { claim, framing, paidRunsSite, run4, run7 } from './fixtures/paid-runs';

/** A scene placed at `startBeat` of a video at `bpm`, as layoutScenes places it. */
const placed = (scene: Scene, bpm: number, startBeat = 0, index = 1): TimedScene => {
  const from = beatsToFrames(startBeat, bpm);
  return { scene, role: 'body', index, from, duration: beatsToFrames(startBeat + scene.beats, bpm) - from, startBeat };
};
const windows = (scene: Scene, { bpm = 120, startBeat = 4, index = 1, wipeOut = false } = {}): TextWindow[] =>
  textWindows(placed(scene, bpm, startBeat, index), bpm, wipeOut);
const f = (text: string, atBeat?: number): Line => framing(text, atBeat);

// At 120 bpm a beat is exactly 15 frames, so every frame below can be counted by hand.
describe('textWindows', () => {
  describe('the captions of a UI scene', () => {
    const swap = (piece: 'UiFocus' | 'UiScroll' = 'UiFocus'): Scene => ({ piece, beats: 6, lines: [f('Your shop in one link'), f('Customers pay you', 3)] });

    it('has the first caption in once it has risen, and leaving on the beat of the second', () =>
      expect(windows(swap())[0]).toEqual({ line: 0, text: 'Your shop in one link', fullyIn: CAPTION_DELAY + REVEAL_FRAMES, leaves: 45 }));

    it('has the second caption in once it has faded in, and leaving at the cut', () =>
      expect(windows(swap('UiScroll'))[1]).toEqual({ line: 1, text: 'Customers pay you', fullyIn: 45 + CAPTION_SWAP.in.to, leaves: 90 }));

    it('has a text leave when the wipe that brings the next scene in starts to cover it', () =>
      expect(windows(swap(), { wipeOut: true })[1]?.leaves).toBe(90 - WIPE_FRAMES / 2));

    it('reads the lines of a scene whose caption is never replaced as one caption', () => {
      expect(windows({ piece: 'UiFocus', beats: 6, lines: [f('Your shop'), f('in one link')] })).toEqual([{ line: 0, text: 'Your shop in one link', fullyIn: 18, leaves: 90 }]);
      // An atBeat at or past the end of the scene replaces nothing.
      expect(windows({ piece: 'UiScroll', beats: 6, lines: [f('Your shop'), f('in one link', 6)] })).toHaveLength(1);
    });
  });

  describe('a headline', () => {
    const headline: Scene = { piece: 'KineticHeadline', beats: 6, lines: [f('Sell'), f('with no'), f('fees.')] };

    it('has line i in once it has risen from beat i, each on its own', () =>
      expect(windows(headline).map((w) => [w.fullyIn, w.leaves])).toEqual([
        [16, 90],
        [31, 90],
        [46, 90],
      ]));

    it('brings the first line of the opening headline in after the brand over it', () => expect(windows(headline, { startBeat: 0, index: 0 })[0]?.fullyIn).toBe(4 + 16));

    it('has nothing in under the wipe that brings the scene in', () => {
      // A wipe covers the first WIPE_FRAMES / 2 frames: no text of these pieces is in that soon anyway.
      for (const w of windows({ ...headline, transitionIn: 'wipe' })) expect(w.fullyIn).toBeGreaterThanOrEqual(WIPE_FRAMES / 2);
    });
  });

  it('has each line of a ClaimStack in once it has risen from its beat', () =>
    expect(windows({ piece: 'ClaimStack', beats: 7, lines: [f('One'), f('Two'), f('Three')] }, { wipeOut: true }).map((w) => [w.fullyIn, w.leaves])).toEqual([
      [16, 99],
      [46, 99],
      [76, 99],
    ]));

  it('has the prefix of a WordCycle all along, and each word from its roll in to the roll in of the next', () =>
    expect(windows({ piece: 'WordCycle', beats: 7, lines: [f('Get paid with'), f('cards'), f('transfers'), f('cash')] }).map((w) => [w.text, w.fullyIn, w.leaves])).toEqual([
      ['Get paid with', 16, 105],
      ['cards', 15 + WORD_ROLL, 45],
      ['transfers', 45 + WORD_ROLL, 75],
      ['cash', 75 + WORD_ROLL, 105],
    ]));

  it('has the button of the close in once it has come in on beat 2, and the tagline under the brand, both to the end', () =>
    expect(windows({ piece: 'EndCard', beats: 6, lines: [f('Start free'), f('Your shop in one link.')] })).toEqual([
      { line: 0, text: 'Start free', fullyIn: 30 + BUTTON_IN, leaves: 90 },
      { line: 1, text: 'Your shop in one link.', fullyIn: TAGLINE_AT + REVEAL_FRAMES, leaves: 90 },
    ]));

  it('leaves out what a TypeIn types: it is read as it is typed', () =>
    expect(windows({ piece: 'TypeIn', beats: 4, variant: 'prompt', lines: [f('Where do my customers pay me?')] })).toEqual([]));
});

describe('the reading rule', () => {
  it('asks each text for 5/6 s at least, 1 s per 17 characters and 0.3 s per word, whichever is longest', () => {
    expect(readingSeconds('Hola')).toBeCloseTo(5 / 6);
    // 32 characters, 7 words: the words ask the most.
    expect(readingSeconds('La plata va directo a tu cuenta.')).toBeCloseTo(2.1);
    // 31 characters, 6 words.
    expect(readingSeconds('¿Cuánto te queda de cada venta?')).toBeCloseTo(31 / 17);
    // Characters, not UTF-16 units.
    expect(readingSeconds('🛍'.repeat(17 * 2))).toBeCloseTo(2);
  });

  it('passes a window up to READING_TOLERANCE_FRAMES frames short of the need, and no shorter', () => {
    // "Hola" needs 5/6 s: 25 frames.
    const window = (frames: number): TextWindow => ({ line: 0, text: 'Hola', fullyIn: 10, leaves: 10 + frames });
    expect(READING_TOLERANCE_FRAMES).toBe(2);
    expect(isReadable(window(25))).toBe(true);
    expect(isReadable(window(23))).toBe(true);
    expect(isReadable(window(22))).toBe(false);
  });

  it('gives the most characters and words a window holds, and nothing under 5/6 s', () => {
    // 47 frames and the tolerance: 1.63 s, 27 characters and 5 words.
    expect(readableIn(47)).toEqual({ chars: 27, words: 5 });
    expect(readableIn(23)).toEqual({ chars: 14, words: 2 });
    expect(readableIn(22)).toBeUndefined();
  });
});

describe('captionRoom', () => {
  /** Whether a caption of `chars` characters (words of six letters) is read in a UiFocus of `beats` beats with a wipe after it, from `startBeat`. */
  const reads = (chars: number, beats: number, bpm: number, captions: 1 | 2, startBeat: number): boolean => {
    const text = 'abcdef '.repeat(chars).slice(0, chars - 1) + '.';
    const lines = captions === 1 ? [f(text)] : [f(text), f(text, Math.ceil(beats / 2))];
    return windows({ piece: 'UiFocus', beats, lines }, { bpm, startBeat, wipeOut: true }).every(isReadable);
  };
  const STARTS = Array.from({ length: 64 }, (_, i) => i);

  it.each([
    [4, 98, 1],
    [4, 112, 1],
    [6, 128, 1],
    [8, 112, 2],
    [7, 98, 2],
  ] as [number, number, 1 | 2][])('gives the most characters of each caption of a UI scene of %i beats at %i bpm (%i captions) read wherever it starts', (beats, bpm, captions) => {
    const room = captionRoom(beats, bpm, captions);
    expect(room).toBeGreaterThan(0);
    for (const startBeat of STARTS) expect(reads(room, beats, bpm, captions, startBeat), `from beat ${startBeat}`).toBe(true);
    expect(STARTS.some((startBeat) => !reads(room + 1, beats, bpm, captions, startBeat))).toBe(true);
  });

  it('gives nothing when not even the shortest caption can be read', () => {
    expect(captionRoom(2, 112, 1)).toBe(0);
    expect(captionRoom(4, 112, 2)).toBe(0);
  });
});

describe('validateEdl: every text stays on screen long enough to read', () => {
  const site = paidRunsSite();
  const problems = (edl: Edl) => validateEdl(edl, site);

  it('refuses the four captions of paid run 7 that went by too fast, and the two caption swaps of its short scenes', () => {
    const swap = (beats: number) => `a second caption (atBeat) needs a scene of 7 beats or more, got ${beats}: drop the second caption, or give the scene 7 beats or more`;
    const hookFix = 'drop the second caption and either give the scene 5 beats or cut the first caption to 26 characters and 5 words';
    expect(problems(run7())).toEqual([
      { where: 'hooks[0][0].lines[1]', rule: 'structure', detail: swap(4) },
      { where: 'hooks[0][0].lines[0]', rule: 'structure', detail: `caption 1 "¿Cuánto te queda de cada venta?" (31 characters) is readable 1.13 s of the 1.82 s it needs: ${hookFix}` },
      { where: 'hooks[0][0].lines[1]', rule: 'structure', detail: `caption 2 "La plata va directo a tu cuenta." (32 characters) is readable 0.17 s of the 2.10 s it needs: ${hookFix}` },
      { where: 'body[1].lines[1]', rule: 'structure', detail: swap(6) },
      { where: 'body[1].lines[0]', rule: 'structure', detail: 'caption 1 "Productos digitales y sesiones 1:1." (35 characters) is readable 1.13 s of the 2.06 s it needs: drop the second caption' },
      { where: 'body[1].lines[1]', rule: 'structure', detail: 'caption 2 "Un solo link para tu bio." (25 characters) is readable 1.53 s of the 1.80 s it needs: drop the second caption' },
    ]);
  });

  it("refuses paid run 4's hook caption and its UiScroll's first caption, and nothing else", () => {
    expect(problems(run4())).toEqual([
      {
        where: 'hooks[0][0].lines[0]',
        rule: 'structure',
        detail: 'the caption "Productos digitales y sesiones 1:1." (35 characters) is readable 1.37 s of the 2.06 s it needs: give the scene 6 beats, or cut it to 24 characters and 4 words',
      },
      {
        where: 'body[1].lines[0]',
        rule: 'structure',
        detail: 'caption 1 "Productos, precios y pago en un link." (37 characters) is readable 1.57 s of the 2.18 s it needs: drop the second caption, or cut it to 27 characters and 5 words',
      },
    ]);
  });

  // The fix the investigation of run 7 sketched: one short caption in the hook, two short ones in an 8-beat UiScroll, and
  // the claim that went by fastest either left out or given a headline of its own.
  const fixed = (withClaim: boolean): Edl => {
    const edl = run7();
    const [headline, , cycle, focus] = edl.body;
    const own: Scene = { piece: 'KineticHeadline', beats: 4, lines: [claim('La plata va directo', 'c1'), claim('a tu cuenta.', 'c1')] };
    const scroll: Scene = { piece: 'UiScroll', beats: 8, shotId: 's1-mobile', boxIndex: 2, lines: [claim('Productos y sesiones 1:1.', 'c3'), claim('Un solo link para tu bio.', 'c4', 4)] };
    return {
      ...edl,
      hooks: [[{ piece: 'UiFocus', beats: 4, shotId: 's1-mobile', boxIndex: 0, lines: [framing('¿Cuánto te queda?')] }]],
      body: [headline!, ...(withClaim ? [own] : []), scroll, cycle!, focus!],
    };
  };

  it.each([
    [false, 34, 19.6],
    [true, 38, 21.9],
  ])('passes run 7 fixed as the investigation sketched it (the claim of the hook in a headline of its own: %s): %i beats, %s s', (withClaim, beats, seconds) => {
    const edl = fixed(withClaim);
    expect(problems(edl)).toEqual([]);
    const { total } = layoutScenes(edl, 0);
    expect(total).toBe(beatsToFrames(beats, edl.bpm));
    expect(total / FPS).toBeCloseTo(seconds, 1);
  });

  describe('the close passes at its usual length, 6 beats, at every tempo', () => {
    const close = (button: string, tagline: string): Scene => ({ piece: 'EndCard', beats: 6, lines: [f(button), f(tagline)] });
    const sweep = (from: number, to: number): number[] => Array.from({ length: Math.round((to - from) * 4) + 1 }, (_, i) => from + i / 4);
    const unread = (scene: Scene, bpm: number): TextWindow[] =>
      [0, 7, 13, 22, 29, 34].flatMap((startBeat) => textWindows(placed(scene, bpm, startBeat), bpm, false).filter((w) => !isReadable(w)));

    it("keeps run 4's and run 7's 21-character button and a 28-character tagline readable at every tempo the director can ask for (90-128 bpm)", () => {
      const scene = close('Creá tu tienda gratis', 'Dejá de regalar tu comisión.');
      for (const bpm of sweep(90, 128)) expect(unread(scene, bpm), `${bpm} bpm`).toEqual([]);
    });

    it('keeps a 20-character button and the same tagline readable at every tempo the music can come at (76.5-147.2 bpm)', () => {
      // validateEdl takes 90 to 128 bpm, and chooseTrack takes a track within 15 % of the tempo asked for.
      const scene = close('Comenzá gratis ahora', 'Dejá de regalar tu comisión.');
      for (const bpm of sweep(76.5, 147.25)) expect(unread(scene, bpm), `${bpm} bpm`).toEqual([]);
    });

    it("would have left run 4's button short with the button on beat 3, as it was", () => {
      // The button came in on beat 3: three beats at 111 bpm less the 14 frames it takes to come in.
      const frames = beatsToFrames(34, 111) - beatsToFrames(31, 111) - BUTTON_IN;
      expect(isReadable({ line: 0, text: 'Creá tu tienda gratis', fullyIn: 0, leaves: frames })).toBe(false);
    });
  });
});
