// How a WordFlash sets its words, as plain math: their largest size, the punch of scale on each beat, which line is on
// screen, and the size of each line.
import { FLASH_READING, FPS, WIPE_FRAMES, type Line, type TimedScene } from '@app/core';
import { describe, expect, it } from 'vitest';
import { BEFORE_CHANGE } from '../src/render/keyframes';
import { FLASH_PUNCH, FLASH_SCALE, flashIndex, flashMax, flashScale, flashWords, punchStarts } from '../src/video/pieces/WordFlash';
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

  it('punches each word in at 1.05 and settles it to 1 over 6 frames, by the same step each frame', () => {
    expect(FLASH_PUNCH).toBe(6);
    expect(flashScale(0)).toBe(1.05);
    expect(flashScale(6)).toBe(1);
    for (const since of [1, 2, 3, 4, 5]) {
      expect(flashScale(since)).toBeLessThan(flashScale(since - 1));
      expect(flashScale(since)).toBeGreaterThan(1);
      expect(flashScale(since - 1) - flashScale(since)).toBeCloseTo((FLASH_SCALE - 1) / FLASH_PUNCH, 10);
    }
    // Most of the punch is still there on its third frame: an ease out spent it all on the first.
    expect(flashScale(2) - 1).toBeGreaterThanOrEqual(0.4 * (FLASH_SCALE - 1));
  });

  it('settles each word before its still is taken', () => {
    // A still is taken BEFORE_CHANGE frames before the line is replaced, and a line holds at least the half second a word
    // alone needs (15 frames).
    expect(FLASH_PUNCH + BEFORE_CHANGE).toBeLessThan(FLASH_READING.seconds * FPS);
  });

  it('punches the first word of a flash that a wipe brings in once the wipe has cleared it, the others on their beat', () => {
    const lines: Line[] = ['Vendé', 'lo tuyo', 'Cobrás'].map((text) => ({ text, kind: 'framing' }));
    const placed = (index: number, transitionIn?: 'wipe'): TimedScene => ({
      scene: { piece: 'WordFlash', beats: 6, lines, ...(transitionIn ? { transitionIn } : {}) },
      role: 'hook',
      index,
      from: 0,
      duration: 96,
      startBeat: 0,
    });
    const enters = [0, 32, 64];
    expect(punchStarts(enters, placed(1, 'wipe'))).toEqual([WIPE_FRAMES / 2, 32, 64]);
    expect(punchStarts(enters, placed(1))).toEqual(enters);
    // Under the wipe the first word waits at the scale it punches from.
    expect(flashScale(3 - WIPE_FRAMES / 2)).toBe(FLASH_SCALE);
  });

  it('shows the line whose beat has come, the first before any', () => {
    const enters = [0, 15, 45, 60];
    expect([0, 14, 15, 59, 60, 200].map((frame) => flashIndex(frame, enters))).toEqual([0, 0, 1, 2, 3, 3]);
  });

  // In 9x16 a line may be 760 / 1.05 × 0.98 ≈ 709 px wide: 3 em (5 characters) at 236, 4.2 em at 168, 3.6 em at 197.
  it('sets each line as large as it fits the column, a phrase on one line while it stays over the headline', () => {
    // "lo tuyo" on one line is set at 168, over the headline (150): it is not split.
    const set = flashWords(texts(['Vendé', 'lo tuyo', 'Cobrás', 'todo.']), '9x16', false, 1.1, perChar);
    expect(linesOf(set)).toEqual([['Vendé'], ['lo tuyo'], ['Cobrás'], ['todo.']]);
    expect(set.sizes).toEqual([236, 168, 197, 236]);
  });

  it('splits a phrase in two where on one line it would be smaller than the headline', () => {
    // On one line, "en un link." would be set at 107.
    const set = flashWords(texts(['en un link.']), '9x16', false, 1.1, perChar);
    expect(linesOf(set)).toEqual([['en un', 'link.']]);
    expect(set.sizes).toEqual([236]);
  });

  it("leaves the brand's band above and as much below the first line of a flash that opens the video, and the whole column to the others", () => {
    // In 16x9 "en un solo link." is split ("en un" / "solo link.") and set at 280 by its width, but for the first line of an
    // opening, whose two lines have the height of the column less two bands of 152 (twice the logo of 16x9), at the scale of
    // the punch: (960 - 304) / 1.05 / 2.4 = 260.
    const lines = texts(['en un solo link.', 'en un solo link.']);
    const opening = flashWords(lines, '16x9', true, 1.1, perChar);
    expect(linesOf(opening)).toEqual([
      ['en un', 'solo link.'],
      ['en un', 'solo link.'],
    ]);
    expect(flashWords(lines, '16x9', false, 1.1, perChar).sizes).toEqual([280, 280]);
    expect(opening.sizes).toEqual([260, 280]);
  });
});
