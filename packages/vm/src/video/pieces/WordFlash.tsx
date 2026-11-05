import { useMemo, type FC } from 'react';
import { AbsoluteFill, Easing, useCurrentFrame } from 'remotion';
import { firstClear, flashEnterFrame, TYPE, type Format, type TimedScene } from '@app/core';
import { layoutLines, toWords, type Measure, type TypeLine } from '../type';
import { centeredSafeBox, measureWith, OpeningBrand, progress, SurfaceCtx, TypeLines, useAd, useSurface, type PieceProps } from './common';

/** How much a word is scaled on its beat, settling to 1 over FLASH_PUNCH frames: the column fits it at this scale. */
export const FLASH_SCALE = 1.05;
/**
 * The frames a word's punch of scale lasts, by the same step each frame: long enough to be seen (an ease out spent it on
 * the first frame), and over before the still of the word is taken (see BEFORE_CHANGE), 4 frames before the shortest hold
 * of a word (15 frames) ends.
 */
export const FLASH_PUNCH = 6;

// The words are set as large as this many headlines.
const FLASH_HEADLINES = 2;
// When the flash opens the video, the brand takes a band this many logos tall at the top of the column: the mark, and the
// air under it. The words keep as much clear at the bottom, so they stay in the middle of the column.
const BRAND_BAND_LOGOS = 2;

/** The largest size of a WordFlash's words: twice the headline. */
export const flashMax = (format: Format): number => FLASH_HEADLINES * TYPE[format].headline;

/** The scale of a word `since` frames after its punch started: FLASH_SCALE until then, 1 from FLASH_PUNCH on, linear between. */
export const flashScale = (since: number): number => 1 + (FLASH_SCALE - 1) * (1 - progress(since, 0, FLASH_PUNCH, Easing.linear));

/**
 * The frame of the scene each line's punch starts on, given the frames the lines come in on: its own, or for a line that a
 * wipe bringing the scene in still covers, the first frame the wipe leaves clear (see firstClear), so that no punch plays
 * hidden.
 */
export const punchStarts = (enters: readonly number[], timed: TimedScene): number[] => {
  const clear = firstClear(timed);
  return enters.map((enter) => Math.max(enter, clear));
};

/** The line of a WordFlash on screen at `frame`: the last whose enter frame has come (0 before the first). */
export const flashIndex = (frame: number, enters: readonly number[]): number => enters.reduce((shown, enter, k) => (frame >= enter ? k : shown), 0);

/**
 * The lines of a WordFlash set as the piece shows them, each at a size of its own (see layoutLines): as large as it fits
 * the centered safe column, up to flashMax, on one line or, where on one it would be smaller than the headline, a phrase on
 * two (a word alone is never split). Each is fit at FLASH_SCALE, in width and in height, so that its punch stays in the
 * column. The first line of a flash that opens the video, the one the brand is over, fits the column's height less the
 * brand's band (TYPE.logo × 2) above and as much below; the others, its whole height.
 */
export const flashWords = (
  texts: readonly (readonly TypeLine[])[],
  format: Format,
  opening: boolean,
  lineHeight: number,
  measure: Measure,
): { lines: TypeLine[][]; sizes: number[] } => {
  const column = centeredSafeBox(format);
  const type = TYPE[format];
  const band = BRAND_BAND_LOGOS * type.logo;
  const set = texts.map((text, k) =>
    layoutLines(text, {
      width: column.width / FLASH_SCALE,
      max: flashMax(format),
      min: type.min,
      maxLines: 2,
      splitBelow: type.headline / flashMax(format),
      measure,
      box: { height: (column.height - (opening && k === 0 ? 2 * band : 0)) / FLASH_SCALE, lineHeight },
    }),
  );
  return { lines: set.map(({ lines }) => lines), sizes: set.map(({ size }) => size) };
};

// The site's main line, word by word: each line of the edit list alone in the middle of the centered safe column, in the
// display font, each as large as it fits, up to twice the headline (see flashWords). A line comes in whole on its beat (see
// flashBeats), with a short punch of scale and no entrance that would hold up its reading, and replaces the one before.
// Each line is set on its own background (`wordSurfaces`; the scene's, until the Ad gives them), and a flash that opens the
// video carries the brand over its first line only, centered over it.
export const WordFlash: FC<PieceProps> = ({ scene, timed, showLogo, wordSurfaces }) => {
  const { theme, format, edl } = useAd();
  const surface = useSurface();
  const frame = useCurrentFrame();
  const { lines, sizes } = useMemo(
    () => flashWords(scene.lines.map((line) => [toWords(line)]), format, showLogo, theme.display.lineHeight, measureWith(theme.display)),
    [scene, format, showLogo, theme],
  );
  const enters = useMemo(() => scene.lines.map((_, k) => flashEnterFrame(k, timed, edl.bpm)), [scene, timed, edl.bpm]);
  const punches = useMemo(() => punchStarts(enters, timed), [enters, timed]);
  const k = flashIndex(frame, enters);
  const colors = wordSurfaces ?? scene.lines.map(() => surface);
  const on = colors[k] ?? surface;
  return (
    <AbsoluteFill style={{ background: on.bg }}>
      {showLogo && k === 0 && (
        <SurfaceCtx.Provider value={colors[0] ?? surface}>
          <OpeningBrand align="center" />
        </SurfaceCtx.Provider>
      )}
      <div style={{ ...centeredSafeBox(format), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {/* Only the line on screen is drawn, and probed. */}
        <div style={{ transform: `scale(${flashScale(frame - (punches[k] ?? 0))})`, transformOrigin: 'center' }}>
          <TypeLines lines={lines[k] ?? []} size={sizes[k] ?? TYPE[format].min} font={theme.display} color={on.fg} accent={on.accent} align="center" />
        </div>
      </div>
    </AbsoluteFill>
  );
};
