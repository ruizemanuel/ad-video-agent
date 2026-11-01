// How a WordFlash sets its words, as plain math: their largest size, the punch of scale on each beat, which line is on
// screen, and one size for every line of the scene.
import { describe, expect, it } from 'vitest';
import { flashIndex, flashMax, flashScale, flashWords } from '../src/video/pieces/WordFlash';
import { lineText, toWords, type Measure, type TypeLine } from '../src/video/type';

// A stand-in for the browser's measure: every character is 0.6 em wide.
const perChar: Measure = (text) => text.length * 0.6;
/** Each line of the edit list as the piece hands it over: a text of one source line. */
const texts = (lines: string[]): TypeLine[][] => lines.map((text) => [toWords({ text, kind: 'framing' })]);
const linesOf = (set: { lines: TypeLine[][] }): string[][] => set.lines.map((lines) => lines.map(lineText));

describe('a WordFlash', () => {
  it('sets its words as large as twice the headline', () => {
    expect(flashMax('9x16')).toBe(300);
    expect(flashMax('16x9')).toBe(352);
    expect(flashMax('4x5')).toBe(256);
  });

  it('punches each word in at 1.05 and settles it to 1 over 4 frames', () => {
    expect(flashScale(0)).toBe(1.05);
    expect(flashScale(4)).toBe(1);
    for (const since of [1, 2, 3]) {
      expect(flashScale(since)).toBeLessThan(flashScale(since - 1));
      expect(flashScale(since)).toBeGreaterThan(1);
      expect(flashScale(since)).toBeLessThan(1.05);
    }
  });

  it('shows the line whose beat has come, the first before any', () => {
    const enters = [0, 15, 45, 60];
    expect([0, 14, 15, 59, 60, 200].map((frame) => flashIndex(frame, enters))).toEqual([0, 0, 1, 2, 3, 3]);
  });

  it('sets every line at the size of the one that fits least, a phrase on two lines where one would be smaller', () => {
    // "Cobrás" sets the size; on one line, "lo tuyo." would be set at 147.
    const set = flashWords(texts(['Vendé', 'lo tuyo.', 'Cobrás', 'todo.']), '9x16', false, 1.1, perChar);
    expect(linesOf(set)).toEqual([['Vendé'], ['lo', 'tuyo.'], ['Cobrás'], ['todo.']]);
    expect(set.size).toBe(197);
  });

  it("leaves the brand's band above and as much below when the flash opens the video", () => {
    const wide = flashWords(texts(['en un link.']), '16x9', false, 1.1, perChar);
    expect(linesOf(wide)).toEqual([['en un', 'link.']]);
    expect(wide.size).toBe(352);
    // The height of the column less two bands of 152 (twice the logo of 16x9) holds two lines at 273.
    const opening = flashWords(texts(['en un link.']), '16x9', true, 1.1, perChar);
    expect(linesOf(opening)).toEqual([['en un', 'link.']]);
    expect(opening.size).toBe(273);
  });
});
