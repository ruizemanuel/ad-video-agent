import type { FC } from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { WIPE_FRAMES } from '@app/core';
import { EASE_IN_OUT } from './common';

// The brand wipe: a panel in the brand color sweeps across the frame and covers it whole exactly on the cut, WIPE_FRAMES
// long and centered on it. A plain cut needs no component: the scenes simply change on the beat.
export const Wipe: FC<{ color: string }> = ({ color }) => {
  const frame = useCurrentFrame();
  const { width } = useVideoConfig();
  const half = WIPE_FRAMES / 2;
  const options = { easing: EASE_IN_OUT, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
  const x = frame < half ? interpolate(frame, [0, half], [-width, 0], options) : interpolate(frame, [half, WIPE_FRAMES], [0, width], options);
  return <AbsoluteFill style={{ background: color, transform: `translateX(${x}px)` }} />;
};
