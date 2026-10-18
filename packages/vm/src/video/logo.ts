// Whether the site's logo can close the video, as plain math. The capture keeps a DPR 4 raster of whatever the header
// marks as the logo; some sites mark a whole text header (a strip many times wider than tall) or a small icon. Shown in
// the EndCard's box, the first is a sliver and the second a blur, so the close sets the brand's name instead.
import type { SiteData } from '@app/core';

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
