import { Fragment, useMemo, type FC } from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { alpha, BUTTON_IN, endCardSteps, MARK_AT, TAGLINE_AT, TYPE } from '@app/core';
import { brandName, closeLogoBox } from '../logo';
import { pressState } from '../rhythm';
import { fitAddress, layoutLines, pillSize, toWords } from '../type';
import { BrandMark, centeredSafeBox, EASE_IN_OUT, fontStyle, measureWith, progress, RevealLines, useAd, type PieceProps } from './common';

// The pill of the call to action: 0.62 em of padding above and below a line 1 em tall.
const PILL_HEIGHT_EM = 2.24;

// The close, in two steps (spec 6.5). First the brand: its logo, or its name in the site's heading font and brand color
// when the logo does not read (see logoReads), with the optional tagline (lines[1]) under it. Then, on beat 2, the
// brand moves up as the site's call to action (lines[0]) comes in under it as a button in the brand color, over the
// domain; on beat 4.5 the button is pressed (see endCardSteps). Centered on the frame's center line, not in the safe
// zone (which is lopsided in 9:16).
export const EndCard: FC<PieceProps> = ({ scene, timed }) => {
  const ad = useAd();
  const { theme, format, site, edl } = ad;
  const frame = useCurrentFrame();
  const layout = useMemo(() => {
    const type = TYPE[format];
    const column = centeredSafeBox(format);
    const measure = measureWith(theme.display);
    const host = new URL(site.url).hostname.replace(/^www\./, '');
    const [cta, tagline] = scene.lines;
    const name = brandName(site);
    const fit = { width: column.width, min: type.min, maxLines: 2, measure };
    return {
      type,
      column,
      logoBox: closeLogoBox(format),
      name,
      tagline: tagline ? layoutLines([toWords(tagline)], { ...fit, max: Math.round(type.caption * 0.8) }) : null,
      cta: cta?.text ?? '',
      ctaSize: pillSize(cta?.text ?? '', column.width, format, measure),
      host,
      // The address under the button, as large as fits the column, up to 62% of the caption size; a long one breaks.
      domain: fitAddress(host, column.width * 0.96, { max: Math.round(type.caption * 0.62), min: type.min }, measureWith(theme.body)),
    };
  }, [scene, site, format, theme]);
  const { type, column, logoBox, name, tagline, cta, ctaSize } = layout;
  // A name that fell back to the address, when it is the mark, is not repeated under the button.
  const domain = !ad.logoShown && layout.host === name ? null : layout.domain;
  const { button, press } = endCardSteps(timed, edl.bpm);
  const gaps = { tagline: Math.round(type.logo * 0.45), button: Math.round(type.logo * 0.9), domain: Math.round(type.logo * 0.5) };
  const buttonHeight = ctaSize * PILL_HEIGHT_EM;
  const domainHeight = domain ? domain.parts.length * domain.size * theme.body.lineHeight : 0;
  // The whole close is centered; until the button comes in, the brand is, moved down by half of what goes under it.
  const below = gaps.button + buttonHeight + (domain ? gaps.domain + domainHeight : 0);
  const moved = progress(frame, button, button + BUTTON_IN, EASE_IN_OUT);
  const pillIn = progress(frame, button + 2, button + BUTTON_IN);
  const domainIn = progress(frame, button + 5, button + BUTTON_IN);
  const pressed = pressState(frame, press);
  return (
    <AbsoluteFill style={{ background: theme.bg }}>
      <div style={{ ...column, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', transform: `translateY(${((1 - moved) * below) / 2}px)` }}>
          <BrandMark box={logoBox} name={{ max: Math.round(type.headline * 0.8), width: column.width }} align="center" delay={MARK_AT} />
          {tagline && (
            <div style={{ marginTop: gaps.tagline }}>
              <RevealLines lines={tagline.lines} size={tagline.size} font={theme.display} color={theme.fg} accent={theme.accentText} delay={TAGLINE_AT} align="center" />
            </div>
          )}
          <div style={{ marginTop: gaps.button, height: buttonHeight, display: 'flex', alignItems: 'center' }}>
            {/* On screen, and probed, from when it starts to come in. */}
            {pillIn > 0 && (
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
                  boxShadow: `0 0 0 ${Math.round(ctaSize * (0.06 + 0.24 * (1 - pressed.glow)))}px ${alpha(theme.primary, 0.3 * pressed.glow)}, 0 24px 60px ${alpha(theme.primary, 0.3)}`,
                  opacity: pillIn,
                  transform: `translateY(${(1 - pillIn) * 40}px) scale(${pressed.scale})`,
                }}
              >
                {cta}
              </div>
            )}
          </div>
          {domain && (
            <div style={{ marginTop: gaps.domain, height: domainHeight }}>
              {domainIn > 0 && (
                <div data-qa-line style={{ ...fontStyle(theme.body), fontSize: domain.size, color: theme.muted, opacity: domainIn, whiteSpace: 'nowrap', textAlign: 'center' }}>
                  {/* One line of the probe, the whole address, however many lines it takes. */}
                  {domain.parts.map((part, i) => (
                    <Fragment key={i}>
                      {i > 0 && <br />}
                      {part}
                    </Fragment>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </AbsoluteFill>
  );
};
