import { useMemo, type CSSProperties, type FC } from 'react';
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { alpha, pointLineStart, REVEAL_FRAMES, safeWidth, TYPE, type Format, type SurfaceColors } from '@app/core';
import { layoutSeries, toWords, type Measure, type TypeLine } from '../type';
import { fontStyle, measureWith, progress, RevealLines, safeBox, useAd, useSurface, type PieceProps } from './common';

// The number stands this many headline sizes tall, but never more than this share of the safe zone's height: in a wide
// frame it would leave the title no room.
const NUMBER_HEADLINES = 2.4;
const NUMBER_SHARE = 0.3;
// The card's text starts this share of the number's size under the number.
const NUMBER_GAP = 0.2;
// The segments of the series' bar are this many px apart.
export const BAR_GAP = 12;
// The title, the rule and the subline are this share of the title's size apart; the rule is this share of it thick, and
// never thinner than 4 px.
const GAP_SHARE = 0.3;
const RULE_SHARE = 0.05;
const textGap = (title: number): number => Math.round(title * GAP_SHARE);
const ruleHeight = (title: number): number => Math.max(4, Math.round(title * RULE_SHARE));

/** The number of card `at`: two digits. */
export const pointLabel = (at: number): string => String(at).padStart(2, '0');

/** The number's font size in px: min(TYPE.headline × 2.4, 30 % of the safe zone's height), rounded. */
export const numberSize = (format: Format): number => Math.round(Math.min(TYPE[format].headline * NUMBER_HEADLINES, safeBox(format).height * NUMBER_SHARE));

/** The room in px between the number's box and the card's text under it: 20 % of the number's size, rounded. */
export const numberGap = (format: Format): number => Math.round(numberSize(format) * NUMBER_GAP);

/**
 * How the number is painted: in outline, in the accent of its background, `max(3, 1.2 % of size)` px wide. A stroke over a
 * transparent fill would draw every contour of the glyph, and a font's glyphs keep contours that overlap inside them (the
 * stem of Source Serif 4's "1" runs through its foot, its "2" and "3" show spurs): so the stroke is twice as wide and the
 * background's own color is painted over it, which covers the stroke's inner half and every contour inside the glyph.
 */
export const numberStyle = (size: number, surface: SurfaceColors): CSSProperties => ({
  color: surface.bg,
  WebkitTextStroke: `${2 * Math.max(3, Math.round(size * 0.012))}px ${surface.accent}`,
  paintOrder: 'stroke fill',
});

/** The height of the series' bar in px: 18 % of the format's smallest type, never under 6. */
export const barHeight = (format: Format): number => Math.max(6, Math.round(TYPE[format].min * 0.18));

/**
 * The titles of a series as its cards set them (see layoutSeries): as large as the format's headline, and each on two lines
 * wherever one line would be set smaller (splitBelow: 1), except a single word; then all at the smallest size any takes.
 */
export const seriesTitles = (texts: readonly (readonly TypeLine[])[], format: Format, measure: Measure): { lines: TypeLine[][]; size: number } =>
  layoutSeries(texts, { width: safeWidth(format), max: TYPE[format].headline, min: TYPE[format].min, maxLines: 2, splitBelow: 1, measure });

/** How full each segment of the series' bar is at `frame` of card `at`: the cards before it full, its own from 0 to 1 over the scene, the rest empty. */
export const seriesBar = (at: number, of: number, frame: number, duration: number): number[] =>
  Array.from({ length: of }, (_, i) => (i + 1 < at ? 1 : i + 1 > at ? 0 : Math.min(1, Math.max(0, frame / duration))));

// One card of a numbered series (two or three PointCards in a row, see pointSeries), filling the safe column from top to
// bottom: at the top, its number, large and in outline in the accent of its background; right under it, its title
// (lines[0]) in the display font, a rule, and the optional subline (lines[1]) in the body font and the secondary color, a
// beat after the title; at the bottom, the series' bar, filled up to this card and through it as the scene plays, the air
// of the card left above it. Every title of the series is set at one size, up to the format's headline and on two lines
// where one would be set smaller (see seriesTitles), and every subline at another, so the cards read as one set; and
// every card's text starts the same gap under its number, so its title does not move at the cut to the next card. The
// subline stands apart by its font, its size and the rule over it, not by a dimmer color: on the loud backgrounds the
// secondary color can be nearly the text's own.
export const PointCard: FC<PieceProps> = ({ scene, timed, series }) => {
  const { theme, format, edl } = useAd();
  const surface = useSurface();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const type = TYPE[format];
  // A card without a series (a lone one, which validateEdl refuses) is drawn as a series of one.
  const { at, of } = series ?? { at: 1, of: 1 };
  const { title, subline } = useMemo(() => {
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
    const [ownTitle, ownSubline] = [titles.lines[at - 1] ?? [], sublines.lines[at - 1] ?? []];
    return {
      title: { lines: ownTitle, size: titles.size },
      subline: ownSubline.length ? { lines: ownSubline, size: sublines.size } : null,
    };
  }, [scene, series, at, format, type, theme]);
  // On the beat grid of the whole video. Every line of type of the title rises at once, and every one of the subline,
  // so that each is in when textWindows says.
  const starts = { title: pointLineStart(0, timed, edl.bpm), subline: pointLineStart(1, timed, edl.bpm) };
  const ruleFrom = subline ? starts.subline : starts.title;
  const ruleIn = progress(frame, ruleFrom, ruleFrom + REVEAL_FRAMES);
  // The number comes in as the logo of the brand does (see BrandMark).
  const numberIn = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 14 });
  const size = numberSize(format);
  const center = type.align === 'center';
  const items = center ? 'center' : 'flex-start';
  return (
    <AbsoluteFill style={{ background: surface.bg }}>
      <div style={{ ...safeBox(format), display: 'flex', flexDirection: 'column', alignItems: items }}>
        {/* Not a text of the edit list, so not probed: its fill is the background's own color, which the contrast check would read as none. */}
        <div
          style={{
            ...fontStyle(theme.display),
            ...numberStyle(size, surface),
            fontSize: size,
            lineHeight: 1,
            whiteSpace: 'nowrap',
            opacity: numberIn,
            transform: `scale(${0.96 + 0.04 * numberIn})`,
            transformOrigin: center ? 'center' : 'left center',
          }}
        >
          {pointLabel(at)}
        </div>
        <div style={{ flex: 1, alignSelf: 'stretch', display: 'flex', flexDirection: 'column', paddingTop: numberGap(format) }}>
          {/* The card's text, anchored at the top numberGap under the number: the title stands at one height on every card, whatever each one holds. */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: items, gap: textGap(title.size) }}>
            <RevealLines lines={title.lines} size={title.size} font={theme.display} color={surface.fg} accent={surface.accent} starts={title.lines.map(() => starts.title)} align={type.align} />
            <div
              style={{
                width: Math.round(safeWidth(format) * 0.16),
                height: ruleHeight(title.size),
                background: surface.accent,
                transform: `scaleX(${ruleIn})`,
                transformOrigin: center ? 'center' : 'left',
              }}
            />
            {/* The title's accent is the card's only one: the subline is in the secondary color throughout. */}
            {subline && (
              <RevealLines lines={subline.lines} size={subline.size} font={theme.body} color={surface.muted} accent={surface.muted} starts={subline.lines.map(() => starts.subline)} align={type.align} />
            )}
          </div>
        </div>
        <div style={{ alignSelf: 'stretch', display: 'flex', gap: BAR_GAP, height: barHeight(format) }}>
          {seriesBar(at, of, frame, timed.duration).map((fill, i) => (
            <div key={i} style={{ flex: 1, background: alpha(surface.fg, 0.18) }}>
              <div style={{ width: `${fill * 100}%`, height: '100%', background: surface.accent }} />
            </div>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};
