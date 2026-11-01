// What a numbered card draws besides its text, as plain math: the number, its size, and how far the series' bar is filled.
import { describe, expect, it } from 'vitest';
import { numberSize, pointLabel, seriesBar } from '../src/video/pieces/PointCard';

describe('a numbered card', () => {
  it('numbers its card in two digits', () => {
    expect(pointLabel(1)).toBe('01');
    expect(pointLabel(3)).toBe('03');
  });

  it('sets the number at 2.4 times the headline size, or at 30 % of the height of the safe zone where that is less', () => {
    expect(numberSize('9x16')).toBe(360);
    expect(numberSize('16x9')).toBe(288);
    expect(numberSize('4x5')).toBe(307);
  });

  it('fills the bar of the series up to the card on screen, and that card over its scene', () => {
    expect(seriesBar(2, 3, 45, 90)).toEqual([1, 0.5, 0]);
    expect(seriesBar(1, 2, 0, 90)).toEqual([0, 0]);
    expect(seriesBar(3, 3, 120, 90)).toEqual([1, 1, 1]);
  });
});
