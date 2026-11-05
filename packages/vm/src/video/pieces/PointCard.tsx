import { useMemo, type FC } from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { FORMATS, pointLineStart, safeWidth, TYPE, type Format } from '@app/core';
import { layoutSeries, toWords, type Measure, type TypeLine } from '../type';
import { linesHeight, measureWith, RevealLines, useAd, useSurface, type PieceProps } from './common';

// The room over the subline, as a share of the title's size: what the rule that stood between them and its two gaps took.
const SUBLINE_GAP_SHARE = 0.65;
// How far the card pushes in on its text by the end of its scene: once the text is in, the card would otherwise stand
// still for most of it.
const CARD_PUSH = 1.06;

/** The scale of the card's text at `frame` of its scene of `duration` frames: from 1 to CARD_PUSH, evenly, held outside it. */
export const cardPush = (frame: number, duration: number): number => 1 + (CARD_PUSH - 1) * Math.min(1, Math.max(0, frame / duration));

/** The width in px the card sets its text in: the safe zone's, less the push, so that the text stays inside it to the end. */
export const cardWidth = (format: Format): number => Math.floor(safeWidth(format) / CARD_PUSH);

/** The room in px between the title and the subline under it: 65 % of the title's size, rounded. */
export const sublineGap = (title: number): number => Math.round(title * SUBLINE_GAP_SHARE);

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
 * The titles of a series as its cards set them (see layoutSeries), in the card's width (see cardWidth): as large as the
 * format's headline, and each on two lines wherever one line would be set smaller (splitBelow: 1), except a single word;
 * then all at the smallest size any takes.
 */
export const seriesTitles = (texts: readonly (readonly TypeLine[])[], format: Format, measure: Measure): { lines: TypeLine[][]; size: number } =>
  layoutSeries(texts, { width: cardWidth(format), max: TYPE[format].headline, min: TYPE[format].min, maxLines: 2, splitBelow: 1, measure });

// One card of a series (two or three PointCards in a row, see pointSeries): only its text, on its background. The title
// (lines[0]) is in the display font, with its accent; the optional subline (lines[1]) is under it in the body font and the
// secondary color, a beat after the title. Every title of the series is set at one size, up to the format's headline and
// on two lines where one would be set smaller (see seriesTitles), and every subline at another, so the cards read as one
// set; and every card starts its text at one height, where the tallest block of the series stands centered in the safe
// zone (see seriesTop), so its title does not move at the cut to the next card. Over its scene the card pushes in on its
// text, slowly and from the top of it (see cardPush), so that it does not stand still once the text is in. The subline
// stands apart by its font, its size, the room over it and its beat, not by a dimmer color: on the loud backgrounds the
// secondary color can be nearly the text's own.
export const PointCard: FC<PieceProps> = ({ scene, timed, series }) => {
  const { theme, format, edl } = useAd();
  const surface = useSurface();
  const frame = useCurrentFrame();
  const type = TYPE[format];
  // A card without a series (a lone one, which validateEdl refuses) is drawn as a series of one.
  const { at } = series ?? { at: 1 };
  const { title, subline, top } = useMemo(() => {
    const cards = series?.cards ?? [scene];
    const width = cardWidth(format);
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
    const [ownTitle, ownSubline] = [titles.lines[at - 1] ?? [], sublines.lines[at - 1] ?? []];
    return {
      title: { lines: ownTitle, size: titles.size },
      subline: ownSubline.length ? { lines: ownSubline, size: sublines.size } : null,
      top: seriesTop(format, heights),
    };
  }, [scene, series, at, format, type, theme]);
  // On the beat grid of the whole video. Every line of type of the title rises at once, and every one of the subline,
  // so that each is in when textWindows says.
  const starts = { title: pointLineStart(0, timed, edl.bpm), subline: pointLineStart(1, timed, edl.bpm) };
  const { safe } = FORMATS[format];
  const center = type.align === 'center';
  // From the top of the text, at its start: its first line stays where every card of the series starts it.
  const push = cardPush(frame, timed.duration);
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
          alignItems: center ? 'center' : 'flex-start',
          transform: `scale(${push})`,
          transformOrigin: center ? 'center top' : 'left top',
        }}
      >
        <RevealLines lines={title.lines} size={title.size} font={theme.display} color={surface.fg} accent={surface.accent} starts={title.lines.map(() => starts.title)} align={type.align} />
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
