// Brand theme derived from the site data: colors with guaranteed contrast and the site's fonts.
import type { SiteData, SiteFont } from './site';

type Color = SiteData['brand']['colors'][number];
type Rgb = [number, number, number];

export const MIN_CONTRAST = 4.5; // WCAG AA for normal text
const WHITE = '#ffffff';
const NEAR_BLACK = '#111111';

// Channels in 0..1. Colors are `#rrggbb`.
const rgb = (hex: string): Rgb => {
  const channel = (at: number) => parseInt(hex.slice(at, at + 2), 16) / 255;
  return [channel(1), channel(3), channel(5)];
};

const toHex = (channels: Rgb): string => '#' + channels.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');

const linear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

const luminance = (hex: string): number => {
  const [r, g, b] = rgb(hex);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
};

export const contrast = (a: string, b: string): number => {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

export const mix = (a: string, b: string, t: number): string => {
  const [from, to] = [rgb(a), rgb(b)];
  const at = (i: 0 | 1 | 2) => from[i] + (to[i] - from[i]) * t;
  return toHex([at(0), at(1), at(2)]);
};

export const alpha = (hex: string, a: number): string => {
  const [r, g, b] = rgb(hex);
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
};

const byRole = (colors: Color[], role: Color['role']): string[] =>
  colors.filter((c) => c.role === role).sort((a, b) => b.weight - a.weight).map((c) => c.hex);

// The candidate with the highest contrast on `bg`, if any reaches MIN_CONTRAST.
const strongestOn = (bg: string, candidates: string[]): string | undefined =>
  candidates.filter((c) => contrast(c, bg) >= MIN_CONTRAST).sort((a, b) => contrast(b, bg) - contrast(a, bg))[0];

// Best text color for a given background: brand colors first, then white or near-black.
export const fgOn = (bg: string, candidates: string[]): string =>
  strongestOn(bg, candidates) ?? (contrast(WHITE, bg) >= contrast(NEAR_BLACK, bg) ? WHITE : NEAR_BLACK);

// The brand's main text pair with contrast >= 4.5:1. Prefers the dominant page background and,
// on it, the brand text color with the highest contrast (headings are usually the darkest).
// Falls back to white or near-black text on the primary color.
export const pickTextPair = (colors: Color[]): { fg: string; bg: string } => {
  const fgs = [...byRole(colors, 'text'), ...byRole(colors, 'primary')];
  for (const bg of byRole(colors, 'bg')) {
    const fg = strongestOn(bg, fgs);
    if (fg) return { bg, fg };
  }
  const primary = byRole(colors, 'primary')[0] ?? byRole(colors, 'accent')[0] ?? NEAR_BLACK;
  return { bg: primary, fg: fgOn(primary, []) };
};

export type FontSpec = { family: string; weight: number; stretch?: string; letterSpacingEm: number; lineHeight: number };

export type Theme = {
  bg: string;
  fg: string;
  muted: string; // secondary text, still >= 4.5:1 on bg
  primary: string;
  onPrimary: string;
  accentText: string; // accent words on bg
  surface: string; // card background
  display: FontSpec;
  body: FontSpec;
};

const FALLBACK_FAMILY = 'Inter, "Helvetica Neue", Arial, sans-serif';

const fontSpec = (font: SiteFont | undefined, family: string, fallbackWeight: number): FontSpec => ({
  family: font?.files?.length ? family : FALLBACK_FAMILY,
  weight: Number(font?.weight) || fallbackWeight,
  stretch: font?.stretch,
  letterSpacingEm: font?.letterSpacingEm ?? -0.02,
  lineHeight: Math.min(1.12, Math.max(0.94, font?.lineHeight ?? 1.0)),
});

export const DISPLAY_FAMILY = 'BrandDisplay';
export const BODY_FAMILY = 'BrandBody';

export const theme = (site: SiteData): Theme => {
  const colors = site.brand.colors;
  const { fg, bg } = pickTextPair(colors);
  const texts = byRole(colors, 'text');
  const primary = byRole(colors, 'primary')[0] ?? byRole(colors, 'accent')[0] ?? fg;
  const muted = texts.find((t) => t !== fg && contrast(t, bg) >= MIN_CONTRAST) ?? fg;
  const display = site.brand.fonts.find((f) => f.role === 'display');
  const body = site.brand.fonts.find((f) => f.role === 'body') ?? (display?.alsoBody ? display : undefined);
  const bodySpec = fontSpec(body, body === display ? DISPLAY_FAMILY : BODY_FAMILY, 500);
  return {
    bg,
    fg,
    muted,
    primary,
    onPrimary: fgOn(primary, [bg, ...byRole(colors, 'bg')]),
    accentText: contrast(primary, bg) >= MIN_CONTRAST ? primary : fg,
    surface: byRole(colors, 'bg').find((c) => c !== bg && contrast(c, bg) < 1.3) ?? WHITE,
    display: fontSpec(display, DISPLAY_FAMILY, 700),
    body: { ...bodySpec, stretch: body === display ? undefined : bodySpec.stretch, letterSpacingEm: 0 },
  };
};

// Font files to register, as loadFont() options (urls relative to the public dir).
export const fontFaces = (site: SiteData): { family: string; file: string; weight: string; stretch?: string }[] => {
  const faces = (role: SiteFont['role'], family: string) =>
    (site.brand.fonts.find((f) => f.role === role)?.files ?? []).map(({ file, weight, stretch }) => ({ family, file, weight, stretch }));
  return [...faces('display', DISPLAY_FAMILY), ...faces('body', BODY_FAMILY)];
};
