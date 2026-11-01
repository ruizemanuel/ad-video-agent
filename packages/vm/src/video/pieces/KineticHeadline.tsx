import { useMemo, type FC } from 'react';
import { AbsoluteFill } from 'remotion';
import { headlineLineStart, safeWidth, TYPE } from '@app/core';
import { layoutLines, lineSources, toWords } from '../type';
import { measureWith, OpeningBrand, RevealLines, safeBox, useAd, useSurface, type PieceProps } from './common';

// A line of the edit list split in two as it is set comes in as one, its halves this many frames apart.
const SPLIT_STAGGER = 5;

// One big idea in type: 1-3 lines in the site's display font on the background of its scene (see sceneSurfaces), the
// accent in that background's accent color, line i coming in on beat i (sooner when the scene is too short for that). The
// first scene of a video carries the brand over it, on the page's own background: its logo, or its name when the logo
// does not read (see BrandMark).
export const KineticHeadline: FC<PieceProps> = ({ scene, timed, showLogo }) => {
  const { theme, format, edl } = useAd();
  const surface = useSurface();
  const type = TYPE[format];
  const source = useMemo(() => scene.lines.map(toWords), [scene]);
  const { lines, size } = useMemo(
    () => layoutLines(source, { width: safeWidth(format), max: type.headline, min: type.min, maxLines: 3, measure: measureWith(theme.display) }),
    [source, format, type, theme],
  );
  const starts = useMemo(() => {
    const sources = lineSources(lines, source);
    return sources.map((s, j) => headlineLineStart(s, timed, edl.bpm, showLogo, (j - sources.indexOf(s)) * SPLIT_STAGGER));
  }, [lines, source, timed, edl.bpm, showLogo]);
  return (
    <AbsoluteFill style={{ background: surface.bg }}>
      {showLogo && <OpeningBrand />}
      <div style={{ ...safeBox(format), display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <RevealLines lines={lines} size={size} font={theme.display} color={surface.fg} accent={surface.accent} starts={starts} align={type.align} />
      </div>
    </AbsoluteFill>
  );
};
