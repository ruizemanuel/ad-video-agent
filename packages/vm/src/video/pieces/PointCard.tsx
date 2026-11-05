import { useMemo, type FC } from 'react';
import { AbsoluteFill, Easing, useCurrentFrame, useVideoConfig } from 'remotion';
import { FORMATS, pointLineStart, REVEAL_FRAMES, safeWidth, TYPE, type Format } from '@app/core';
import { layoutSeries, lineText, toWords, type Measure, type TypeLine } from '../type';
import { linesHeight, measureWith, progress, RevealLines, revealDrop, TypeLines, useAd, useInkRoom, useSurface, type PieceProps } from './common';
import { FLASH_PUNCH } from './WordFlash';

// The room over the subline, as a share of the title's size: what the rule that stood between them and its two gaps took.
const SUBLINE_GAP_SHARE = 0.65;
// How much the title's accent is scaled on its hit, as the words of the flash are on theirs (see flashScale), but more:
// it is a word in a line, not a line alone.
const ACCENT_HIT = 1.1;

/** The room in px between the title and the subline under it: 65 % of the title's size, rounded. */
export const sublineGap = (title: number): number => Math.round(title * SUBLINE_GAP_SHARE);

/**
 * The scale of the title's accent `since` frames after its hit: 1 before it; ACCENT_HIT on it, settling to 1 over
 * FLASH_PUNCH frames by the same step each frame, as a word of the flash does on its beat.
 */
export const accentHit = (since: number): number => (since < 0 ? 1 : 1 + (ACCENT_HIT - 1) * (1 - progress(since, 0, FLASH_PUNCH, Easing.linear)));

/**
 * Where the two blocks of a roll stand in their clip at `roll` (0: the text before in place, 1: the title), in px from
 * where each rests. The clip holds the taller block and the ink over and under it, and each block travels its whole height
 * (the text before up and out, the title up and in), so they never overlap, their ink included.
 */
export const rollPlacement = (roll: number, heights: { own: number; old: number }, ink: { above: number; below: number }): { clip: number; old: number; own: number } => {
  const clip = Math.max(heights.own, heights.old) + ink.above + ink.below;
  return { clip, old: 0 - roll * clip, own: (1 - roll) * clip };
};

/**
 * Where every card of a series starts its text, in px from the top of the frame: where the tallest of their blocks
 * (`heights`, in px) stands centered in the safe zone, as the words of the flash do; at the top of the zone for a block
 * taller than it.
 */
export const seriesTop = (format: Format, heights: readonly number[]): number => {
  const { safe, height } = FORMATS[format];
  const room = height - safe.top - safe.bottom;
  return safe.top + Math.max(0, Math.round((room - Math.max(...heights)) / 2));
};

/**
 * The titles of a series as its cards set them (see layoutSeries): as large as the format's headline, and each on two lines
 * wherever one line would be set smaller (splitBelow: 1), except a single word; then all at the smallest size any takes.
 */
export const seriesTitles = (texts: readonly (readonly TypeLine[])[], format: Format, measure: Measure): { lines: TypeLine[][]; size: number } =>
  layoutSeries(texts, { width: safeWidth(format), max: TYPE[format].headline, min: TYPE[format].min, maxLines: 2, splitBelow: 1, measure });

type Block = { lines: TypeLine[]; size: number };
type CardText = { title: Block; subline: Block | null };

/**
 * The title of a card after the first, rolling in where the text of the card before (its title and its subline) rolls out:
 * the two as blocks in one clip as wide as the column, placed by rollPlacement. Laid out as the title alone, so the subline
 * comes in under it where it always does. `roll`: 0 the text before in place, 1 the title; the text before is drawn only
 * while `leaving`, so that a still never holds it.
 */
const RollIn: FC<{ title: Block; before: CardText; roll: number; leaving: boolean; accentScale: number }> = ({ title, before, roll, leaving, accentScale }) => {
  const { theme, format } = useAd();
  const surface = useSurface();
  const align = TYPE[format].align;
  const room = useInkRoom(theme.display, [...title.lines, ...before.title.lines].map(lineText));
  const ink = { above: room.above * title.size, below: room.below * title.size };
  const own = linesHeight(title.lines.length, title.size, theme.display.lineHeight);
  const sub = before.subline;
  const old =
    linesHeight(before.title.lines.length, before.title.size, theme.display.lineHeight) +
    (sub ? sublineGap(before.title.size) + linesHeight(sub.lines.length, sub.size, theme.body.lineHeight) : 0);
  const at = rollPlacement(roll, { own, old }, ink);
  const rest = { position: 'absolute' as const, left: 0, right: 0, top: ink.above };
  return (
    <div style={{ position: 'relative', alignSelf: 'stretch', height: own }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: -ink.above, height: at.clip, overflow: 'hidden' }}>
        {leaving && (
          <div style={{ ...rest, transform: `translateY(${at.old}px)` }}>
            <TypeLines lines={before.title.lines} size={before.title.size} font={theme.display} color={surface.fg} accent={surface.accent} align={align} />
            {sub && (
              <div style={{ marginTop: sublineGap(before.title.size) }}>
                <TypeLines lines={sub.lines} size={sub.size} font={theme.body} color={surface.muted} accent={surface.muted} align={align} />
              </div>
            )}
          </div>
        )}
        <div style={{ ...rest, transform: `translateY(${at.own}px)` }}>
          <TypeLines lines={title.lines} size={title.size} font={theme.display} color={surface.fg} accent={surface.accent} align={align} accentScale={accentScale} />
        </div>
      </div>
    </div>
  );
};

// One card of a series (two or three PointCards in a row, see pointSeries): only its text, on its background. The title
// (lines[0]) is in the display font, with its accent; the optional subline (lines[1]) is under it in the body font and the
// secondary color, a beat after the title. Every title of the series is set at one size, up to the format's headline and
// on two lines where one would be set smaller (see seriesTitles), and every subline at another, so the cards read as one
// set; and every card starts its text at one height, where the tallest block of the series stands centered in the safe
// zone (see seriesTop), so its title stands where the one before stood. The title comes in on the cut: on the first card
// it rises into its masks; on the next ones it rolls in as the text before rolls out (see RollIn). On the beat after, its
// accent hits (see accentHit), and then the text stands still. The subline stands apart by its font, its size, the room
// over it and its beat, not by a dimmer color: on the loud backgrounds the secondary color can be nearly the text's own.
export const PointCard: FC<PieceProps> = ({ scene, timed, series }) => {
  const { theme, format, edl } = useAd();
  const surface = useSurface();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const type = TYPE[format];
  // A card without a series (a lone one, which validateEdl refuses) is drawn as a series of one.
  const { at } = series ?? { at: 1 };
  const { title, subline, before, top } = useMemo(() => {
    const cards = series?.cards ?? [scene];
    const width = safeWidth(format);
    // One size for the titles of the series, and one for its sublines, each broken into lines at the size it is drawn at.
    const titles = seriesTitles(
      cards.map((card) => card.lines.slice(0, 1).map(toWords)),
      format,
      measureWith(theme.display),
    );
    const sublines = layoutSeries(
      cards.map((card) => card.lines.slice(1, 2).map(toWords)),
      { width, max: Math.round(type.caption * 0.62), min: type.min, maxLines: 2, measure: measureWith(theme.body) },
    );
    // How tall each card's block is laid out: its title, and its subline with the room over it.
    const heights = titles.lines.map((own, i) => {
      const under = sublines.lines[i] ?? [];
      const sub = under.length ? sublineGap(titles.size) + linesHeight(under.length, sublines.size, theme.body.lineHeight) : 0;
      return linesHeight(own.length, titles.size, theme.display.lineHeight) + sub;
    });
    const textOf = (i: number): CardText => {
      const under = sublines.lines[i] ?? [];
      return { title: { lines: titles.lines[i] ?? [], size: titles.size }, subline: under.length ? { lines: under, size: sublines.size } : null };
    };
    const own = textOf(at - 1);
    return { title: own.title, subline: own.subline, before: at > 1 ? textOf(at - 2) : null, top: seriesTop(format, heights) };
  }, [scene, series, at, format, type, theme]);
  // On the beat grid of the whole video. Every line of type of the title comes in at once, and every one of the subline,
  // so that each is in when textWindows says.
  const starts = { title: pointLineStart(0, timed, edl.bpm), subline: pointLineStart(1, timed, edl.bpm) };
  const hit = accentHit(frame - pointLineStart(1, timed, edl.bpm));
  const { safe } = FORMATS[format];
  return (
    <AbsoluteFill style={{ background: surface.bg }}>
      <div
        style={{
          position: 'absolute',
          left: safe.left,
          top,
          width: safeWidth(format),
          display: 'flex',
          flexDirection: 'column',
          alignItems: type.align === 'center' ? 'center' : 'flex-start',
        }}
      >
        {before ? (
          <RollIn title={title} before={before} roll={1 - revealDrop(frame, starts.title, fps)} leaving={frame < starts.title + REVEAL_FRAMES} accentScale={hit} />
        ) : (
          // As wide as the column, so that the accent's hit is not cut at the end of its line.
          <div style={{ alignSelf: 'stretch' }}>
            <RevealLines lines={title.lines} size={title.size} font={theme.display} color={surface.fg} accent={surface.accent} starts={title.lines.map(() => starts.title)} align={type.align} accentScale={hit} />
          </div>
        )}
        {/* The title's accent is the card's only one: the subline is in the secondary color throughout. */}
        {subline && (
          <div style={{ marginTop: sublineGap(title.size) }}>
            <RevealLines lines={subline.lines} size={subline.size} font={theme.body} color={surface.muted} accent={surface.muted} starts={subline.lines.map(() => starts.subline)} align={type.align} />
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};
