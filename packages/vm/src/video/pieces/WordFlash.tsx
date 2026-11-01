import { useMemo, type FC } from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { flashEnterFrame, TYPE, type Format } from '@app/core';
import { layoutSeries, toWords, type Measure, type TypeLine } from '../type';
import { centeredSafeBox, measureWith, OpeningBrand, progress, SurfaceCtx, TypeLines, useAd, useSurface, type PieceProps } from './common';

/** How much a word is scaled on its beat, settling to 1 over FLASH_PUNCH frames: the column fits it at this scale. */
export const FLASH_SCALE = 1.05;
export const FLASH_PUNCH = 4;

// The words are set as large as this many headlines.
const FLASH_HEADLINES = 2;
// When the flash opens the video, the brand takes a band this many logos tall at the top of the column: the mark, and the
// air under it. The words keep as much clear at the bottom, so they stay in the middle of the column.
const BRAND_BAND_LOGOS = 2;

/** The largest size of a WordFlash's words: twice the headline. */
export const flashMax = (format: Format): number => FLASH_HEADLINES * TYPE[format].headline;

/** The scale of a word `since` frames after it came in: FLASH_SCALE on its first frame, 1 from FLASH_PUNCH on, eased (EASE_OUT). */
export const flashScale = (since: number): number => 1 + (FLASH_SCALE - 1) * (1 - progress(since, 0, FLASH_PUNCH));

/** The line of a WordFlash on screen at `frame`: the last whose enter frame has come (0 before the first). */
export const flashIndex = (frame: number, enters: readonly number[]): number => enters.reduce((shown, enter, k) => (frame >= enter ? k : shown), 0);

/**
 * The lines of a WordFlash set as the piece shows them: one size for all, each on one line or a phrase on two (see
 * layoutSeries, with splitBelow: 1), fit to the centered safe column at FLASH_SCALE, and to its height less the brand's band
 * (TYPE.logo × 2) above and as much below when the flash opens the video.
 */
export const flashWords = (
  texts: readonly (readonly TypeLine[])[],
  format: Format,
  opening: boolean,
  lineHeight: number,
  measure: Measure,
): { lines: TypeLine[][]; size: number } => {
  const column = centeredSafeBox(format);
  const band = opening ? BRAND_BAND_LOGOS * TYPE[format].logo : 0;
  return layoutSeries(texts, {
    width: column.width / FLASH_SCALE,
    max: flashMax(format),
    min: TYPE[format].min,
    maxLines: 2,
    splitBelow: 1,
    measure,
    box: { height: column.height - 2 * band, lineHeight },
  });
};

// The site's main line, word by word: each line of the edit list alone in the middle of the centered safe column, in the
// display font, as large as twice the headline and at one size for every line (see flashWords). A line comes in whole on
// its beat (see flashBeats), with a short punch of scale and no entrance that would hold up its reading, and replaces the
// one before. Each line is set on its own background (`wordSurfaces`; the scene's, until the Ad gives them), and a flash
// that opens the video carries the brand over its first line only.
export const WordFlash: FC<PieceProps> = ({ scene, timed, showLogo, wordSurfaces }) => {
  const { theme, format, edl } = useAd();
  const surface = useSurface();
  const frame = useCurrentFrame();
  const { lines, size } = useMemo(
    () => flashWords(scene.lines.map((line) => [toWords(line)]), format, showLogo, theme.display.lineHeight, measureWith(theme.display)),
    [scene, format, showLogo, theme],
  );
  const enters = useMemo(() => scene.lines.map((_, k) => flashEnterFrame(k, timed, edl.bpm)), [scene, timed, edl.bpm]);
  const k = flashIndex(frame, enters);
  const colors = wordSurfaces ?? scene.lines.map(() => surface);
  const on = colors[k] ?? surface;
  return (
    <AbsoluteFill style={{ background: on.bg }}>
      {showLogo && k === 0 && (
        <SurfaceCtx.Provider value={colors[0] ?? surface}>
          <OpeningBrand />
        </SurfaceCtx.Provider>
      )}
      <div style={{ ...centeredSafeBox(format), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {/* Only the line on screen is drawn, and probed. */}
        <div style={{ transform: `scale(${flashScale(frame - (enters[k] ?? 0))})`, transformOrigin: 'center' }}>
          <TypeLines lines={lines[k] ?? []} size={size} font={theme.display} color={on.fg} accent={on.accent} align="center" />
        </div>
      </div>
    </AbsoluteFill>
  );
};
