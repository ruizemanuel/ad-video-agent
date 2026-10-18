// What the pieces share: the context of the Ad, easing, the brand's type set and revealed line by line, the logo, the safe
// boxes of each format, and the stage of the UI scenes (a caption over a card with the real UI).
import { createContext, useContext, useMemo, type CSSProperties, type FC } from 'react';
import { measureText } from '@remotion/layout-utils';
import { AbsoluteFill, Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { alpha, FORMATS, mix, safeWidth, TYPE, type Edl, type FontSpec, type Format, type Scene, type Shot, type SiteData, type Theme, type TimedScene } from '@app/core';
import { stageLayout } from '../camera';
import { layoutLines, toWords, type Measure, type TypeLine } from '../type';

export type AdContext = { theme: Theme; format: Format; site: SiteData; edl: Edl };
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

/** Lines revealed by a mask, each rising from below its own clip, one after the other. Each is a probed `[data-qa-line]`. */
export const RevealLines: FC<{
  lines: TypeLine[];
  size: number;
  font: FontSpec;
  color: string;
  accent: string;
  delay?: number;
  stagger?: number;
  align?: 'left' | 'center';
}> = ({ lines, size, font, color, accent, delay = 0, stagger = 5, align = 'left' }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div style={{ ...fontStyle(font), fontSize: size, color, whiteSpace: 'nowrap', textAlign: align }}>
      {lines.map((line, i) => {
        const p = spring({ frame: frame - delay - i * stagger, fps, config: { damping: 200 }, durationInFrames: 16 });
        return (
          <div key={i} style={{ overflow: 'hidden', padding: '0.14em 0 0.16em', margin: '-0.14em 0 -0.16em' }}>
            <div data-qa-line style={{ transform: `translateY(${(1 - p) * 110}%)` }}>
              {line.map((word, j) => (
                <span key={j} style={word.accent ? { color: accent } : undefined}>
                  {word.text}
                  {j < line.length - 1 ? ' ' : ''}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
};

// ---------- the brand ----------

/** The site's logo at a fixed height, or fitted in a box when `width` is given. Nothing when the site has none. */
export const Logo: FC<{ height: number; width?: number; delay?: number; align?: 'left' | 'center' }> = ({ height, width, delay = 0, align = 'left' }) => {
  const { site } = useAd();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const logo = site.brand.logo;
  if (!logo) return null;
  const p = spring({ frame: frame - delay, fps, config: { damping: 200 }, durationInFrames: 14 });
  const size: CSSProperties = width
    ? { width, height, objectFit: 'contain', objectPosition: align === 'center' ? 'center' : 'left center' }
    : { height, width: 'auto' };
  return <Img src={staticFile(logo.png ?? logo.file)} style={{ ...size, opacity: p, display: 'block', transform: `scale(${0.96 + 0.04 * p})` }} />;
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

/**
 * The caption on top, in a block of fixed height so that captions of one or two lines never move the card, and the real
 * UI below it in a large card that rises in and bleeds off the bottom edge.
 */
export const UiStage: FC<{ scene: Scene; shot: Shot; placed: { x: number; y: number; scale: number } }> = ({ scene, shot, placed }) => {
  const { theme, format } = useAd();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const type = TYPE[format];
  const stage = stageLayout(format);
  const { safe } = FORMATS[format];
  // The caption lines up with the card's left edge, never outside the safe zone.
  const captionLeft = Math.max(safe.left, stage.cardLeft);
  const captionWidth = Math.min(safeWidth(format), stage.cardW);
  const { lines, size } = useMemo(
    () =>
      layoutLines(scene.lines.map(toWords), {
        width: captionWidth,
        max: type.caption,
        min: type.min,
        maxLines: 2,
        measure: measureWith(theme.display),
        box: { height: stage.captionHeight, lineHeight: theme.display.lineHeight },
      }),
    [scene, captionWidth, type, theme, stage.captionHeight],
  );
  const rise = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 18 });
  return (
    <AbsoluteFill style={{ background: `radial-gradient(120% 70% at 50% 100%, ${mix(theme.bg, theme.primary, 0.1)} 0%, ${theme.bg} 70%)` }}>
      <div
        style={{
          position: 'absolute',
          left: captionLeft,
          top: stage.captionTop,
          width: captionWidth,
          height: stage.captionHeight,
          display: 'flex',
          alignItems: 'flex-end',
        }}
      >
        <RevealLines lines={lines} size={size} font={theme.display} color={theme.fg} accent={theme.accentText} delay={2} />
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
