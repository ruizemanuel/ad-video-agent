import { describe, expect, it } from 'vitest';
import { MIN_CONTRAST, alpha, contrast, fontFaces, mix, theme, type SiteData } from '../src/index';
import siteShop from './fixtures/site-shop.json';

const site = siteShop as SiteData;
const palette = (s: SiteData) => [...s.brand.colors.map((c) => c.hex), '#ffffff', '#111111'];
const colorsOf = (t: ReturnType<typeof theme>) => [t.bg, t.fg, t.muted, t.primary, t.onPrimary, t.accentText, t.surface];

describe('contrast', () => {
  it('contrast of white on black is 21', () => expect(contrast('#ffffff', '#000000')).toBeCloseTo(21));
  it('does not depend on the order of the colors', () => expect(contrast('#0b7a4b', '#f7f7f2')).toBe(contrast('#f7f7f2', '#0b7a4b')));
  it('is 1 between a color and itself', () => expect(contrast('#0b7a4b', '#0b7a4b')).toBe(1));
  it('requires 4.5 for normal text', () => expect(MIN_CONTRAST).toBe(4.5));
});

describe('theme', () => {
  it('uses only site colors plus #ffffff and #111111', () => {
    for (const color of colorsOf(theme(site))) expect(palette(site)).toContain(color);
  });

  it('picks the page background and the strongest text color on it', () => {
    const t = theme(site);
    expect(t.bg).toBe('#f7f7f2');
    expect(t.fg).toBe('#1f2a24');
    expect(t.primary).toBe('#0b7a4b');
  });

  it('keeps every text pair at 4.5:1 or better', () => {
    const t = theme(site);
    expect(contrast(t.fg, t.bg)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    expect(contrast(t.muted, t.bg)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    expect(contrast(t.onPrimary, t.primary)).toBeGreaterThanOrEqual(MIN_CONTRAST);
  });

  it('falls back to white text on near-black when the site has no usable colors', () => {
    const bare = { ...site, brand: { ...site.brand, colors: [] } };
    const t = theme(bare);
    expect([t.bg, t.fg]).toEqual(['#111111', '#ffffff']);
    for (const color of colorsOf(t)) expect(palette(bare)).toContain(color);
  });

  it('registers the site font and reuses it for the body when it is also the body font', () => {
    const t = theme(site);
    expect(t.display).toMatchObject({ family: 'BrandDisplay', weight: 800, letterSpacingEm: -0.03, lineHeight: 0.98 });
    expect(t.body).toMatchObject({ family: 'BrandDisplay', weight: 800, letterSpacingEm: 0 });
  });

  it('uses the open sans fallback when the site font has no files', () => {
    const fonts = site.brand.fonts.map((f) => ({ ...f, files: undefined }));
    const t = theme({ ...site, brand: { ...site.brand, fonts } });
    expect(t.display.family).toMatch(/^Inter,/);
    expect(t.body.family).toMatch(/^Inter,/);
  });

  it('keeps the line height of a heading between 0.94 and 1.12', () => {
    const withLineHeight = (lineHeight: number) =>
      theme({ ...site, brand: { ...site.brand, fonts: site.brand.fonts.map((f) => ({ ...f, lineHeight })) } }).display.lineHeight;
    expect([withLineHeight(0.5), withLineHeight(2)]).toEqual([0.94, 1.12]);
  });
});

describe('fontFaces', () => {
  it('lists the files of the site font under the brand family', () =>
    expect(fontFaces(site)).toEqual([{ family: 'BrandDisplay', file: 'media/fonts/plus-jakarta-sans-400-800.woff2', weight: '400 800', stretch: undefined }]));
});

describe('color helpers', () => {
  it('mixes halfway between two colors', () => expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080'));
  it('writes a color with transparency', () => expect(alpha('#ff0000', 0.5)).toBe('rgba(255, 0, 0, 0.5)'));
});
