import { useMemo, type FC } from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { safeWidth, TYPE } from '@app/core';
import { wordEnterFrame } from '../rhythm';
import { layoutLines, lineSources, maskRoom, toWords, type Measure } from '../type';
import { fontStyle, inkWith, measureWith, progress, RevealLines, safeBox, useAd, type PieceProps } from './common';

// A word rolls through the mask over this many frames, from its beat on.
const ROLL = 6;
// How far a word travels through the mask, as a share of its line: past its own line, descenders included.
const TRAVEL = 1.35;
// The least room, in em, the mask leaves above and below the line of a word: for accents above it and descenders below it.
// A word whose ink reaches further past its line gets what it needs (see maskRoom).
const ROOM = { above: 0.14, below: 0.16 };
// In the layout the mask takes its line less this much, as it always has: the text is centered by it and stays where it is.
const SLOT_LESS = 0.16;

// A fixed prefix (lines[0]) and, under it, the word of the beat in the accent color: word k (lines[k + 1]) comes in on
// beat k + 1 (see cycleIndex), rolling up through a mask as the one before rolls out, fading. For short lists of the site.
export const WordCycle: FC<PieceProps> = ({ scene, timed }) => {
  const { theme, format, edl } = useAd();
  const frame = useCurrentFrame();
  const type = TYPE[format];
  const words = scene.lines.slice(1);
  const lineHeight = theme.display.lineHeight;
  const { head, size, room } = useMemo(() => {
    const [prefix, ...list] = scene.lines;
    const measure: Measure = measureWith(theme.display);
    const width = safeWidth(format);
    // The block is the prefix over the widest word: the type system sets it as two lines (three if the prefix splits).
    const widest = list.reduce((a, b) => (measure(b.text) > measure(a.text) ? b : a), list[0] ?? { text: '', kind: 'framing' });
    const source = [prefix ? toWords(prefix) : [], toWords(widest)];
    const set = layoutLines(source, { width, max: type.headline, min: type.min, maxLines: 3, measure });
    const sources = lineSources(set.lines, source);
    // A word never splits: it stays on one line, so it fits the width whole.
    const whole = Math.min(...list.map((w) => (width * 0.98) / measure(w.text)));
    // The mask holds the ink of every word of the cycle, as their font draws it in a line of this height.
    const ink = inkWith(theme.display);
    return {
      head: set.lines.filter((_, i) => sources[i] === 0),
      size: Math.floor(Math.max(type.min, Math.min(set.size, whole))),
      room: maskRoom(list.map((w) => ink(w.text)), lineHeight, ROOM),
    };
  }, [scene, format, type, theme, lineHeight]);
  const enters = words.map((_, k) => wordEnterFrame(k, timed, edl.bpm));
  const box = room.above + lineHeight + room.below;
  return (
    <AbsoluteFill style={{ background: theme.bg }}>
      <div style={{ ...safeBox(format), display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        {/* Over the mask, so that the word rolling out never draws on the prefix's descenders, which hang into it. */}
        <div style={{ position: 'relative', zIndex: 1 }}>
          <RevealLines lines={head} size={size} font={theme.display} color={theme.fg} accent={theme.accentText} align={type.align} />
        </div>
        <div
          style={{
            ...fontStyle(theme.display),
            fontSize: size,
            position: 'relative',
            // The box is the room above, the line and the room below, as border-box counts them (Remotion sets it on every
            // element: a height of the line alone held the room too, and the clip came up short of the line's own foot).
            boxSizing: 'border-box',
            height: `${box}em`,
            overflow: 'hidden',
            // The room above is under the prefix's line, never over it, so that the word rolling out stays off its glyphs.
            padding: `${room.above}em 0 ${room.below}em`,
            margin: `0 0 ${lineHeight - SLOT_LESS - box}em`,
            whiteSpace: 'nowrap',
            textAlign: type.align,
            color: theme.accentText,
          }}
        >
          {words.map((word, k) => {
            const come = progress(frame, enters[k] ?? 0, (enters[k] ?? 0) + ROLL);
            const next = enters[k + 1];
            const go = next === undefined ? 0 : progress(frame, next, next + ROLL);
            // On screen, and probed, only while some of it shows.
            if (come <= 0 || go >= 1) return null;
            return (
              <div
                key={k}
                data-qa-line
                style={{ position: 'absolute', left: 0, right: 0, top: `${room.above}em`, opacity: 1 - go, transform: `translateY(${(1 - come - go) * TRAVEL * 100}%)` }}
              >
                {word.text}
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};
