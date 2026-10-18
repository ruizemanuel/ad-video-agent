import { useMemo, type FC } from 'react';
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { alpha, TYPE } from '@app/core';
import { pillSize } from '../type';
import { centeredSafeBox, fontStyle, Logo, measureWith, useAd, type PieceProps } from './common';

// The close: the logo, the site's own call to action as a button in the brand color, and the domain. Centered on the
// frame's center line, not in the safe zone (which is lopsided in 9:16).
export const EndCard: FC<PieceProps> = ({ scene }) => {
  const { theme, format, site } = useAd();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const type = TYPE[format];
  const cta = scene.lines[0]?.text ?? '';
  const domain = new URL(site.url).hostname.replace(/^www\./, '');
  const column = centeredSafeBox(format);
  const ctaSize = useMemo(() => pillSize(cta, column.width, format, measureWith(theme.display)), [cta, column.width, format, theme]);
  const pill = spring({ frame: frame - 6, fps, config: { damping: 200 }, durationInFrames: 16 });
  const address = spring({ frame: frame - 11, fps, config: { damping: 200 }, durationInFrames: 16 });
  return (
    <AbsoluteFill style={{ background: theme.bg }}>
      <div style={{ ...column, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: type.logo * 0.8 }}>
        <Logo height={Math.round(type.logo * 3.2)} width={Math.round(column.width * 0.7)} align="center" />
        <div
          data-qa-line
          style={{
            ...fontStyle(theme.display),
            fontSize: ctaSize,
            lineHeight: 1,
            color: theme.onPrimary,
            background: theme.primary,
            padding: '0.62em 1.1em',
            borderRadius: 999,
            whiteSpace: 'nowrap',
            boxShadow: `0 24px 60px ${alpha(theme.primary, 0.3)}`,
            opacity: pill,
            transform: `translateY(${(1 - pill) * 40}px)`,
          }}
        >
          {cta}
        </div>
        <div data-qa-line style={{ ...fontStyle(theme.body), fontSize: Math.round(type.caption * 0.62), color: theme.muted, opacity: address }}>
          {domain}
        </div>
      </div>
    </AbsoluteFill>
  );
};
