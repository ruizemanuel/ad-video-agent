import { useMemo, type FC } from 'react';
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { alpha, contrast, FORMATS, MIN_CONTRAST, mix, safeWidth, TYPE, type Format } from '@app/core';
import { pressState, typedChars, TYPED_BY, typeInPressFrame } from '../rhythm';
import { layoutLines, lineText, toWords } from '../type';
import { centeredSafeBox, fontStyle, measureWith, progress, useAd, type PieceProps } from './common';

// The widest the bar gets: across a whole 16:9 frame it reads as a banner, not as a field.
const MAX_BAR = 1200;
// The lines of a field are set looser than a headline.
const FIELD_LINE = 1.3;
// Once the typing is done the caret blinks, on and off this many frames each, as a text field's does.
const BLINK = 16;

/** The measures of the bar, in proportion to one unit per format (80 px in 9:16): its padding, its button, their gaps. */
const barUnits = (format: Format) => {
  const unit = Math.round(TYPE[format].caption * 0.8);
  return { unit, padX: Math.round(unit * 0.62), padY: Math.round(unit * 0.4), button: Math.round(unit * 1.6), inset: Math.round(unit * 0.2), gap: Math.round(unit * 0.4) };
};

/** The characters of each line as typed so far, and the line the caret is in. */
const typedLines = (texts: readonly string[], typed: number): { shown: string[]; caretLine: number } => {
  let left = typed;
  let caretLine = -1;
  const shown = texts.map((text, i) => {
    const chars = [...text];
    if (caretLine < 0 && left <= chars.length) caretLine = i;
    const part = chars.slice(0, Math.max(0, Math.min(chars.length, left))).join('');
    // The space that joins this line to the next one is typed too.
    left -= chars.length + 1;
    return part;
  });
  return { shown, caretLine: caretLine < 0 ? texts.length - 1 : caretLine };
};

const Arrow: FC<{ up: boolean; size: number; color: string }> = ({ up, size, color }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
    <path d={up ? 'M12 19V5M5.5 11.5 12 5l6.5 6.5' : 'M5 12h14M12.5 5.5 19 12l-6.5 6.5'} />
  </svg>
);

// A field in the site's type where its address (variant "url") or a question (variant "prompt") is typed, ending on a
// button in the brand color that is pressed (spec 6.5): "this is a website" in two seconds, then the cut to the product.
// The typing is done at 60% of the scene, and the button, lit up once the text is in, is pressed on the half beat
// nearest 75% of it.
export const TypeIn: FC<PieceProps> = ({ scene, timed }) => {
  const { theme, format, edl } = useAd();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const units = useMemo(() => barUnits(format), [format]);
  const prompt = scene.variant === 'prompt';
  const bar = useMemo(() => {
    const measure = measureWith(theme.body);
    const column = centeredSafeBox(format);
    const source = scene.lines[0] ? [toWords(scene.lines[0])] : [];
    const setIn = (width: number) => {
      const textWidth = width - units.padX - units.gap - units.button - units.inset;
      const set = layoutLines(source, { width: textWidth, max: units.unit, min: TYPE[format].min, maxLines: prompt ? 3 : 1, measure });
      return { width, overflows: set.lines.some((line) => set.size * measure(lineText(line)) > textWidth), texts: set.lines.map(lineText), size: set.size };
    };
    // Centered on the frame, like the close; an address too long for it at the smallest size takes the whole safe width.
    const centered = setIn(Math.min(column.width, MAX_BAR));
    const fitted = centered.overflows ? { ...setIn(safeWidth(format)), left: FORMATS[format].safe.left } : { ...centered, left: column.left + (column.width - centered.width) / 2 };
    const height = Math.max(units.button + 2 * units.inset, fitted.texts.length * fitted.size * FIELD_LINE + 2 * units.padY);
    return { ...fitted, height, top: column.top + (column.height - height) / 2 };
  }, [scene, prompt, format, units, theme]);

  const typingEnd = timed.duration * TYPED_BY;
  const pressAt = typeInPressFrame(timed, edl.bpm);
  const { shown, caretLine } = typedLines(bar.texts, typedChars(bar.texts.join(' '), frame, timed.duration));
  const caretOn = frame < pressAt && (frame < typingEnd || Math.floor((frame - typingEnd) / BLINK) % 2 === 0);
  const enter = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 16 });
  // The button lights up once the text is in, then it is pressed.
  const ready = progress(frame, typingEnd, typingEnd + 6);
  const press = pressState(frame, pressAt);
  const field = contrast(theme.fg, theme.surface) >= MIN_CONTRAST ? theme.surface : theme.bg;
  const { unit, button, inset, padX, gap } = units;
  return (
    <AbsoluteFill style={{ background: `radial-gradient(120% 70% at 50% 100%, ${mix(theme.bg, theme.primary, 0.1)} 0%, ${theme.bg} 70%)` }}>
      <div
        style={{
          position: 'absolute',
          left: bar.left,
          top: bar.top,
          width: bar.width,
          height: bar.height,
          borderRadius: bar.texts.length > 1 ? Math.round(unit * 0.9) : bar.height / 2,
          background: field,
          outline: `2px solid ${alpha(theme.primary, 0.5)}`,
          boxShadow: `0 0 0 ${Math.round(unit * 0.1)}px ${alpha(theme.primary, 0.12)}, 0 ${Math.round(unit * 0.5)}px ${Math.round(unit * 1.4)}px ${alpha(theme.primary, 0.16)}`,
          opacity: enter,
          transform: `translateY(${(1 - enter) * unit * 0.5}px) scale(${0.98 + 0.02 * enter})`,
        }}
      >
        <div
          style={{
            ...fontStyle(theme.body),
            fontSize: bar.size,
            color: theme.fg,
            position: 'absolute',
            left: padX,
            right: inset + button + gap,
            top: 0,
            bottom: 0,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
          }}
        >
          {bar.texts.map((_, i) => (
            <div key={i} style={{ height: bar.size * FIELD_LINE, display: 'flex', alignItems: 'center', whiteSpace: 'pre' }}>
              {/* Probed only once some of it is typed: an empty line has no box to measure. */}
              {shown[i] ? <span data-qa-line>{shown[i]}</span> : null}
              {caretOn && caretLine === i && (
                <span
                  style={{
                    display: 'inline-block',
                    width: Math.max(3, Math.round(bar.size * 0.06)),
                    height: bar.size * 1.08,
                    marginLeft: shown[i] ? Math.round(bar.size * 0.05) : 0,
                    borderRadius: 2,
                    background: theme.primary,
                  }}
                />
              )}
            </div>
          ))}
        </div>
        <div
          style={{
            position: 'absolute',
            right: inset,
            bottom: inset,
            width: button,
            height: button,
            borderRadius: button / 2,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: mix(field, theme.primary, 0.3 + 0.7 * ready),
            boxShadow: `0 0 0 ${Math.round(unit * (0.06 + 0.24 * (1 - press.glow)))}px ${alpha(theme.primary, 0.3 * press.glow)}, 0 ${Math.round(unit * 0.15)}px ${Math.round(unit * 0.45)}px ${alpha(theme.primary, 0.3 * ready)}`,
            transform: `scale(${press.scale})`,
          }}
        >
          <div style={{ opacity: 0.55 + 0.45 * ready, display: 'flex' }}>
            <Arrow up={prompt} size={Math.round(button * 0.42)} color={theme.onPrimary} />
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
