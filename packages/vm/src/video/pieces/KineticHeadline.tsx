import { useMemo, type FC } from 'react';
import { AbsoluteFill } from 'remotion';
import { FORMATS, headlineLineStart, safeWidth, TYPE } from '@app/core';
import { layoutLines, lineSources, toWords } from '../type';
import { BrandMark, measureWith, RevealLines, safeBox, useAd, type PieceProps } from './common';

// A line of the edit list split in two as it is set comes in as one, its halves this many frames apart.
const SPLIT_STAGGER = 5;

// One big idea in type: 1-3 lines in the site's display font, the accent in the brand color, line i coming in on beat i
// (sooner when the scene is too short for that). The first scene of a video carries the brand over it: its logo, or its
// name when the logo does not read (see BrandMark).
export const KineticHeadline: FC<PieceProps> = ({ scene, timed, showLogo }) => {
  const { theme, format, edl } = useAd();
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
  const { safe } = FORMATS[format];
  return (
    <AbsoluteFill style={{ background: theme.bg }}>
      {showLogo && (
        <div
          style={{
            position: 'absolute',
            left: safe.left,
            right: safe.right,
            top: safe.top,
            display: 'flex',
            justifyContent: type.align === 'center' ? 'center' : 'flex-start',
          }}
        >
          <BrandMark box={{ width: safeWidth(format), height: type.logo }} name={{ max: Math.round(type.logo * 0.75), width: safeWidth(format) }} align={type.align} />
        </div>
      )}
      <div style={{ ...safeBox(format), display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <RevealLines lines={lines} size={size} font={theme.display} color={theme.fg} accent={theme.accentText} starts={starts} align={type.align} />
      </div>
    </AbsoluteFill>
  );
};
