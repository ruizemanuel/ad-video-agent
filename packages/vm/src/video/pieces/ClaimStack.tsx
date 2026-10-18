import { useMemo, type FC } from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { beatsToFrames, safeWidth, TYPE } from '@app/core';
import { layoutLines, toWords } from '../type';
import { measureWith, RevealLines, safeBox, useAd, type PieceProps } from './common';

// 2-3 short claims landing one by one on the beat, spread evenly over the scene, building a stack. Earlier claims keep
// their full strength: dimming them demoted the first claim, usually the strongest, and cost contrast.
export const ClaimStack: FC<PieceProps> = ({ scene, timed }) => {
  const { theme, format, edl } = useAd();
  const frame = useCurrentFrame();
  const type = TYPE[format];
  const groups = useMemo(() => {
    const measure = measureWith(theme.display);
    const laid = scene.lines.map((line) =>
      layoutLines([toWords(line)], { width: safeWidth(format), max: Math.round(type.headline * 0.7), min: type.min, maxLines: 2, measure }),
    );
    // One size for the whole stack: the smallest any claim needs.
    const size = Math.min(...laid.map((g) => g.size));
    return laid.map((g) => ({ lines: g.lines, size }));
  }, [scene, format, type, theme]);
  const spacing = Math.max(1, Math.floor(scene.beats / scene.lines.length));
  // On the beat grid of the whole video, so that each claim lands on the pulse.
  const starts = groups.map((_, i) => beatsToFrames(timed.startBeat + i * spacing, edl.bpm) - timed.from);
  return (
    <AbsoluteFill style={{ background: theme.bg }}>
      <div style={{ ...safeBox(format), display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: (groups[0]?.size ?? 0) * 0.32 }}>
        {groups.map((group, i) => {
          const start = starts[i] ?? 0;
          // A claim yet to land keeps its place, so the stack does not shift as it grows.
          return frame >= start - 1 ? (
            <RevealLines
              key={i}
              lines={group.lines}
              size={group.size}
              font={theme.display}
              color={theme.fg}
              accent={theme.accentText}
              delay={start}
              align={type.align}
            />
          ) : (
            <div key={i} style={{ height: group.size * theme.display.lineHeight * group.lines.length }} />
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
