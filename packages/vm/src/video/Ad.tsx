// The video of one hook: its scenes back to back on the beat, the brand wipe on the cuts that ask for it, the brand's
// fonts (and the size of its logo) loaded before anything is measured, and, for the key frames, the probe that measures
// the text of each frame.
import { useEffect, useLayoutEffect, useMemo, useState, type FC } from 'react';
import { loadFont } from '@remotion/fonts';
import { Audio } from '@remotion/media';
import { AbsoluteFill, cancelRender, continueRender, delayRender, Sequence, staticFile, useCurrentFrame } from 'remotion';
import { fontFaces, layoutScenes, theme as makeTheme, WIPE_FRAMES, type Edl, type Format, type PieceName, type ProbeItem, type SiteData } from '@app/core';
import { recordedLogoSize, videoShowsLogo, type Size } from './logo';
import { ClaimStack } from './pieces/ClaimStack';
import { Ctx, type PieceProps } from './pieces/common';
import { EndCard } from './pieces/EndCard';
import { KineticHeadline } from './pieces/KineticHeadline';
import { TypeIn } from './pieces/TypeIn';
import { UiFocus } from './pieces/UiFocus';
import { UiScroll } from './pieces/UiScroll';
import { Wipe } from './pieces/Wipe';
import { WordCycle } from './pieces/WordCycle';
import { probeMessage } from './probe';

/**
 * `probe`: log the text of each frame, measured in the real DOM (see probe.ts). `music`: a track already cut to the
 * video's length, relative to the public dir. The service does not use `music` (the video is rendered muted and the
 * track is muxed in with ffmpeg, see render/video.ts): the run folder is copied into the bundle when the bundle is made,
 * before the music's WAV exists, so `staticFile` could not serve it.
 */
export type AdProps = { edl: Edl | null; site: SiteData | null; format: Format; hook: number; probe?: boolean; music?: string };

const PIECES: Record<PieceName, FC<PieceProps>> = { KineticHeadline, UiFocus, UiScroll, ClaimStack, WordCycle, TypeIn, EndCard };

/** Measures every `[data-qa-line]` of the frame once it is laid out: its box, size, font, colors, opacity and background. */
const Probe: FC = () => {
  const frame = useCurrentFrame();
  useLayoutEffect(() => {
    const handle = delayRender(`probe of frame ${frame}`);
    requestAnimationFrame(() => {
      const items = [...document.querySelectorAll('[data-qa-line]')].map((el): ProbeItem => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const box = range.getBoundingClientRect();
        let opacity = 1;
        let bg: string | null = null;
        for (let node: Element | null = el; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          opacity *= Number(style.opacity);
          if (!bg && style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent') bg = style.backgroundColor;
        }
        const own = getComputedStyle(el);
        return {
          text: el.textContent ?? '',
          x: box.left,
          y: box.top,
          w: box.width,
          h: box.height,
          fontSize: parseFloat(own.fontSize),
          font: `${own.fontFamily} ${own.fontWeight} ${own.fontStretch}`,
          colors: [...new Set([el, ...el.querySelectorAll('span')].map((node) => getComputedStyle(node).color))],
          opacity,
          bg,
        };
      });
      console.log(probeMessage({ frame, items }));
      continueRender(handle);
    });
  }, [frame]);
  return null;
};

const LOGO_TRIES = 3;
const LOGO_RETRY_MS = 250;

/** The natural size of a picture of the public dir; rejects when it does not load. */
const naturalSize = (file: string): Promise<Size> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error(`The logo ${file} did not load.`));
    image.src = staticFile(file);
  });

/**
 * The natural size of the site's logo, null when it has none: the size the capture recorded or, without one, the
 * picture's own, loaded in a few tries. A logo that never loads fails the render, as a font does: a video whose
 * frames or key frames came out of different tabs could otherwise close on the logo in some and on the name in others.
 */
const logoSizeOf = async (site: SiteData): Promise<Size | null> => {
  const logo = site.brand.logo;
  if (!logo) return null;
  const recorded = recordedLogoSize(logo);
  if (recorded) return recorded;
  const file = logo.png ?? logo.file;
  for (let attempt = 1; ; attempt++) {
    try {
      return await naturalSize(file);
    } catch {
      if (attempt >= LOGO_TRIES) throw new Error(`The logo ${file} could not be loaded in ${LOGO_TRIES} tries.`);
      await new Promise((done) => setTimeout(done, LOGO_RETRY_MS * attempt));
    }
  }
};

/**
 * Text is measured while the pieces render, and whether the video shows the logo or the brand's name depends on the
 * logo's size (see videoShowsLogo), so nothing renders until the brand's fonts are in and that is decided. The render
 * is held until the tree with the pieces is laid out: their own holds (images, the probe) start before this one ends.
 */
const useBrand = (site: SiteData, format: Format): { logoShown: Size | null } | null => {
  const [handle] = useState(() => delayRender('brand fonts and logo'));
  const [brand, setBrand] = useState<{ logoShown: Size | null } | null>(null);
  useEffect(() => {
    const fonts = Promise.all(fontFaces(site).map((face) => loadFont({ family: face.family, url: staticFile(face.file), weight: face.weight, stretch: face.stretch })));
    Promise.all([fonts, logoSizeOf(site)])
      .then(([, size]) => setBrand({ logoShown: videoShowsLogo(size, format) ? size : null }))
      .catch((error: unknown) => cancelRender(error));
  }, [site, format]);
  useLayoutEffect(() => {
    if (brand) continueRender(handle);
  }, [brand, handle]);
  return brand;
};

const AdInner: FC<Omit<AdProps, 'edl' | 'site'> & { edl: Edl; site: SiteData }> = ({ edl, site, format, hook, probe, music }) => {
  const brand = useBrand(site, format);
  const theme = useMemo(() => makeTheme(site), [site]);
  const { scenes } = useMemo(() => layoutScenes(edl, hook), [edl, hook]);
  if (!brand) return <AbsoluteFill style={{ background: theme.bg }} />;
  return (
    <Ctx.Provider value={{ theme, format, site, edl, logoShown: brand.logoShown }}>
      <AbsoluteFill style={{ background: theme.bg }}>
        {scenes.map((timed) => {
          const Piece = PIECES[timed.scene.piece];
          return (
            <Sequence key={timed.index} from={timed.from} durationInFrames={timed.duration} name={`${timed.role}-${timed.index}-${timed.scene.piece}`}>
              <Piece scene={timed.scene} timed={timed} showLogo={timed.index === 0 && timed.scene.piece === 'KineticHeadline'} />
            </Sequence>
          );
        })}
        {scenes.map((timed) =>
          timed.index > 0 && timed.scene.transitionIn === 'wipe' ? (
            <Sequence key={`wipe-${timed.index}`} from={timed.from - WIPE_FRAMES / 2} durationInFrames={WIPE_FRAMES} name={`wipe-${timed.index}`}>
              <Wipe color={theme.primary} />
            </Sequence>
          ) : null,
        )}
        {probe && <Probe />}
        {music && <Audio src={staticFile(music)} />}
      </AbsoluteFill>
    </Ctx.Provider>
  );
};

export const Ad: FC<AdProps> = ({ edl, site, ...rest }) => {
  if (!edl || !site) return <AbsoluteFill style={{ background: '#111111' }} />;
  return <AdInner edl={edl} site={site} {...rest} />;
};
