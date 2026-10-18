import { useMemo, type FC } from 'react';
import { AbsoluteFill } from 'remotion';
import { FORMATS, safeWidth, TYPE } from '@app/core';
import { layoutLines, toWords } from '../type';
import { Logo, measureWith, RevealLines, safeBox, useAd, type PieceProps } from './common';

// One big idea in type: 1-3 lines in the site's display font, the accent in the brand color, revealed line by line. The
// first scene of a video carries the logo over it.
export const KineticHeadline: FC<PieceProps> = ({ scene, showLogo }) => {
  const { theme, format } = useAd();
  const type = TYPE[format];
  const { lines, size } = useMemo(
    () => layoutLines(scene.lines.map(toWords), { width: safeWidth(format), max: type.headline, min: type.min, maxLines: 3, measure: measureWith(theme.display) }),
    [scene, format, type, theme],
  );
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
        <RevealLines lines={lines} size={size} font={theme.display} color={theme.fg} accent={theme.accentText} delay={showLogo ? 4 : 0} align={type.align} />
      </div>
    </AbsoluteFill>
  );
};
