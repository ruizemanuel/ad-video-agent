// The fonts of a site, as files the video can load. A font that is on Google Fonts is downloaded as the site uses it.
// One that is not (a proprietary one, or a system stack like Helvetica or system-ui) is swapped for the closest open
// family, so the video never falls back to whatever default font the browser has.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FontFile, SiteFont } from '@app/core';
import { describeError, sendWithRetries } from '../api';
import type { FaceKind } from './extract';
import { CHROME_UA } from './page';

export type Generic = 'sans-serif' | 'serif' | 'monospace';

const OPEN_FALLBACK: Record<Generic, string> = { 'sans-serif': 'Inter', serif: 'Source Serif 4', monospace: 'JetBrains Mono' };

/** The open family that stands in for `family`, by the kind of font it is. All three are on Google Fonts. */
export function resolveFontFallback(_family: string, generic: Generic): { family: string; source: 'google' } {
  return { family: OPEN_FALLBACK[generic], source: 'google' };
}

const GENERIC_WORDS: Record<string, Generic> = {
  monospace: 'monospace',
  'ui-monospace': 'monospace',
  serif: 'serif',
  'ui-serif': 'serif',
  'sans-serif': 'sans-serif',
  'ui-sans-serif': 'sans-serif',
  'system-ui': 'sans-serif',
  '-apple-system': 'sans-serif',
  blinkmacsystemfont: 'sans-serif',
  'ui-rounded': 'sans-serif',
};

const MONO_NAME = /\b(mono|monospace|code|courier|consolas|menlo)\b/;
// Serifs by name: the classics, and the commercial faces sites self-host (never on Google Fonts).
const SERIF_NAME = new RegExp(
  `\\b(${[
    ...['serif', 'times', 'georgia', 'garamond', 'palatino', 'didot', 'bodoni', 'caslon', 'baskerville', 'cambria', 'lora', 'merriweather', 'playfair'],
    ...['alpina', 'tiempos', 'canela', 'freight', 'sectra', 'editorial', 'domaine', 'lyon', 'publico', 'chronicle', 'mercury', 'miller'],
    ...['minion', 'sabon', 'bembo', 'plantin', 'perpetua', 'charter', 'iowan', 'hoefler', 'kepler', 'utopia', 'clarendon', 'rockwell'],
    ...['recoleta', 'ogg', 'saol', 'reckless', 'signifier', 'financier', 'roslindale', 'gambarino'],
  ].join('|')})\\b`,
);

/** The generic word of a CSS font stack (the first one there is), or null when it has none. */
const genericWord = (stack: string): Generic | null => {
  for (const name of stack.split(',')) {
    const generic = GENERIC_WORDS[name.trim().replace(/^["']|["']$/g, '').toLowerCase()];
    if (generic) return generic;
  }
  return null;
};

/** The kind of open font that stands in for a family, and why it is of that kind (said in the capture's log). */
export type FallbackKind = { generic: Generic; why: string };

/**
 * The kind of open font that stands in for `family`, the first of `stack` as resolveFont reads it, given what the page
 * measured of the face (see inPageFaceKind; null when it could not tell). In this order:
 * 1. monospace, when the stack's generic word is a monospace one or the family's name says it is one;
 * 2. what the page measured;
 * 3. serif, when the family's name is a serif's and does not say sans;
 * 4. the stack's generic word, else sans-serif.
 * The name comes before the generic word: a stack's last word is not always about its face (Framer ends every stack with
 * sans-serif, serifs included).
 */
export function fallbackKind(stack: string, family: string, measured: FaceKind | null): FallbackKind {
  const generic = genericWord(stack);
  const name = family.toLowerCase();
  if (generic === 'monospace') return { generic, why: 'monospace by the stack' };
  if (MONO_NAME.test(name)) return { generic: 'monospace', why: 'monospace by its name' };
  if (measured) return { generic: measured, why: `measured ${measured}` };
  if (!/\bsans\b/.test(name) && SERIF_NAME.test(name)) return { generic: 'serif', why: 'serif by its name' };
  if (generic) return { generic, why: `${generic} by the stack` };
  return { generic: 'sans-serif', why: 'sans-serif by default' };
}

// Fonts that every system has, or that are the stack of the system itself: they stand for "no font of its own".
const SYSTEM_FONT = /^(system-ui|-apple-system|blinkmacsystemfont|ui-sans-serif|ui-serif|ui-monospace|ui-rounded|sans-serif|serif|monospace|segoe ui|helvetica|helvetica neue|arial)$/i;

const GOOGLE_FILES = 'https://fonts.gstatic.com/';
const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 20_000;
// Google Fonts is asked up to three times (two retries) after a network error or a 5xx, with a short wait that grows.
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;

export type Fetching = {
  fetchImpl?: typeof fetch;
  /** The wait before the second attempt; the third waits twice as long. */
  retryDelayMs?: number;
};

/** One request with a timeout, tried again after a network error or a 5xx. Gives back the last answer, or throws the last network error. */
const ask = (url: string, { fetchImpl = fetch, retryDelayMs = RETRY_DELAY_MS }: Fetching): Promise<Response> =>
  sendWithRetries(url, { headers: { 'user-agent': CHROME_UA } }, { fetchImpl, timeoutMs: DOWNLOAD_TIMEOUT_MS, attempts: ATTEMPTS, retryDelayMs });

/**
 * Saves what is at `url` to `file` and returns its content type. A network error or a 5xx is tried again, and the
 * download fails if it goes on. The errors name the host, not the whole address.
 */
export async function download(url: string, file: string, fetching: Fetching = {}): Promise<string> {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only http and https files can be downloaded.');
  const where = new URL(url).host;
  let response: Response;
  try {
    response = await ask(url, fetching);
  } catch (error) {
    throw new Error(`Download from ${where} failed (${describeError(error)}).`);
  }
  if (!response.ok) throw new Error(`Download from ${where} answered ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error(`Download from ${where} is over ${MAX_DOWNLOAD_BYTES} bytes.`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return response.headers.get('content-type') || '';
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const firstFamily = (stack: string): string => (stack.split(',')[0] || '').trim().replace(/^["']|["']$/g, '');

export type FontSources = { fontFaceSrcs: { family: string; src: string }[]; stylesheets: string[] };
export type FontOptions = {
  /** The run folder: the files go under `media/fonts`. */
  outDir: string;
  /** `font-stretch` of the heading. Anything but 100% asks Google for the width axis too. */
  stretch?: string;
  /** Whether the face has serifs, as the page measured it (see inPageFaceKind): null or absent when it could not tell. */
  measured?: FaceKind | null;
  fetchImpl?: typeof fetch;
  retryDelayMs?: number;
  note?: (text: string) => void;
};

type GoogleFont = { url: string; files: FontFile[] };

/**
 * The stylesheet of a family on Google Fonts, asking for less each time until it accepts, and the latin file(s) it names.
 * Null if Google Fonts does not have the family (a 4xx to every request). It throws if Google Fonts cannot be reached or
 * keeps failing (network error, 5xx, 408, 429): that is an outage, not an answer about the family.
 */
async function fromGoogle(family: string, wide: boolean, outDir: string, fetching: Fetching): Promise<GoogleFont | null> {
  const fam = encodeURIComponent(family).replace(/%20/g, '+');
  const css2 = (axes: string): string => `https://fonts.googleapis.com/css2?family=${fam}${axes}&display=swap`;
  const ladder = [...(wide ? [css2(':wdth,wght@75..125,400..800')] : []), css2(':wght@400..800'), css2(':wght@400;700'), css2('')];
  let found: { url: string; css: string } | undefined;
  for (const url of ladder) {
    let response: Response;
    try {
      response = await ask(url, fetching);
    } catch (error) {
      throw new Error(`Google Fonts could not be reached (${describeError(error)}).`);
    }
    if (response.ok) {
      found = { url, css: await response.text() };
      break;
    }
    await response.body?.cancel();
    if (response.status >= 500 || response.status === 408 || response.status === 429) throw new Error(`Google Fonts is not answering (HTTP ${response.status}).`);
  }
  if (!found) return null;
  // Only the latin subset (it covers Spanish and English).
  const blocks = [...found.css.matchAll(/\/\*\s*latin\s*\*\/\s*@font-face\s*{([^}]*)}/g)].map((m) => m[1] ?? '');
  const files: FontFile[] = [];
  for (const block of blocks) {
    const weight = block.match(/font-weight:\s*([^;]+);/)?.[1]?.trim() || '400';
    const style = block.match(/font-style:\s*([^;]+);/)?.[1]?.trim() || 'normal';
    const stretch = block.match(/font-stretch:\s*([^;]+);/)?.[1]?.trim();
    const src = block.match(/url\(([^)]+)\)/)?.[1];
    if (!src || style !== 'normal' || !src.startsWith(GOOGLE_FILES)) continue;
    // A width-axis file must not share a name with the plain one of the same family (the body font used to overwrite
    // the heading's, and the condensed style was lost).
    const file = `media/fonts/${slug(family)}-${slug(weight)}${stretch && stretch !== '100%' ? '-wdth' : ''}.woff2`;
    await download(src, join(outDir, file), fetching);
    files.push({ file, weight, ...(stretch ? { stretch } : {}) });
  }
  return files.length > 0 ? { url: found.url, files } : null;
}

/**
 * The font a CSS font stack stands for, with its files downloaded. A family that Google Fonts has (with a latin file)
 * is taken as it is. If it has none, or the stack is a system one, the open family of its kind stands in for it (see
 * fallbackKind), and the `note` says so and why. It throws if Google Fonts cannot be reached: a video with a font that
 * is not there is worse than none.
 */
export async function resolveFont(stack: string, role: SiteFont['role'], sources: FontSources, options: FontOptions): Promise<SiteFont> {
  const { outDir, stretch = '100%', measured = null, note = () => {} } = options;
  const fetching: Fetching = { fetchImpl: options.fetchImpl, retryDelayMs: options.retryDelayMs };
  const first = firstFamily(stack);
  let family = first;
  const nextFont = first.match(/^__(.+?)_[0-9a-f]{5,8}$/i); // next/font self-hosting
  if (nextFont?.[1]) family = nextFont[1].replace(/_/g, ' ');
  family = family.replace(/ Variable$/i, '');

  if (family && !SYSTEM_FONT.test(family)) {
    const srcs = sources.fontFaceSrcs
      .filter((f) => f.family.replace(/["']/g, '').includes(first))
      .map((f) => f.src)
      .join(' ');
    const fontsource = /fontsource/i.test(srcs) || sources.stylesheets.some((href) => /fontsource/i.test(href));
    const wide = stretch !== '100%';
    const found = await fromGoogle(family, wide, outDir, fetching);
    if (found) return { family, role, source: fontsource ? 'fontsource' : 'google', url: found.url, files: found.files, ...(wide ? { stretch } : {}) };
    note(`font "${family}" is not on Google Fonts`);
  } else {
    note(`font stack "${stack}" names no font of its own`);
  }

  const kind = fallbackKind(stack, family, measured);
  const fallback = resolveFontFallback(family, kind.generic);
  const found = await fromGoogle(fallback.family, false, outDir, fetching);
  if (!found) throw new Error(`No file could be got for the open font ${fallback.family}.`);
  note(`font "${family || stack}" replaced by ${fallback.family} (${kind.why})`);
  return { family: fallback.family, role, source: fallback.source, url: found.url, files: found.files };
}
