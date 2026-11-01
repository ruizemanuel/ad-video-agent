// The video of one hook: its scenes back to back on the beat, each on its background (see sceneSurfaces), the wipe on the
// cuts that ask for it in a color that shows against both sides, the brand's fonts (and the size and ink of its logo)
// loaded before anything is measured, and, for the key frames, the probe that measures the text of each frame.
import { useEffect, useLayoutEffect, useMemo, useState, type FC } from 'react';
import { loadFont } from '@remotion/fonts';
import { Audio } from '@remotion/media';
import { AbsoluteFill, cancelRender, continueRender, delayRender, Sequence, staticFile, useCurrentFrame } from 'remotion';
import {
  fontFaces,
  layoutScenes,
  theme as makeTheme,
  opensWithBrand,
  pointSeries,
  sceneSurfaces,
  WIPE_FRAMES,
  wipeColor,
  type Edl,
  type Format,
  type PieceName,
  type ProbeItem,
  type SiteData,
} from '@app/core';
import { closeLogoBox, logoReads, measuredInk, recordedLogoSize, videoShowsLogo, type ShownLogo, type Size } from './logo';
import { ClaimStack } from './pieces/ClaimStack';
import { Ctx, SurfaceCtx, type CardSeries, type PieceProps } from './pieces/common';
import { EndCard } from './pieces/EndCard';
import { KineticHeadline } from './pieces/KineticHeadline';
import { PointCard } from './pieces/PointCard';
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

const PIECES: Record<PieceName, FC<PieceProps>> = { KineticHeadline, UiFocus, UiScroll, ClaimStack, PointCard, WordCycle, TypeIn, EndCard };

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
// The logo is drawn at most this many pixels on its longer side to measure its ink: a DPR 4 raster has no more to tell.
const INK_SAMPLE_SIDE = 256;

/** A picture of the public dir, loaded; rejects when it does not load. */
const loadImage = (file: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`The logo ${file} did not load.`));
    image.src = staticFile(file);
  });

/**
 * The mean color of the logo's ink, drawn from `file` into a canvas: null when the canvas refuses (see measuredInk) or no
 * pixel is opaque enough. Null means the name is shown, never a failed render.
 */
const measureInk = (image: HTMLImageElement, file: string): string | null =>
  measuredInk(file, () => {
    const scale = Math.min(1, INK_SAMPLE_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The canvas gave no 2d context.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return context.getImageData(0, 0, canvas.width, canvas.height).data;
  });

/**
 * The site's logo, null when it has none: its natural size (the one the capture recorded or, without one, the
 * picture's own) and the color of its ink. The picture is loaded in a few tries even when its size is recorded, to
 * measure the ink, unless that size already rules the logo out of the close's box (see logoReads): it is never shown
 * then, so it has no ink to measure. A logo that never loads fails the render, as a font does: a video whose frames or
 * key frames came out of different tabs could otherwise close on the logo in some and on the name in others.
 */
const loadLogo = async (site: SiteData, format: Format): Promise<{ size: Size; ink: string | null } | null> => {
  const logo = site.brand.logo;
  if (!logo) return null;
  const recorded = recordedLogoSize(logo);
  if (recorded && !logoReads(recorded, closeLogoBox(format))) return { size: recorded, ink: null };
  const file = logo.png ?? logo.file;
  for (let attempt = 1; ; attempt++) {
    try {
      const image = await loadImage(file);
      return { size: recorded ?? { width: image.naturalWidth, height: image.naturalHeight }, ink: measureInk(image, file) };
    } catch {
      if (attempt >= LOGO_TRIES) throw new Error(`The logo ${file} could not be loaded in ${LOGO_TRIES} tries.`);
      await new Promise((done) => setTimeout(done, LOGO_RETRY_MS * attempt));
    }
  }
};

/**
 * Text is measured while the pieces render, and whether the video shows the logo or the brand's name depends on the
 * logo's size and ink (see videoShowsLogo) against the `page`'s background, so nothing renders until the brand's fonts
 * are in and that is decided. The render is held until the tree with the pieces is laid out: their own holds (images,
 * the probe) start before this one ends.
 */
const useBrand = (site: SiteData, format: Format, page: string): { logoShown: ShownLogo | null } | null => {
  const [handle] = useState(() => delayRender('brand fonts and logo'));
  const [brand, setBrand] = useState<{ logoShown: ShownLogo | null } | null>(null);
  useEffect(() => {
    const fonts = Promise.all(fontFaces(site).map((face) => loadFont({ family: face.family, url: staticFile(face.file), weight: face.weight, stretch: face.stretch })));
    Promise.all([fonts, loadLogo(site, format)])
      .then(([, logo]) => setBrand({ logoShown: logo?.ink && videoShowsLogo(logo.size, format, logo.ink, page) ? { size: logo.size, ink: logo.ink } : null }))
      .catch((error: unknown) => cancelRender(error));
  }, [site, format, page]);
  useLayoutEffect(() => {
    if (brand) continueRender(handle);
  }, [brand, handle]);
  return brand;
};

const AdInner: FC<Omit<AdProps, 'edl' | 'site'> & { edl: Edl; site: SiteData }> = ({ edl, site, format, hook, probe, music }) => {
  const theme = useMemo(() => makeTheme(site), [site]);
  // The logo is decided once per video, on the page's background (see videoShowsLogo), so every version shows the same
  // mark and it reads wherever it is shown: the close sets it on a chip of that color where it would not (see EndCard).
  const brand = useBrand(site, format, theme.surfaces.base.bg);
  const { scenes } = useMemo(() => layoutScenes(edl, hook), [edl, hook]);
  // The background of each scene of this version: its hook changes which ones the type scenes of the body take.
  const names = useMemo(() => sceneSurfaces(scenes, theme.surfaces), [scenes, theme]);
  // The series of numbered cards each PointCard belongs to (see pointSeries), with every card of it.
  const series = useMemo(() => {
    const list = scenes.map((t) => t.scene);
    return pointSeries(list).map((place): CardSeries | undefined => place && { at: place.at, of: place.of, cards: list.slice(place.first, place.first + place.of) });
  }, [scenes]);
  if (!brand) return <AbsoluteFill style={{ background: theme.bg }} />;
  return (
    <Ctx.Provider value={{ theme, format, site, edl, logoShown: brand.logoShown }}>
      <AbsoluteFill style={{ background: theme.bg }}>
        {scenes.map((timed) => {
          const Piece = PIECES[timed.scene.piece];
          // sceneSurfaces names the brand surface only for a site that has one.
          const surface = theme.surfaces[names[timed.index] ?? 'base'] ?? theme.surfaces.base;
          return (
            <SurfaceCtx.Provider key={timed.index} value={surface}>
              <Sequence from={timed.from} durationInFrames={timed.duration} name={`${timed.role}-${timed.index}-${timed.scene.piece}`}>
                <Piece scene={timed.scene} timed={timed} showLogo={opensWithBrand(timed)} series={series[timed.index]} />
              </Sequence>
            </SurfaceCtx.Provider>
          );
        })}
        {scenes.map((timed) => {
          // The first scene has none before it, and no wipe brings it in.
          const [before, after] = [names[timed.index - 1], names[timed.index]];
          return before && after && timed.scene.transitionIn === 'wipe' ? (
            <Sequence key={`wipe-${timed.index}`} from={timed.from - WIPE_FRAMES / 2} durationInFrames={WIPE_FRAMES} name={`wipe-${timed.index}`}>
              <Wipe color={wipeColor(theme.surfaces, before, after)} />
            </Sequence>
          ) : null;
        })}
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
