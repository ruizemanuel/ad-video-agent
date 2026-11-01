// Whether the site's logo can close the video, as plain math. The capture keeps a DPR 4 raster of whatever the header
// marks as the logo; some sites mark a whole text header (a strip many times wider than tall) or a small icon. Shown in
// the EndCard's box, the first is a sliver and the second a blur, so the video sets the brand's name instead: at the
// close and at the opening alike, decided once per video against the close's box. A logo also has to stand out on the
// backgrounds it appears on: a dark mark on a dark brand color is a smudge, and the name (set in a color that does
// read) is better than that.
import { contrast, FORMATS, layoutScenes, opensWithBrand, sceneSurfaces, TYPE, type Edl, type Format, type SiteData, type Surfaces, type TimedScene } from '@app/core';

export type Size = { width: number; height: number };

// Wider than this, a logo is a strip: fitted to the box it comes out a few pixels tall.
const MAX_ASPECT = 6;
// Enlarged past this, a raster logo goes soft.
const MAX_ENLARGE = 3;

/** The size of a logo fitted in `box`, keeping its proportions. */
export const fitLogo = (natural: Size, box: Size): Size =>
  natural.width / natural.height > box.width / box.height
    ? { width: box.width, height: (natural.height * box.width) / natural.width }
    : { width: (natural.width * box.height) / natural.height, height: box.height };

/** Whether a logo of this natural size (null: none, or one that could not be read) reads in `box`: not a strip, not a blur. */
export const logoReads = (natural: Size | null, box: Size): boolean => {
  if (!natural || natural.width <= 0 || natural.height <= 0) return false;
  if (natural.width / natural.height > MAX_ASPECT) return false;
  return fitLogo(natural, box).width / natural.width <= MAX_ENLARGE;
};

/** The box the EndCard gives the logo: 70% of its centered column wide (see centeredSafeBox), 3.2 times the logo size high. */
export const closeLogoBox = (format: Format): Size => {
  const { width, safe } = FORMATS[format];
  return { width: Math.round((width - 2 * Math.max(safe.left, safe.right)) * 0.7), height: Math.round(TYPE[format].logo * 3.2) };
};

// WCAG 1.4.11 asks 3:1 of a graphic against what is around it, where text needs 4.5:1: a logo is recognized by its shape
// as much as by its color.
export const LOGO_MIN_CONTRAST = 3;
// A pixel at least half opaque (alpha 128 of 255) counts as ink; fainter ones are antialiasing and shadow.
const INK_MIN_ALPHA = 128;

/** The mean color of a logo's ink: the pixels at least half opaque, weighted by their alpha; null when there are none. */
export const averageInk = (rgba: Uint8ClampedArray): string | null => {
  let [red, green, blue, weight] = [0, 0, 0, 0];
  for (let at = 0; at + 3 < rgba.length; at += 4) {
    const alpha = rgba[at + 3] ?? 0;
    if (alpha < INK_MIN_ALPHA) continue;
    red += (rgba[at] ?? 0) * alpha;
    green += (rgba[at + 1] ?? 0) * alpha;
    blue += (rgba[at + 2] ?? 0) * alpha;
    weight += alpha;
  }
  if (weight === 0) return null;
  return '#' + [red, green, blue].map((total) => Math.round(total / weight).toString(16).padStart(2, '0')).join('');
};

/**
 * The ink of the logo in `file` (see averageInk), from the pixels `pixels` reads back from a canvas; null when the canvas
 * refuses (a picture that is not readable back, one without a size), and then the video shows the name, never a failed
 * render. The refusal is logged with the file: a canvas that always refused would hide every logo without a word.
 */
export const measuredInk = (file: string, pixels: () => Uint8ClampedArray): string | null => {
  try {
    return averageInk(pixels());
  } catch (error) {
    console.warn(`The ink of the logo ${file} could not be measured, so the video shows the brand's name: ${String(error)}`);
    return null;
  }
};

/** Whether ink of this color stands out on every one of `backgrounds`; null ink (not measured) never does. */
export const inkReads = (ink: string | null, backgrounds: readonly string[]): boolean =>
  ink !== null && backgrounds.every((bg) => contrast(ink, bg) >= LOGO_MIN_CONTRAST);

/**
 * The backgrounds the logo appears on, from the scenes of one version of the video: the close's and, when the opening
 * is the branded one, the opening's. The versions do not all agree: one hook may open with the brand and another not,
 * so the video asks this of each of them (see videoLogoBackgrounds).
 */
export const logoBackgrounds = (scenes: readonly TimedScene[], surfaces: Surfaces): string[] => {
  const names = sceneSurfaces(scenes, surfaces);
  return scenes.flatMap((timed, i) => {
    const colors = surfaces[names[i] ?? 'base'];
    return colors && (timed.role === 'cta' || opensWithBrand(timed)) ? [colors.bg] : [];
  });
};

/**
 * The backgrounds the logo appears on in any version of the video, each once: those of every hook's version (see
 * logoBackgrounds). The logo is decided once for all of them, so a logo the close of one version shows has to read on the
 * branded opening of another too.
 */
export const videoLogoBackgrounds = (edl: Edl, surfaces: Surfaces): string[] => [
  ...new Set(edl.hooks.flatMap((_, hook) => logoBackgrounds(layoutScenes(edl, hook).scenes, surfaces))),
];

/**
 * Whether the video shows the site's logo, at the opening and the close alike, rather than its name: decided once.
 * Against the close's box, the larger one (a logo that reads there reads at the opening's height too), and against the
 * `backgrounds` it appears on, with the `ink` it was measured to have (null: not measured, so the name).
 */
export const videoShowsLogo = (natural: Size | null, format: Format, ink: string | null, backgrounds: readonly string[]): boolean =>
  logoReads(natural, closeLogoBox(format)) && inkReads(ink, backgrounds);

/** The natural size of the logo as the capture recorded it, or null when it did not. */
export const recordedLogoSize = (logo: SiteData['brand']['logo']): Size | null =>
  logo?.width && logo.height && logo.width > 0 && logo.height > 0 ? { width: logo.width, height: logo.height } : null;

// What separates the parts of a title: bars, dots and dashes, a hyphen only between spaces (not the one in "Coca-Cola"),
// and a colon before a space.
const TITLE_PARTS = /\s*[|·•–—]\s*|\s+-\s+|:\s+/;
// A part of the title longer than this is a sentence, not a name.
const MAX_NAME_WORDS = 3;

const letters = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * The brand's name, for when its logo does not read: the part of the page title that matches a label of the site's
 * address ("Home - Acme" on acme.com), else the first part if it is short enough to be a name ("Tiendita | Sell on
 * WhatsApp"), else the address without "www.".
 */
export const brandName = (site: Pick<SiteData, 'title' | 'url'>): string => {
  const host = new URL(site.url).hostname.replace(/^www\./, '');
  const labels = host.split('.').slice(0, -1).map(letters);
  const parts = site.title.split(TITLE_PARTS).map((part) => part.trim()).filter(Boolean);
  const matching = parts.find((part) => labels.includes(letters(part)));
  if (matching) return matching;
  const first = parts[0];
  return first && first.split(/\s+/).length <= MAX_NAME_WORDS ? first : host;
};
