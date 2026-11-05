// What the pieces share: the context of the Ad and the background of their scene, easing, the brand's type set and
// revealed line by line, the logo, the safe boxes of each format, and the stage of the UI scenes (a caption over a card
// with the real UI).
import { createContext, useContext, useMemo, type CSSProperties, type FC, type ReactNode } from 'react';
import { measureText } from '@remotion/layout-utils';
import { AbsoluteFill, Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import {
  alpha,
  CAPTION_DELAY,
  CAPTION_GAP,
  CAPTION_LINE,
  CAPTION_SWAP,
  captionSwapFrame,
  FORMATS,
  mix,
  REVEAL_FRAMES,
  safeWidth,
  stageLayout,
  TYPE,
  type Edl,
  type FontSpec,
  type Format,
  type Scene,
  type Shot,
  type SiteData,
  type Stage,
  type SurfaceColors,
  type Theme,
  type TimedScene,
} from '@app/core';
import { brandName, CHIP_PAD, CHIP_RADIUS, fitLogo, type ShownLogo, type Size } from '../logo';
import { glyphOverhang, hideTravel, layoutCaptions, layoutLines, lineText, maskRoom, ROOM, toWords, type InkMeasure, type Measure, type Room, type TypeLine } from '../type';

/**
 * `logoShown`: the natural size and the ink of the site's logo when the video shows it, at the opening and the close
 * alike; null when the video shows the brand's name instead (see videoShowsLogo).
 */
export type AdContext = { theme: Theme; format: Format; site: SiteData; edl: Edl; logoShown: ShownLogo | null };
export const Ctx = createContext<AdContext | null>(null);

export const useAd = (): AdContext => {
  const context = useContext(Ctx);
  if (!context) throw new Error('A piece was rendered outside the Ad.');
  return context;
};

/**
 * The colors of the background a scene is on (see videoSurfaces): the Ad gives each scene its own. In a WordFlash, whose
 * every word has a background of its own (see PieceProps' `wordSurfaces`), they are those of its first word.
 */
export const SurfaceCtx = createContext<SurfaceColors | null>(null);

/**
 * The colors of the background the piece is on, the ones its text and its button are set in: a piece paints that
 * background itself, as a solid color the probe can read. The UI scenes and the typing are always on `base`, the page's
 * own colors.
 */
export const useSurface = (): SurfaceColors => {
  const surface = useContext(SurfaceCtx);
  if (!surface) throw new Error('A piece was rendered outside the background of its scene.');
  return surface;
};

/** A PointCard's series: its place (`at` of `of`) and every card of it, so the cards share one size of title and of subline. */
export type CardSeries = { at: number; of: number; cards: readonly Scene[] };

/**
 * `series`: the Ad sets it on the PointCards only (see pointSeries). `wordSurfaces`: the colors of each word's background,
 * for a WordFlash; without them, every word is on the scene's.
 */
export type PieceProps = { scene: Scene; timed: TimedScene; showLogo: boolean; series?: CardSeries; wordSurfaces?: readonly SurfaceColors[] };

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
 * How far, in px, the content box of a line of `text` set at `size` in `font` reaches above the line's own box, as the
 * page lays it out: the box the probe measures, the font's ascent and descent as the page rounds them to the pixel,
 * around the line. 0 when it stays inside the line. Measured in the page, once the font is loaded: the canvas's metrics
 * (see inkWith) miss that rounding, by a pixel and a half on one of run 8's captions.
 */
export const contentOverhang = (font: FontSpec, size: number, text: string): number => {
  const line = document.createElement('div');
  Object.assign(line.style, { position: 'absolute', top: '-10000px', whiteSpace: 'pre', fontFamily: font.family, fontWeight: String(font.weight), fontSize: `${size}px`, lineHeight: String(font.lineHeight) });
  if (font.stretch) line.style.fontStretch = font.stretch;
  line.textContent = text;
  document.body.appendChild(line);
  const range = document.createRange();
  range.selectNodeContents(line);
  const above = line.getBoundingClientRect().top - range.getBoundingClientRect().top;
  line.remove();
  return Math.max(0, above);
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

/** `accentScale`: how much the accented words are scaled on a hit, as runs (see ScaledAccent); 1, the default: not at all. */
type LinesProps = { lines: TypeLine[]; size: number; font: FontSpec; color: string; accent: string; align?: 'left' | 'center'; accentScale?: number };

/**
 * The style of a mask that text moves through up or down (a line revealed, a card's roll, a word of a cycle): it clips
 * from above and below, and never at the sides. `clip` keeps the other axis visible, where `hidden` would make it scroll
 * and cut too: the ink a glyph has past the box of its line (the last one of a word set with a tracking below 0, the é of
 * "Vendé" in cobrame's font) is drawn whole.
 */
export const VERTICAL_MASK = { overflowX: 'visible', overflowY: 'clip' } as const;

// The lines of a block are this far apart, in em, beyond their line height: what the room of one clip over the next used
// to leave of their margins (they collapsed to the larger). The layout keeps it, whatever room the clips have.
const LINE_GAP = 0.14;

/** How tall `count` lines set at `size` px are laid out at `lineHeight` (see TypeLines), the gaps between them included. */
export const linesHeight = (count: number, size: number, lineHeight: number): number => (count * lineHeight + Math.max(0, count - 1) * LINE_GAP) * size;

/** The words of a line in runs: each run the words in a row that are all accented, or all not. */
const accentRuns = (line: TypeLine): { accent: boolean; text: string }[] =>
  line.reduce<{ accent: boolean; text: string }[]>((runs, word) => {
    const last = runs.at(-1);
    const accented = word.accent === true;
    if (last && last.accent === accented) last.text += ` ${word.text}`;
    else runs.push({ accent: accented, text: word.text });
    return runs;
  }, []);

/**
 * Where each run of a line stands on an accent's hit, in px from its place at rest: every accented run grows by `scale` from
 * its left, and what follows it moves as far, so that nothing overlaps; a centered line, which grows about its center,
 * moves back half its growth first. `widths`: each run's in px.
 */
export const accentShifts = (widths: readonly number[], accents: readonly boolean[], scale: number, align: 'left' | 'center'): number[] => {
  const grows = widths.map((w, i) => (accents[i] ? (scale - 1) * w : 0));
  let shift = align === 'center' ? -grows.reduce((sum, g) => sum + g, 0) / 2 : 0;
  return grows.map((g) => {
    const at = shift;
    shift += g;
    return at;
  });
};

/**
 * A line on its accent's hit: each run in a box of its own (the space after it stays outside), the accented ones scaled
 * by `scale` from their bottom left, and every run moved by accentShifts. A phrase scales as one, and the line has the
 * room for it (see seriesTitles' growth).
 */
const ScaledAccent: FC<{ line: TypeLine; accent: string; scale: number; align: 'left' | 'center'; font: FontSpec; size: number }> = ({ line, accent, scale, align, font, size }) => {
  const runs = accentRuns(line);
  const measure = measureWith(font);
  const shifts = accentShifts(
    runs.map((run) => measure(run.text) * size),
    runs.map((run) => run.accent),
    scale,
    align,
  );
  return (
    <>
      {runs.map((run, r) => (
        <span key={r} style={run.accent ? { color: accent } : undefined}>
          <span
            style={{
              display: 'inline-block',
              transform: `translateX(${shifts[r] ?? 0}px)${run.accent ? ` scale(${scale})` : ''}`,
              transformOrigin: 'left bottom',
            }}
          >
            {run.text}
          </span>
          {r < runs.length - 1 ? ' ' : ''}
        </span>
      ))}
    </>
  );
};

/**
 * Lines of type, each a probed `[data-qa-line]` in a clip of its own, line i lowered by `drop[i]` (0: in place, 1: hidden
 * under its clip). A clip has room for the ink of the lines of the block above and below its line (see useInkRoom), taken
 * back by negative margins, so that the room never moves the text. It clips from above and below only (VERTICAL_MASK):
 * the line moves up and down, and a tracking below 0 leaves the end of the last glyph's ink past the line's own box.
 */
export const TypeLines: FC<LinesProps & { drop?: readonly number[] }> = ({ lines, size, font, color, accent, align = 'left', drop = [], accentScale = 1 }) => {
  const { above: room, below, hide } = useInkRoom(font, lines.map(lineText));
  // On a hit the accent grows up from its bottom: the clip grows up as far (its padding and margin cancel: nothing moves).
  const above = room + Math.max(0, accentScale - 1);
  return (
    <div style={{ ...fontStyle(font), fontSize: size, color, whiteSpace: 'nowrap', textAlign: align, display: 'flex', flexDirection: 'column', gap: `${LINE_GAP}em` }}>
      {lines.map((line, i) => (
        <div key={i} style={{ ...VERTICAL_MASK, padding: `${above}em 0 ${below}em`, margin: `${-above}em 0 ${-below}em` }}>
          <div data-qa-line style={{ transform: `translateY(${((drop[i] ?? 0) * hide * 100) / font.lineHeight}%)` }}>
            {accentScale === 1 ? (
              line.map((word, j) => (
                <span key={j} style={word.accent ? { color: accent } : undefined}>
                  {word.text}
                  {j < line.length - 1 ? ' ' : ''}
                </span>
              ))
            ) : (
              <ScaledAccent line={line} accent={accent} scale={accentScale} align={align} font={font} size={size} />
            )}
          </div>
        </div>
      ))}
    </div>
  );
};

/** How far a line that starts to rise at `start` is still below its clip at `frame`: 1 hidden, 0 in place REVEAL_FRAMES later. */
export const revealDrop = (frame: number, start: number, fps: number): number =>
  1 - spring({ frame: frame - start, fps, config: { damping: 200 }, durationInFrames: REVEAL_FRAMES });

/** Lines revealed by a mask, each rising from below its own clip: line i from frame `starts[i]`, or one after the other from `delay`. */
export const RevealLines: FC<LinesProps & { delay?: number; stagger?: number; starts?: readonly number[] }> = ({ delay = 0, stagger = 5, starts, ...set }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const drop = set.lines.map((_, i) => revealDrop(frame, starts?.[i] ?? delay + i * stagger, fps));
  return <TypeLines {...set} drop={drop} />;
};

// ---------- the brand ----------

/**
 * The brand: the site's logo fitted in `box` when the video shows it (decided once per video, see videoShowsLogo), else
 * its name (see brandName) in the site's heading font and the accent of the background it is on (the brand color on the
 * page's own), set as large as `name.max` in `name.width`, on up to 2 lines, with room above and below for its glyphs (a
 * mark flush with the edge of the safe zone keeps them inside it). A whole text header marked as the logo would be a
 * sliver in the box, or run off the frame at the box's height. `chip`: the logo sits on a rounded card in the page's
 * color, CHIP_PAD of its height around it, which comes in with it (the close, when its ink does not read there, see
 * closeMark); the card takes room beyond the box.
 */
export const BrandMark: FC<{ box: Size; name: { max: number; width: number }; align: 'left' | 'center'; delay?: number; chip?: boolean }> = ({
  box,
  name,
  align,
  delay = 0,
  chip = false,
}) => {
  const { site, theme, format, logoShown } = useAd();
  const surface = useSurface();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const set = useMemo(() => {
    const { lines, size } = layoutLines([toWords({ text: brandName(site), kind: 'framing' })], {
      width: name.width,
      max: name.max,
      min: TYPE[format].min,
      maxLines: 2,
      measure: measureWith(theme.display),
    });
    const glyphs = glyphOverhang(theme.display.lineHeight) * size;
    // The probe measures the content box of the first line, the font's own ascent and descent, which in some fonts stands
    // taller than the glyphs allowed for (Source Serif 4, about 1.36 em): above, the room is the larger of the two, as for
    // the first line of a caption (see useUiCaptions).
    const above = Math.max(glyphs, Math.ceil(contentOverhang(theme.display, size, lineText(lines[0] ?? []))));
    return { lines, size, padding: `${above}px 0 ${glyphs}px` };
  }, [site, name.width, name.max, format, theme]);
  const logo = site.brand.logo;
  if (!logo || !logoShown)
    return (
      <div style={{ padding: set.padding }}>
        <RevealLines lines={set.lines} size={set.size} font={theme.display} color={surface.accent} accent={surface.accent} delay={delay} align={align} />
      </div>
    );
  const p = spring({ frame: frame - delay, fps, config: { damping: 200 }, durationInFrames: 14 });
  const fitted = fitLogo(logoShown.size, box);
  const pad = Math.round(fitted.height * CHIP_PAD);
  const card = chip ? { background: theme.surfaces.base.bg, padding: pad, borderRadius: Math.round((fitted.height + 2 * pad) * CHIP_RADIUS) } : {};
  return (
    <div style={{ ...card, opacity: p, transform: `scale(${0.96 + 0.04 * p})`, transformOrigin: align === 'center' ? 'center' : 'left center' }}>
      <Img src={staticFile(logo.png ?? logo.file)} style={{ ...fitted, display: 'block' }} />
    </div>
  );
};

/**
 * The brand over the scene that opens the video, at the top of the safe zone: aligned as the format's type (as
 * KineticHeadline has it), or centered over a centered scene (a WordFlash), on the frame's center line as centeredSafeBox
 * has it.
 */
export const OpeningBrand: FC<{ align?: 'left' | 'center' }> = ({ align }) => {
  const { format } = useAd();
  const type = TYPE[format];
  const { safe } = FORMATS[format];
  const set = align ?? type.align;
  const centered = centeredSafeBox(format);
  const sides = set === 'center' ? { left: centered.left, right: FORMATS[format].width - centered.left - centered.width } : { left: safe.left, right: safe.right };
  const width = set === 'center' ? centered.width : safeWidth(format);
  return (
    <div style={{ position: 'absolute', ...sides, top: safe.top, display: 'flex', justifyContent: set === 'center' ? 'center' : 'flex-start' }}>
      <BrandMark box={{ width, height: type.logo }} name={{ max: Math.round(type.logo * 0.75), width }} align={set} />
    </div>
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

// While a caption is replaced (see CAPTION_SWAP), the one that goes rises this share of its size and the one that comes
// rises into place.
const CAPTION_DRIFT = 0.12;

/** How far the caption that goes is out, and the one that comes is in, at `frame` of a scene whose caption is replaced at `swap` (see CAPTION_SWAP). */
export const captionFade = (frame: number, swap: number | undefined): { out: number; come: number } =>
  swap === undefined
    ? { out: 0, come: 0 }
    : { out: progress(frame, swap, swap + CAPTION_SWAP.out), come: progress(frame, swap + CAPTION_SWAP.in.from, swap + CAPTION_SWAP.in.to) };

/** A caption of a UI scene as it is set: its lines, at one size. */
export type CaptionSet = { lines: TypeLine[]; size: number };

/**
 * The top of the card of a UI scene whose captions are `captions` (one, or two that replace one another, at one size:
 * the taller decides), in lines `lineHeight` tall whose content box reaches `overhang` px above the first (see
 * contentOverhang): as high as lets the content box of the first line, with the caption anchored to the bottom of its
 * block (see UiStage), start at the format's caption line (see CAPTION_LINE) or under it, and never lower than today's
 * stage puts it (see stageLayout). Undefined in a format with no caption line: there the card stays where it is.
 */
export const raisedCardTop = (format: Format, captions: readonly CaptionSet[], lineHeight: number, overhang: number): number | undefined => {
  const line = CAPTION_LINE[format];
  if (line === undefined) return undefined;
  const block = Math.max(0, ...captions.map(({ lines, size }) => linesHeight(lines.length, size, lineHeight)));
  return Math.min(stageLayout(format).cardTop, Math.ceil(line + overhang + block + CAPTION_GAP));
};

/** The captions of a UI scene (see UiStage), the frame of the beat the second replaces the first on, and the card top they leave room for (see raisedCardTop). */
export type UiCaptions = { sets: CaptionSet[]; swap: number | undefined; cardTop: number | undefined };

// The caption lines up with the card's left edge, never outside the safe zone.
const captionLeft = (format: Format): number => Math.max(FORMATS[format].safe.left, stageLayout(format).cardLeft);
const captionWidth = (format: Format): number => Math.min(safeWidth(format), stageLayout(format).cardW);

/**
 * The captions of a UI scene, set as UiStage shows them: as large as two lines fit the caption block of today's stage
 * (see stageLayout), whatever card top they then leave room for; the piece films the scene on that card's stage (see
 * raisedMove). The content box of the first line of each caption is measured in the page (see contentOverhang).
 */
export const useUiCaptions = (scene: Scene, timed: TimedScene): UiCaptions => {
  const { theme, format, edl } = useAd();
  const swap = captionSwapFrame(scene.lines, timed, edl.bpm);
  return useMemo(() => {
    const type = TYPE[format];
    const fit = {
      width: captionWidth(format),
      max: type.caption,
      min: type.min,
      maxLines: 2,
      measure: measureWith(theme.display),
      box: { height: stageLayout(format).captionHeight, lineHeight: theme.display.lineHeight },
    };
    let sets: CaptionSet[];
    if (swap === undefined) sets = [layoutLines(scene.lines.map(toWords), fit)];
    else {
      const { lines, size } = layoutCaptions([scene.lines.slice(0, 1).map(toWords), scene.lines.slice(1).map(toWords)], fit);
      sets = lines.map((caption) => ({ lines: caption, size }));
    }
    const overhang = Math.max(0, ...sets.map(({ lines, size }) => contentOverhang(theme.display, size, lineText(lines[0] ?? []))));
    return { sets, swap, cardTop: raisedCardTop(format, sets, theme.display.lineHeight, overhang) };
  }, [scene, swap, format, theme]);
};

/**
 * The caption on top, anchored to the bottom of its block, and the real UI below it in a large card that rises in and
 * bleeds off the bottom edge, on `stage`: today's, whose block holds two lines at the caption size so that captions of
 * one or two lines never move the card, or one whose card has risen into the room a shorter caption leaves (see
 * raisedMove). A second line with an atBeat is a caption of its own: it replaces the first on that beat, with a short
 * fade, and both are set at one size (see useUiCaptions).
 */
export const UiStage: FC<{ captions: UiCaptions; stage: Stage; shot: Shot; placed: { x: number; y: number; scale: number } }> = ({ captions, stage, shot, placed }) => {
  const { theme, format } = useAd();
  const surface = useSurface();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { sets, swap } = captions;
  const rise = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 18 });
  const { out, come } = captionFade(frame, swap);
  const [first, second] = sets;
  const drift = (first?.size ?? 0) * CAPTION_DRIFT;
  const caption = (children: ReactNode, opacity: number, y: number) => (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, opacity, transform: `translateY(${y}px)` }}>{children}</div>
  );
  const text = { font: theme.display, color: surface.fg, accent: surface.accent };
  return (
    <AbsoluteFill style={{ background: `radial-gradient(120% 70% at 50% 100%, ${mix(surface.bg, theme.primary, 0.1)} 0%, ${surface.bg} 70%)` }}>
      <div style={{ position: 'absolute', left: captionLeft(format), top: stage.captionTop, width: captionWidth(format), height: stage.captionHeight }}>
        {/* Each caption is on screen, and probed, only while it can be seen. */}
        {first && out < 1 && caption(<RevealLines lines={first.lines} size={first.size} {...text} delay={CAPTION_DELAY} />, 1 - out, -out * drift)}
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
