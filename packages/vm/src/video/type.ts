// The type of the video, as plain math: one size per block of lines, the largest that fits, a step smaller for each line
// past two (the user's hand-made cobrame ads set 1-2 lines at 132 px, 3 at 116 and 4 or more at 98), and long lines
// split at their most balanced space. Widths come from a measure the pieces take in the page, with the font loaded.
import { safeWidth, TYPE, type Format, type Line } from '@app/core';

/** The width of `text` set at 1 px in the font of the block. */
export type Measure = (text: string) => number;
export type Word = { text: string; accent: boolean };
/** A line as it is set: its words, each marked when the accent covers it. */
export type TypeLine = Word[];

// A line may fill this share of its width: the glyphs' overhang needs a hair of room.
const FILL = 0.98;
// How tall the glyphs of a line may be, ascent plus descent, in em: with tight line spacing they reach past the line's box.
const GLYPH_EM = 1.3;

/** How far, in em, the glyphs of a line may reach past its box, above and below, at this line height. */
export const glyphOverhang = (lineHeight: number): number => Math.max(0, GLYPH_EM - lineHeight) / 2;

/**
 * What the page's canvas measures of a text, in em: how far the ink of its glyphs reaches above and below the baseline,
 * and the ascent and descent of the font itself, the content area that CSS centers in a line.
 */
export type Ink = { ascent: number; descent: number; fontAscent: number; fontDescent: number };
/** The ink of `text`, set in the font of the block. */
export type InkMeasure = (text: string) => Ink;

/**
 * How far, in em, the ink of a line reaches past the top and the bottom of its line box at `lineHeight`; 0 where it stays
 * inside. CSS centers the font's ascent and descent in the line box, so the baseline falls (lineHeight + fontAscent -
 * fontDescent) / 2 under its top: a tight line pushes the descenders out of the bottom, and by how much depends on the font.
 */
export const inkOverhang = ({ ascent, descent, fontAscent, fontDescent }: Ink, lineHeight: number): { above: number; below: number } => {
  const baseline = (lineHeight + fontAscent - fontDescent) / 2;
  return { above: Math.max(0, ascent - baseline), below: Math.max(0, descent - (lineHeight - baseline)) };
};

// A hair past the measured ink: the canvas and the layout each round the font's metrics to the pixel their own way.
const INK_MARGIN = 0.03;

/**
 * The room, in em above and below a line, that a mask has to leave around the lines it clips so that none of their ink is
 * cut: the `min` room or, where the ink of one of the texts reaches further past the line at `lineHeight`, that plus a
 * small margin. One room holds every text, so the mask does not change size as they come and go.
 */
export const maskRoom = (inks: readonly Ink[], lineHeight: number, min: { above: number; below: number }): { above: number; below: number } => {
  const over = inks.map((ink) => inkOverhang(ink, lineHeight));
  return {
    above: Math.max(min.above, ...over.map((o) => o.above + INK_MARGIN)),
    below: Math.max(min.below, ...over.map((o) => o.below + INK_MARGIN)),
  };
};

// Below this share of the largest size, the widest line is split in two.
const SPLIT_BELOW = 0.62;

/** The words of a line; those that the accent (a substring of the text) covers, even in part, are marked. */
export const toWords = (line: Line): TypeLine => {
  const at = line.accent ? line.text.indexOf(line.accent) : -1;
  const end = at + (line.accent?.length ?? 0);
  let pos = 0;
  return line.text
    .split(/\s+/)
    .filter(Boolean)
    .map((text) => {
      const start = line.text.indexOf(text, pos);
      pos = start + text.length;
      return { text, accent: at >= 0 && start < end && start + text.length > at };
    });
};

export const lineText = (line: TypeLine): string => line.map((w) => w.text).join(' ');

/**
 * For each line as set (see layoutLines, which only splits lines and leaves out empty ones), the index of the line of
 * `source` it starts in.
 */
export const lineSources = (set: readonly TypeLine[], source: readonly TypeLine[]): number[] => {
  const owner = source.flatMap((line, i) => line.map(() => i));
  let at = 0;
  return set.map((line) => {
    const index = owner[at] ?? 0;
    at += line.length;
    return index;
  });
};

/** One or two lines get the full size, three a step less and four or more another. */
const lineScale = (count: number): number => (count <= 2 ? 1 : count === 3 ? 0.88 : 0.74);

type Fit = {
  width: number;
  max: number;
  min: number;
  measure?: Measure;
  /** A block of fixed height the lines must stay inside, glyphs included, and the line height of their font. */
  box?: { height: number; lineHeight: number };
  /** The share of `max` under which the widest line is split (SPLIT_BELOW unless given). */
  splitBelow?: number;
};

/** The largest size, up to `max` scaled by the line count, at which every line fits `width` and the block its `box`; not floored. */
const fittedSize = (texts: readonly string[], { width, max, measure, box }: Fit): number =>
  Math.min(
    max * lineScale(texts.length),
    ...(measure ? texts.map((t) => (width * FILL) / measure(t)) : []),
    ...(box ? [box.height / (texts.length * box.lineHeight + Math.max(0, GLYPH_EM - box.lineHeight))] : []),
  );

const settle = (size: number, min: number): number => Math.floor(Math.max(size, min));

/**
 * The size of a headline of these lines in `format`: the format's headline size, a step smaller per line past two and,
 * with a measure, no larger than fits the widest line in the safe width. Never below the format's smallest size.
 */
export const fitHeadline = (lines: readonly string[], format: Format, measure?: Measure): number => {
  const { headline, min } = TYPE[format];
  return settle(fittedSize(lines, { width: safeWidth(format), max: headline, min, measure }), min);
};

/**
 * Sets lines at one size: the largest that fits each of them in `width` (see fitHeadline) and, given a `box`, all of them
 * in its height. When that size falls below 62% of `max`, the widest line is split at its most balanced space, never
 * inside a word, up to `maxLines`.
 */
export const layoutLines = (input: readonly TypeLine[], fit: Fit & { measure: Measure; maxLines: number }): { lines: TypeLine[]; size: number } => {
  let lines = input.filter((line) => line.length > 0);
  for (;;) {
    const texts = lines.map(lineText);
    const size = fittedSize(texts, fit);
    const widths = texts.map(fit.measure);
    const widest = lines[widths.indexOf(Math.max(...widths))];
    if (!widest || size >= fit.max * (fit.splitBelow ?? SPLIT_BELOW) || lines.length >= fit.maxLines || widest.length < 2) return { lines, size: settle(size, fit.min) };
    let best = 1;
    let bestDiff = Infinity;
    for (let k = 1; k < widest.length; k++) {
      const diff = Math.abs(lineText(widest.slice(0, k)).length - lineText(widest.slice(k)).length);
      if (diff < bestDiff) [best, bestDiff] = [k, diff];
    }
    const at = lines.indexOf(widest);
    lines = [...lines.slice(0, at), widest.slice(0, best), widest.slice(best), ...lines.slice(at + 1)];
  }
};

/**
 * Captions that replace one another, set at one size (a caption that changes size as it is replaced reads as a jump):
 * the largest that every one of them reaches, each as layoutLines sets it or, when that holds the others down, split
 * further.
 */
export const layoutCaptions = (captions: readonly TypeLine[][], fit: Fit & { measure: Measure; maxLines: number }): { lines: TypeLine[][]; size: number } => {
  const options = captions.map((caption) => ({ own: layoutLines(caption, fit), split: layoutLines(caption, { ...fit, splitBelow: 1 }) }));
  const size = Math.min(...options.map(({ own, split }) => Math.max(own.size, split.size)));
  return { lines: options.map(({ own, split }) => (own.size >= size ? own : split).lines), size };
};

// An address is set on at most this many lines before it is broken inside a name.
const MAX_ADDRESS_LINES = 3;

/** Where an address may break: before a dot, and after a hyphen. */
const addressBreaks = (host: string): number[] => {
  const breaks: number[] = [];
  for (let i = 1; i < host.length; i++) if (host[i] === '.' || host[i - 1] === '-') breaks.push(i);
  return breaks;
};

/** Every way to cut `text` at `breaks` into `count` parts. */
const cutsOf = (text: string, breaks: readonly number[], count: number, from = 0): string[][] => {
  if (count === 1) return [[text.slice(from)]];
  return breaks
    .filter((at) => at > from)
    .flatMap((at) => cutsOf(text, breaks, count - 1, at).map((rest) => [text.slice(from, at), ...rest]));
};

/**
 * A site address set as large as fits `width`, up to `max`: on one line, else broken before a dot or after a hyphen
 * into up to 3 parts, the widest as narrow as it can be, else (a name too long for a line at `min`) in pieces that each
 * fit at `min`. The parts, put back together, are the address: it is always on screen whole.
 */
export const fitAddress = (host: string, width: number, { max, min }: { max: number; min: number }, measure: Measure): { parts: string[]; size: number } => {
  const room = width * FILL;
  const sizeOf = (parts: readonly string[]): number => Math.min(max, ...parts.map((part) => room / measure(part)));
  const breaks = addressBreaks(host);
  for (let count = 1; count <= MAX_ADDRESS_LINES; count++) {
    let best: { parts: string[]; size: number } | undefined;
    for (const parts of cutsOf(host, breaks, count)) {
      const size = sizeOf(parts);
      if (!best || size > best.size) best = { parts, size };
    }
    if (best && best.size >= min) return { parts: best.parts, size: Math.floor(best.size) };
  }
  const parts: string[] = [];
  let part = '';
  for (const char of host) {
    if (part && measure(part + char) * min > room) {
      parts.push(part);
      part = '';
    }
    part += char;
  }
  return { parts: [...parts, part], size: min };
};

/**
 * The size of the call to action in the EndCard's pill: the caption size, or less so that the pill takes at most 96% of
 * the column it is centered in. The room for its padding (1.1 em on each side) is reserved at the caption size. Never
 * below the format's smallest size.
 */
export const pillSize = (text: string, column: number, format: Format, measure: Measure): number => {
  const { caption, min } = TYPE[format];
  return settle(Math.min(caption, (column * 0.96 - 2.2 * caption) / measure(text)), min);
};
