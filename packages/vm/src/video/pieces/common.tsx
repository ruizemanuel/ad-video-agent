// What the pieces share: the context of the Ad, easing, the brand's type set and revealed line by line, the logo, the safe
// boxes of each format, and the stage of the UI scenes (a caption over a card with the real UI).
import { createContext, useContext, useMemo, type CSSProperties, type FC, type ReactNode } from 'react';
import { measureText } from '@remotion/layout-utils';
import { AbsoluteFill, Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { alpha, FORMATS, mix, safeWidth, stageLayout, TYPE, type Edl, type FontSpec, type Format, type Scene, type Shot, type SiteData, type Theme, type TimedScene } from '@app/core';
import { brandName, fitLogo, type Size } from '../logo';
import { captionSwapFrame } from '../rhythm';
import { glyphOverhang, hideTravel, layoutCaptions, layoutLines, lineText, maskRoom, ROOM, toWords, type InkMeasure, type Measure, type Room, type TypeLine } from '../type';

/**
 * `logoShown`: the natural size of the site's logo when the video shows it, at the opening and the close alike; null when
 * the video shows the brand's name instead (see videoShowsLogo).
 */
export type AdContext = { theme: Theme; format: Format; site: SiteData; edl: Edl; logoShown: Size | null };
export const Ctx = createContext<AdContext | null>(null);

export const useAd = (): AdContext => {
  const context = useContext(Ctx);
  if (!context) throw new Error('A piece was rendered outside the Ad.');
  return context;
};

export type PieceProps = { scene: Scene; timed: TimedScene; showLogo: boolean };

export const EASE_OUT = Easing.bezier(0.16, 1, 0.3, 1);
export const EASE_IN_OUT = Easing.bezier(0.65, 0, 0.35, 1);

/** 0 to 1 between two frames, eased and held at both ends. */
export const progress = (frame: number, from: number, to: number, easing = EASE_OUT): number =>
  interpolate(frame, [from, Math.max(from + 1, to)], [0, 1], { easing, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

// ---------- type ----------

export const fontStyle = (font: FontSpec): CSSProperties => ({
  fontFamily: font.family,
  fontWeight: font.weight,
  fontStretch: font.stretch,
  letterSpacing: `${font.letterSpacingEm}em`,
  lineHeight: font.lineHeight,
});

/** Measures text in the page, in one of the brand's fonts (the Ad renders nothing until they are loaded). */
export const measureWith =
  (font: FontSpec): Measure =>
  (text) =>
    measureText({
      text,
      fontFamily: font.family,
      fontSize: 100,
      fontWeight: font.weight,
      letterSpacing: `${font.letterSpacingEm}em`,
      additionalStyles: font.stretch ? { fontStretch: font.stretch } : undefined,
      validateFontIsLoaded: true,
    }).width / 100;

// The ink is measured at this size, in px, and given back in em.
const INK_SIZE = 100;
// One canvas measures all the ink; it is made when first needed (never in a page that measures nothing).
let inkContext: CanvasRenderingContext2D | null | undefined;

/**
 * Measures the ink of a text in the page, in one of the brand's fonts (loaded before this is called, as for measureWith): how
 * far its glyphs reach above and below the baseline, which the DOM does not tell and a clip that holds a text has to allow
 * for. The font's `stretch` is not set: a canvas takes keywords for it, not the percentages a width axis is asked for, and
 * how wide a glyph is does not change how far it reaches up or down.
 */
export const inkWith = (font: FontSpec): InkMeasure => {
  inkContext ??= document.createElement('canvas').getContext('2d');
  return (text) => {
    if (inkContext) inkContext.font = `${font.weight} ${INK_SIZE}px ${font.family}`;
    const m = inkContext?.measureText(text);
    return {
      ascent: (m?.actualBoundingBoxAscent ?? 0) / INK_SIZE,
      descent: (m?.actualBoundingBoxDescent ?? 0) / INK_SIZE,
      fontAscent: (m?.fontBoundingBoxAscent ?? 0) / INK_SIZE,
      fontDescent: (m?.fontBoundingBoxDescent ?? 0) / INK_SIZE,
    };
  };
};

/**
 * The room in em that a clip needs above and below the lines of `texts` set in `font` so that none of their ink is cut
 * (at least ROOM, see maskRoom), and how far, in em, a line is lowered to be hidden under it (see hideTravel). Measured
 * again only when the font or the texts change.
 */
export const useInkRoom = (font: FontSpec, texts: readonly string[]): Room & { hide: number } => {
  const key = JSON.stringify(texts);
  return useMemo(() => {
    const inks = texts.map(inkWith(font));
    const room = maskRoom(inks, font.lineHeight, ROOM);
    return { ...room, hide: hideTravel(inks, font.lineHeight, room) };
  }, [font, key]);
};

type LinesProps = { lines: TypeLine[]; size: number; font: FontSpec; color: string; accent: string; align?: 'left' | 'center' };

// The lines of a block are this far apart, in em, beyond their line height: what the room of one clip over the next used
// to leave of their margins (they collapsed to the larger). The layout keeps it, whatever room the clips have.
const LINE_GAP = 0.14;

/**
 * Lines of type, each a probed `[data-qa-line]` in a clip of its own, line i lowered by `drop[i]` (0: in place, 1: hidden
 * under its clip). A clip has room for the ink of the lines of the block above and below its line (see useInkRoom), taken
 * back by negative margins, so that the room never moves the text.
 */
export const TypeLines: FC<LinesProps & { drop?: readonly number[] }> = ({ lines, size, font, color, accent, align = 'left', drop = [] }) => {
  const { above, below, hide } = useInkRoom(font, lines.map(lineText));
  return (
    <div style={{ ...fontStyle(font), fontSize: size, color, whiteSpace: 'nowrap', textAlign: align, display: 'flex', flexDirection: 'column', gap: `${LINE_GAP}em` }}>
      {lines.map((line, i) => (
        <div key={i} style={{ overflow: 'hidden', padding: `${above}em 0 ${below}em`, margin: `${-above}em 0 ${-below}em` }}>
          <div data-qa-line style={{ transform: `translateY(${((drop[i] ?? 0) * hide * 100) / font.lineHeight}%)` }}>
            {line.map((word, j) => (
              <span key={j} style={word.accent ? { color: accent } : undefined}>
                {word.text}
                {j < line.length - 1 ? ' ' : ''}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};

/** Lines revealed by a mask, each rising from below its own clip: line i from frame `starts[i]`, or one after the other from `delay`. */
export const RevealLines: FC<LinesProps & { delay?: number; stagger?: number; starts?: readonly number[] }> = ({ delay = 0, stagger = 5, starts, ...set }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const drop = set.lines.map((_, i) => 1 - spring({ frame: frame - (starts?.[i] ?? delay + i * stagger), fps, config: { damping: 200 }, durationInFrames: 16 }));
  return <TypeLines {...set} drop={drop} />;
};

// ---------- the brand ----------

/**
 * The brand: the site's logo fitted in `box` when the video shows it (decided once per video, see videoShowsLogo), else
 * its name (see brandName) in the site's heading font and brand color, set as large as `name.max` in `name.width`, on up to 2 lines, with room above and
 * below for its glyphs (a mark flush with the edge of the safe zone keeps them inside it). A whole text header marked
 * as the logo would be a sliver in the box, or run off the frame at the box's height.
 */
export const BrandMark: FC<{ box: Size; name: { max: number; width: number }; align: 'left' | 'center'; delay?: number }> = ({ box, name, align, delay = 0 }) => {
  const { site, theme, format, logoShown } = useAd();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const set = useMemo(
    () => layoutLines([toWords({ text: brandName(site), kind: 'framing' })], { width: name.width, max: name.max, min: TYPE[format].min, maxLines: 2, measure: measureWith(theme.display) }),
    [site, name.width, name.max, format, theme],
  );
  const logo = site.brand.logo;
  if (!logo || !logoShown)
    return (
      <div style={{ padding: `${glyphOverhang(theme.display.lineHeight) * set.size}px 0` }}>
        <RevealLines lines={set.lines} size={set.size} font={theme.display} color={theme.accentText} accent={theme.accentText} delay={delay} align={align} />
      </div>
    );
  const p = spring({ frame: frame - delay, fps, config: { damping: 200 }, durationInFrames: 14 });
  return (
    <Img
      src={staticFile(logo.png ?? logo.file)}
      style={{ ...fitLogo(logoShown, box), display: 'block', opacity: p, transform: `scale(${0.96 + 0.04 * p})`, transformOrigin: align === 'center' ? 'center' : 'left center' }}
    />
  );
};

// ---------- layout ----------

type Rect = { left: number; top: number; width: number; height: number };

/** The safe zone of the format, where text may go. */
export const safeBox = (format: Format): Rect & { position: 'absolute' } => {
  const { safe, height } = FORMATS[format];
  return { position: 'absolute', left: safe.left, top: safe.top, width: safeWidth(format), height: height - safe.top - safe.bottom };
};

/**
 * For centered layouts: the wider side of the safe zone on both sides, so centered content sits on the frame's center
 * line and still clears the platform UI.
 */
export const centeredSafeBox = (format: Format): Rect & { position: 'absolute' } => {
  const { safe, width, height } = FORMATS[format];
  const side = Math.max(safe.left, safe.right);
  return { position: 'absolute', left: side, top: safe.top, width: width - 2 * side, height: height - safe.top - safe.bottom };
};

// ---------- the UI stage ----------

/** A shot placed in the card: translated, then scaled from its top-left corner (see placeShot). */
export const ShotImage: FC<{ shot: Shot; placed: { x: number; y: number; scale: number } }> = ({ shot, placed }) => (
  <div
    style={{
      position: 'absolute',
      left: 0,
      top: 0,
      width: shot.width,
      height: shot.height,
      transform: `translate(${placed.x}px, ${placed.y}px) scale(${placed.scale})`,
      transformOrigin: '0 0',
    }}
  >
    <Img src={staticFile(shot.file)} style={{ width: shot.width, height: shot.height, display: 'block' }} />
  </div>
);

// A caption replaced at its atBeat fades into the next one over 6 frames from the beat: the one that goes is out in
// the first 3, the one that comes is in by the 6th, so the two never read on top of each other.
const CAPTION_OUT = 3;
const CAPTION_IN = { from: 1, to: 6 };
// While they fade, the caption that goes rises this share of its size and the one that comes rises into place.
const CAPTION_DRIFT = 0.12;

/**
 * The caption on top, in a block of fixed height so that captions of one or two lines never move the card, and the real
 * UI below it in a large card that rises in and bleeds off the bottom edge. A second line with an atBeat is a caption
 * of its own: it replaces the first on that beat, with a short fade, and both are set at one size.
 */
export const UiStage: FC<{ scene: Scene; timed: TimedScene; shot: Shot; placed: { x: number; y: number; scale: number } }> = ({ scene, timed, shot, placed }) => {
  const { theme, format, edl } = useAd();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const type = TYPE[format];
  const stage = stageLayout(format);
  const { safe } = FORMATS[format];
  // The caption lines up with the card's left edge, never outside the safe zone.
  const captionLeft = Math.max(safe.left, stage.cardLeft);
  const captionWidth = Math.min(safeWidth(format), stage.cardW);
  const swap = captionSwapFrame(scene.lines, timed, edl.bpm);
  const captions = useMemo(() => {
    const fit = {
      width: captionWidth,
      max: type.caption,
      min: type.min,
      maxLines: 2,
      measure: measureWith(theme.display),
      box: { height: stage.captionHeight, lineHeight: theme.display.lineHeight },
    };
    if (swap === undefined) return [layoutLines(scene.lines.map(toWords), fit)];
    const { lines, size } = layoutCaptions([scene.lines.slice(0, 1).map(toWords), scene.lines.slice(1).map(toWords)], fit);
    return lines.map((caption) => ({ lines: caption, size }));
  }, [scene, swap, captionWidth, type, theme, stage.captionHeight]);
  const rise = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 18 });
  const out = swap === undefined ? 0 : progress(frame, swap, swap + CAPTION_OUT);
  const come = swap === undefined ? 0 : progress(frame, swap + CAPTION_IN.from, swap + CAPTION_IN.to);
  const [first, second] = captions;
  const drift = (first?.size ?? 0) * CAPTION_DRIFT;
  const caption = (children: ReactNode, opacity: number, y: number) => (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, opacity, transform: `translateY(${y}px)` }}>{children}</div>
  );
  const text = { font: theme.display, color: theme.fg, accent: theme.accentText };
  return (
    <AbsoluteFill style={{ background: `radial-gradient(120% 70% at 50% 100%, ${mix(theme.bg, theme.primary, 0.1)} 0%, ${theme.bg} 70%)` }}>
      <div style={{ position: 'absolute', left: captionLeft, top: stage.captionTop, width: captionWidth, height: stage.captionHeight }}>
        {/* Each caption is on screen, and probed, only while it can be seen. */}
        {first && out < 1 && caption(<RevealLines lines={first.lines} size={first.size} {...text} delay={2} />, 1 - out, -out * drift)}
        {second && come > 0 && caption(<TypeLines lines={second.lines} size={second.size} {...text} />, come, (1 - come) * drift)}
      </div>
      <div
        style={{
          position: 'absolute',
          left: stage.cardLeft,
          top: stage.cardTop + (1 - rise) * 90,
          width: stage.cardW,
          height: stage.cardH + stage.radius,
          borderRadius: stage.radius,
          overflow: 'hidden',
          background: theme.surface,
          boxShadow: `0 40px 120px ${alpha(theme.primary, 0.18)}, 0 2px 0 ${alpha(theme.fg, 0.04)}`,
          outline: `1px solid ${alpha(theme.fg, 0.08)}`,
          opacity: Math.min(1, rise * 1.6),
        }}
      >
        <ShotImage shot={shot} placed={placed} />
      </div>
    </AbsoluteFill>
  );
};
