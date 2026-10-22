// The pieces animate their text with the timing core checks the edit list against (see textWindows): these tests pin
// what a piece really draws to the constant core reads, so that the render and the reading check cannot drift apart.
import { beatsToFrames, CAPTION_GAP, CAPTION_LINE, CAPTION_SWAP, FPS, REVEAL_FRAMES, stageLayout, textWindows, type Format, type TimedScene } from '@app/core';
import { describe, expect, it } from 'vitest';
import { captionFade, raisedCardTop, revealDrop } from '../src/video/pieces/common';
import { typedChars } from '../src/video/rhythm';
import { toWords, type TypeLine } from '../src/video/type';

describe('a line revealed through its mask', () => {
  it('is in place REVEAL_FRAMES frames after it starts to rise, and not before', () => {
    expect(revealDrop(10, 10, FPS)).toBe(1);
    expect(revealDrop(10 + REVEAL_FRAMES, 10, FPS)).toBeLessThan(0.005);
    expect(revealDrop(10 + REVEAL_FRAMES - 4, 10, FPS)).toBeGreaterThan(0.005);
  });
});

describe('a caption replaced on its beat', () => {
  const swap = 60;

  it('has the caption that goes out within CAPTION_SWAP.out frames of the beat', () => {
    expect(captionFade(swap, swap).out).toBe(0);
    expect(captionFade(swap + CAPTION_SWAP.out - 1, swap).out).toBeLessThan(1);
    expect(captionFade(swap + CAPTION_SWAP.out, swap).out).toBe(1);
  });

  it('has the caption that comes in from CAPTION_SWAP.in.from to CAPTION_SWAP.in.to frames after the beat', () => {
    expect(captionFade(swap + CAPTION_SWAP.in.from, swap).come).toBe(0);
    expect(captionFade(swap + CAPTION_SWAP.in.to - 1, swap).come).toBeLessThan(1);
    expect(captionFade(swap + CAPTION_SWAP.in.to, swap).come).toBe(1);
  });

  it('shows the first caption alone when nothing replaces it', () => expect(captionFade(200, undefined)).toEqual({ out: 0, come: 0 }));
});

describe('a typed text', () => {
  it('is whole in the field on the frame textWindows says it is fully in, and not a frame before', () => {
    const text = 'tiendita.example';
    for (const bpm of [90, 104, 112, 113.19, 128])
      for (const beats of [2, 3, 4, 5, 6, 8]) {
        const duration = beatsToFrames(beats, bpm);
        const timed: TimedScene = { scene: { piece: 'TypeIn', beats, variant: 'url', lines: [{ text, kind: 'framing' }] }, role: 'hook', index: 0, from: 0, duration, startBeat: 0 };
        const [typed] = textWindows(timed, bpm, false);
        const at = `${beats} beats at ${bpm} bpm`;
        expect(typedChars(text, typed?.fullyIn ?? 0, duration), at).toBe(text.length);
        expect(typedChars(text, (typed?.fullyIn ?? 0) - 1, duration), at).toBeLessThan(text.length);
      }
  });
});

describe('the card of a UI scene', () => {
  const today = stageLayout('9x16').cardTop;
  const line = CAPTION_LINE['9x16']!;
  const caption = (count: number, size: number) => ({ lines: Array.from({ length: count }, (): TypeLine => toWords({ text: 'Vendé lo tuyo.', kind: 'framing' })), size });
  /** The top of the content box of the caption's first line: its block ends CAPTION_GAP above the card, lines 0.14 em apart. */
  const contentTop = (cardTop: number, { lines, size }: ReturnType<typeof caption>, lineHeight: number, overhang: number) =>
    cardTop - CAPTION_GAP - (lines.length * lineHeight + (lines.length - 1) * 0.14) * size - overhang;

  it("rises so that a caption's first line starts at the caption line, as run 8 and run 9 measured them", () => {
    // Size, line height and how far the content box reaches above the line box, as Chrome laid out the captions.
    const runs: [string, number, number, number, number][] = [
      ['run 8 hook', 1, 67, 0.96, 8],
      ['run 8 body[1]', 2, 94, 0.96, 11],
      ['run 8 body[3]', 1, 91, 0.96, 12],
      ['run 9 body[0]', 1, 83, 1.12, 11],
      ['run 9 body[2]', 1, 62, 1.12, 8],
    ];
    expect(runs.map(([, count, size, lineHeight, overhang]) => raisedCardTop('9x16', [caption(count, size)], lineHeight, overhang))).toEqual([405, 537, 432, 436, 410]);
  });

  it('starts the content box of the first line at the caption line, under it by less than a pixel, else leaves the card where it is', () => {
    let raised = 0;
    for (const lineHeight of [0.94, 0.96, 1, 1.07, 1.12])
      for (const count of [1, 2])
        for (let size = 44; size <= 100; size += 1) {
          const set = caption(count, size);
          const overhang = Math.ceil(((1.21 - lineHeight) * size) / 2);
          const cardTop = raisedCardTop('9x16', [set], lineHeight, overhang)!;
          const at = `${count} lines at ${size} px, line height ${lineHeight}`;
          expect(cardTop, at).toBeLessThanOrEqual(today);
          // On today's stage, a caption that leaves no room to rise into starts under the line by less than a pixel, or above it.
          if (cardTop === today) expect(contentTop(today, set, lineHeight, overhang), at).toBeLessThan(line + 1);
          else {
            raised += 1;
            expect(contentTop(cardTop, set, lineHeight, overhang), at).toBeGreaterThanOrEqual(line);
            expect(contentTop(cardTop, set, lineHeight, overhang), at).toBeLessThan(line + 1);
          }
        }
    // Every one-line caption leaves room; two lines at the largest size fill the block.
    expect(raised).toBeGreaterThan(5 * 57);
    expect(raisedCardTop('9x16', [caption(2, 100)], 1.12, 6)).toBe(today);
  });

  it('leaves room for the taller of two captions that replace one another', () => {
    const [one, two] = [caption(1, 80), caption(2, 80)];
    for (const captions of [[one, two], [two, one]]) expect(raisedCardTop('9x16', captions, 1, 8)).toBe(raisedCardTop('9x16', [two], 1, 8));
    expect(contentTop(raisedCardTop('9x16', [one, two], 1, 8)!, one, 1, 8)).toBeGreaterThan(line + 80);
  });

  it('leaves the card where it is in the formats with no caption line', () => {
    for (const format of ['16x9', '4x5'] as Format[]) expect(raisedCardTop(format, [caption(1, 60)], 1, 8), format).toBeUndefined();
  });
});
