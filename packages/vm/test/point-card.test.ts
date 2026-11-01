// What a numbered card draws besides its text, as plain math: the number, its size, and how far the series' bar is filled.
import type { SurfaceColors } from '@app/core';
import { describe, expect, it } from 'vitest';
import { numberSize, numberStyle, pointLabel, seriesBar } from '../src/video/pieces/PointCard';

// A dark background with an accent of its own.
const surface: SurfaceColors = { bg: '#16201b', fg: '#ffffff', muted: '#f4f6f2', accent: '#c8743f', button: { bg: '#2e6a50', fg: '#ffffff' } };

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

  it("outlines the number in the accent, filled with the background over the stroke so the font's inner contours do not show", () => {
    // 1.2 % of 360 px is 4 px of outline: the stroke is twice that, its inner half under the fill.
    expect(numberStyle(360, surface)).toEqual({ color: surface.bg, WebkitTextStroke: `8px ${surface.accent}`, paintOrder: 'stroke fill' });
    // Never thinner than 3 px of outline.
    expect(numberStyle(200, surface)).toEqual({ color: surface.bg, WebkitTextStroke: `6px ${surface.accent}`, paintOrder: 'stroke fill' });
  });

  it('fills the bar of the series up to the card on screen, and that card over its scene', () => {
    expect(seriesBar(2, 3, 45, 90)).toEqual([1, 0.5, 0]);
    expect(seriesBar(1, 2, 0, 90)).toEqual([0, 0]);
    expect(seriesBar(3, 3, 120, 90)).toEqual([1, 1, 1]);
  });
});
