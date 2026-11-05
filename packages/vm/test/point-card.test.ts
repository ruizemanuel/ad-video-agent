// Where a card of a series sets its text, as plain math: the titles' size, the room over the subline, the height every
// card of the series starts its text at, the hit of its accent and the roll from the card before.
import { describe, expect, it } from 'vitest';
import { accentHit, rollPlacement, seriesTitles, seriesTop, sublineGap } from '../src/video/pieces/PointCard';
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

  it('hits the accent of its title: 110 % on the hit, back to 100 % over 6 frames, evenly, and 100 % before it', () => {
    expect(accentHit(-1)).toBe(1);
    expect(accentHit(0)).toBeCloseTo(1.1, 6);
    expect(accentHit(3)).toBeCloseTo(1.05, 6);
    expect(accentHit(6)).toBe(1);
    expect(accentHit(40)).toBe(1);
  });

  it("rolls the text before out and its title in, each the clip's whole height: the clip holds the taller block and the ink around it", () => {
    expect(rollPlacement(0, { own: 266, old: 400 }, { above: 20, below: 30 })).toEqual({ clip: 450, old: 0, own: 450 });
    expect(rollPlacement(0.5, { own: 266, old: 400 }, { above: 20, below: 30 })).toEqual({ clip: 450, old: -225, own: 225 });
    expect(rollPlacement(1, { own: 266, old: 400 }, { above: 20, below: 30 })).toEqual({ clip: 450, old: -450, own: 0 });
  });

  it('never lets the text that leaves and the title that comes overlap, their ink included, at any point of the roll', () => {
    const ink = { above: 20, below: 30 };
    for (const heights of [{ own: 266, old: 400 }, { own: 400, old: 133 }]) {
      for (let roll = 0; roll <= 1; roll += 0.05) {
        const at = rollPlacement(roll, heights, ink);
        // Each block's ink runs from its place to its height and the ink over and under it past that.
        expect(at.old + heights.old + ink.above + ink.below, `roll ${roll.toFixed(2)}`).toBeLessThanOrEqual(at.own + 1e-9);
      }
    }
  });
});
