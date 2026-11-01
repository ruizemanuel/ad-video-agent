import { describe, expect, it } from 'vitest';
import { MIN_CONTRAST, alpha, contrast, fontFaces, mix, theme, type SiteData, type SurfaceColors } from '../src/index';
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

describe('surfaces', () => {
  const recolor = (colors: SiteData['brand']['colors']): SiteData => ({ ...site, brand: { ...site.brand, colors } });
  const withPrimary = (hex: string) => recolor(site.brand.colors.map((c) => (c.role === 'primary' ? { ...c, hex } : c)));
  const darkSite = recolor([
    { hex: '#101418', role: 'bg', weight: 0.9 },
    { hex: '#e8ece9', role: 'text', weight: 0.7 },
    { hex: '#0b7a4b', role: 'primary', weight: 0.6 },
  ]);
  const present = (s: ReturnType<typeof theme>['surfaces']) => Object.values(s).filter((surface): surface is SurfaceColors => surface !== null);

  it("keeps base as today's theme", () => {
    const t = theme(site);
    expect(t.surfaces.base).toEqual({ bg: '#f7f7f2', fg: '#1f2a24', muted: t.muted, accent: t.accentText, button: { bg: '#0b7a4b', fg: t.onPrimary } });
  });

  it('takes the darkest site color as the contrast background of a light site', () => {
    const { contrast: dark } = theme(site).surfaces;
    expect(dark.bg).toBe('#1f2a24');
    expect(dark.fg).toBe('#ffffff');
    // The primary reads 2.76:1 on it, so the accent falls to the site's accent color (8.39:1).
    expect(dark.accent).toBe('#f4b942');
  });

  it('puts the brand color behind white text, with an inverted button', () => {
    const { brand } = theme(site).surfaces;
    expect(brand?.bg).toBe('#0b7a4b');
    expect(brand?.fg).toBe('#ffffff'); // 5.39:1
    expect(brand?.button).toEqual({ bg: '#f7f7f2', fg: '#0b7a4b' }); // 5.01:1
  });

  it('keeps every text pair of every surface at 4.5:1 or better', () => {
    for (const s of present(theme(site).surfaces)) {
      expect(contrast(s.fg, s.bg)).toBeGreaterThanOrEqual(MIN_CONTRAST);
      expect(contrast(s.muted, s.bg)).toBeGreaterThanOrEqual(MIN_CONTRAST);
      expect(contrast(s.accent, s.bg)).toBeGreaterThanOrEqual(MIN_CONTRAST);
      expect(contrast(s.button.fg, s.button.bg)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    }
  });

  it('draws every surface from site colors plus white and near-black', () => {
    for (const s of present(theme(site).surfaces))
      for (const color of [s.bg, s.fg, s.muted, s.accent, s.button.bg, s.button.fg]) expect(palette(site)).toContain(color);
  });

  it('drops the brand surface when no text reads on the primary', () => {
    expect(theme(withPrimary('#777777')).surfaces.brand).toBeNull();
  });

  it('drops the brand surface when the primary is too close to the page', () => {
    expect(theme(withPrimary('#f0efe8')).surfaces.brand).toBeNull();
  });

  it('falls back to near-black when the site has no dark color', () => {
    const lightOnly = recolor(site.brand.colors.filter((c) => c.hex !== '#1f2a24'));
    expect(theme(lightOnly).surfaces.contrast.bg).toBe('#111111');
  });

  it('makes the contrast surface light on a dark site', () => {
    const { base, contrast: light } = theme(darkSite).surfaces;
    expect(base.bg).toBe('#101418');
    expect(light.bg).toBe('#e8ece9'); // 15.83:1 on near-black, past the 10 a site color needs
  });

  it('inverts the button of the contrast surface when the primary is the darkest color of the site', () => {
    // Nothing on this site is darker than the primary, so the contrast background IS the primary and a pill
    // painted with it would vanish. Brand is dropped for the same reason, so the contrast surface carries the inversion.
    const navy = recolor([
      { hex: '#f7f7f2', role: 'bg', weight: 0.9 },
      { hex: '#5b655f', role: 'text', weight: 0.2 },
      { hex: '#1f2a24', role: 'primary', weight: 0.6 },
      { hex: '#f4b942', role: 'accent', weight: 0.2 },
    ]);
    const { contrast: dark, brand } = theme(navy).surfaces;
    expect(dark.bg).toBe('#1f2a24');
    expect(brand).toBeNull();
    expect(dark.button).toEqual({ bg: '#f7f7f2', fg: '#1f2a24' }); // the primary reads 13.8:1 on the page
  });

  it('keeps the page text on the brand button when the primary is too dim to read on the page', () => {
    // The primary reads 3.43:1 on this dark page, so it cannot be the pill's text.
    expect(theme(darkSite).surfaces.brand?.button).toEqual({ bg: '#101418', fg: '#e8ece9' });
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
