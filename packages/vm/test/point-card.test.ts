// Where a card of a series sets its text, as plain math: the titles' size, the room over the subline, the height every
// card of the series starts its text at, and the slow push in on it.
import { safeWidth } from '@app/core';
import { describe, expect, it } from 'vitest';
import { cardPush, cardWidth, seriesTitles, seriesTop, sublineGap } from '../src/video/pieces/PointCard';
import { lineText, toWords, type Measure } from '../src/video/type';

describe('a card of a series', () => {
  it('sets the titles of a series on two lines as large as the headline where one line would be set smaller', () => {
    // A stand-in for the browser's measure: every character is 0.6 em wide.
    const perChar: Measure = (text) => text.length * 0.6;
    const title = (text: string) => [toWords({ text, kind: 'claim' })];
    // On one line "Cobrás todo." would be set at 117 px, under the 150 of the 9x16 headline: it takes two lines at 150.
    const set = seriesTitles([title('Cobrás todo.'), title('Vendé lo tuyo.')], '9x16', perChar);
    expect(set.lines.map((lines) => lines.map(lineText))).toEqual([
      ['Cobrás', 'todo.'],
      ['Vendé', 'lo tuyo.'],
    ]);
    expect(set.size).toBe(150);
  });

  it("leaves 65 % of the title's size over the subline: the room the rule and its two gaps took", () => {
    expect(sublineGap(150)).toBe(98);
    expect(sublineGap(128)).toBe(83);
  });

  it('starts the text of every card where the tallest block of the series stands centered in the safe zone', () => {
    // 9x16: the safe zone runs from 220 px for 1280 px. A block of 351 px is centered from 220 + 464.5, rounded.
    expect(seriesTop('9x16', [351, 200])).toBe(685);
    expect(seriesTop('9x16', [200, 351])).toBe(685);
    // 4x5: from 80 px for 1110 px.
    expect(seriesTop('4x5', [300])).toBe(485);
  });

  it('starts a block taller than the safe zone at its top', () => {
    expect(seriesTop('9x16', [1500])).toBe(220);
  });

  it('pushes in on its text over the scene, evenly, from 100 % to 106 %', () => {
    expect(cardPush(0, 90)).toBe(1);
    expect(cardPush(45, 90)).toBeCloseTo(1.03, 6);
    expect(cardPush(90, 90)).toBeCloseTo(1.06, 6);
    // Outside its frames, it holds.
    expect(cardPush(-5, 90)).toBe(1);
    expect(cardPush(120, 90)).toBeCloseTo(1.06, 6);
  });

  it('sets its text in a column narrow enough to stay inside the safe zone at the end of the push', () => {
    // 9x16: the safe zone is 860 px wide; 860 / 1.06 is 811.3.
    expect(cardWidth('9x16')).toBe(811);
    for (const format of ['9x16', '16x9', '4x5'] as const) expect(cardWidth(format) * 1.06).toBeLessThanOrEqual(safeWidth(format));
  });
});
