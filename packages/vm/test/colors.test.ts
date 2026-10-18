import { describe, expect, it } from 'vitest';
import { pickColors, type RawBrand } from '../src/capture/extract';

// What the page measured on a real shop (cobrame.app): the weights are areas and character counts.
const shop: Pick<RawBrand, 'bg' | 'text' | 'cta' | 'extra'> = {
  bg: [
    ['#fbf7f4', 5826555],
    ['#ffffff', 365498],
    ['#c81e6b', 351229],
  ],
  text: [
    ['#746b65', 958],
    ['#1a1614', 291],
    ['#ffffff', 147],
    ['#c81e6b', 48],
  ],
  cta: [
    ['#c81e6b', 3.577],
    ['#ffffff', 2.029],
  ],
  extra: [
    ['#c81e6b', 2308],
    ['#ff9ec4', 1250],
    ['#f9c6dc', 900],
  ],
};

describe('pickColors', () => {
  it('names the background, the text, the button color and the accents of a page', () => {
    const colors = pickColors(shop, () => {});

    expect(colors.filter((c) => c.role === 'bg').map((c) => c.hex)).toEqual(['#fbf7f4', '#ffffff', '#c81e6b']);
    expect(colors.filter((c) => c.role === 'text').map((c) => c.hex)).toEqual(['#746b65', '#1a1614']);
    expect(colors.find((c) => c.role === 'primary')?.hex).toBe('#c81e6b');
    // Only saturated colors that are not already named are accents.
    expect(colors.filter((c) => c.role === 'accent').map((c) => c.hex)).toEqual(['#ff9ec4', '#f9c6dc']);
  });

  it('gives each color its share of the page', () => {
    const bg = pickColors(shop, () => {}).filter((c) => c.role === 'bg');
    expect(bg[0]?.weight).toBeCloseTo(0.89, 2);
    expect(bg.reduce((sum, c) => sum + c.weight, 0)).toBeCloseTo(1, 2);
  });

  it('drops a background that covers almost nothing, but always keeps the first', () => {
    const colors = pickColors({ ...shop, bg: [['#ffffff', 1000], ['#fafafa', 5]] }, () => {});
    expect(colors.filter((c) => c.role === 'bg').map((c) => c.hex)).toEqual(['#ffffff']);
  });

  it('falls back to the first accent when no button has a color of its own, and says so', () => {
    const notes: string[] = [];
    const colors = pickColors({ ...shop, cta: [] }, (n) => notes.push(n));

    expect(colors.find((c) => c.role === 'primary')).toMatchObject({ hex: '#ff9ec4', weight: 0 });
    expect(notes).toEqual([expect.stringContaining('primary falls back to accent #ff9ec4')]);
  });

  it('does not take the page background for the button color', () => {
    const colors = pickColors({ ...shop, cta: [['#fbf7f4', 5]] }, () => {});
    expect(colors.find((c) => c.role === 'primary')?.hex).not.toBe('#fbf7f4');
  });
});
