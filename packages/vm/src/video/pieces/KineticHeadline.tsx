import { useMemo, type FC } from 'react';
import { AbsoluteFill } from 'remotion';
import { FORMATS, safeWidth, settledFrame, TYPE } from '@app/core';
import { lineEnterFrame } from '../rhythm';
import { layoutLines, lineSources, toWords } from '../type';
import { Logo, measureWith, RevealLines, safeBox, useAd, type PieceProps } from './common';

// The first line comes in after the logo of the opening scene.
const AFTER_LOGO = 4;
// A line of the edit list split in two as it is set comes in as one, its halves this many frames apart.
const SPLIT_STAGGER = 5;
// A line is in this many frames after it starts rising: the last one starts no later than that before the settled frame.
const LINE_IN = 12;

// One big idea in type: 1-3 lines in the site's display font, the accent in the brand color, line i coming in on beat i
// (sooner when the scene is too short for that). The first scene of a video carries the logo over it.
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
    const latest = settledFrame(timed) - timed.from - LINE_IN;
    return sources.map((s, j) => {
      const onBeat = Math.max(lineEnterFrame(s, edl.bpm), showLogo ? AFTER_LOGO : 0) + (j - sources.indexOf(s)) * SPLIT_STAGGER;
      return Math.max(0, Math.min(onBeat, latest));
    });
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
          <Logo height={type.logo} />
        </div>
      )}
      <div style={{ ...safeBox(format), display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <RevealLines lines={lines} size={size} font={theme.display} color={theme.fg} accent={theme.accentText} starts={starts} align={type.align} />
      </div>
    </AbsoluteFill>
  );
};
