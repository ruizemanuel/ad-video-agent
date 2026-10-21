// The pictures of a page: one DPR 2 screenshot per section at each viewport, plus the whole page, each with the boxes
// and the blocks (cards) of what is in it; and the small JPEGs the director looks at.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CaptureLog, Shot, SiteData } from '@app/core';
import type { Page, ScreenshotOptions } from 'puppeteer-core';
import { buildDirectorJpegArgs, runFfmpeg } from '../render/ffmpeg';
import { inPageBlocks, inPageBoxes, inPageFadeMedia, MAX_FULL_PAGE_CSS_PX, type PageBlock, type PageBox, type RawSection } from './extract';
import { addNote, DPR, removeOverlays, sleep, VIEWPORTS, type ViewportName } from './page';
import { unchangedRegions } from './pixels';

/** The size of a PNG, from its header (the IHDR chunk comes first), or null when the bytes are not a PNG. */
export const pngSize = (bytes: Buffer): { width: number; height: number } | null => {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((byte, i) => bytes[i] !== byte) || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

/** The most blocks a shot keeps: a page of nested cards can have thousands, and the camera looks at a few. */
export const MAX_BLOCKS_PER_SHOT = 200;

/** Adds the blocks the page found in a shot to `site`: the first MAX_BLOCKS_PER_SHOT in document order, saying so when there were more. */
export const addBlocks = (site: Pick<SiteData, 'blocks'>, shotId: string, found: readonly PageBlock[], log: CaptureLog): void => {
  const kept = found.slice(0, MAX_BLOCKS_PER_SHOT);
  if (found.length > kept.length) addNote(log, `${shotId}: ${found.length} blocks found, the first ${kept.length} kept`);
  (site.blocks ??= []).push(...kept.map((b) => ({ shotId, ...b })));
};

/**
 * The boxes of a shot without the media (images, videos, canvases, SVGs) that paint nothing in it: a video never loaded
 * and with no poster, one that plays frames with nothing in them, an image not loaded yet. The shot is taken again, the
 * same way (`options`), with the media inPageBoxes measured faded out (see inPageFadeMedia). A medium whose region is
 * the same picture in both shots paints nothing there, and its box would aim the camera at what the shot does not show.
 * If the media cannot all be faded, nothing can be told and every box is kept. The log says how many were left out.
 */
async function withoutBlankMedia(page: Page, shot: Uint8Array, boxes: PageBox[], options: ScreenshotOptions, log: CaptureLog, shotId: string): Promise<PageBox[]> {
  const media = boxes.filter((b) => b.kind === 'image');
  if (media.length === 0) return boxes;
  let without: Uint8Array | null = null;
  try {
    if (await page.evaluate(inPageFadeMedia, true)) without = await page.screenshot(options);
  } finally {
    await page.evaluate(inPageFadeMedia, false);
  }
  if (!without) return boxes;
  const unchanged = await unchangedRegions(shot, without, media);
  const blank = new Set(media.filter((_, k) => unchanged[k]));
  if (blank.size > 0) addNote(log, `${shotId}: ${blank.size} media boxes left out: they paint nothing in the shot`);
  return boxes.filter((b) => !blank.has(b));
}

/**
 * Shoots each of `sections` (the page scrolled so its heading is near the top) and then the whole page, up to
 * 8000 CSS pixels, and adds the shots, their boxes (none on a medium that paints nothing) and their blocks to `site`.
 * Two sections that frame the page the same way give one shot. The ids are `<prefix><d|m>-<section>` and
 * `<prefix><d|m>-full`; `prefix` is empty for the site and `x<n>-` for its extra pages.
 */
export async function shoot(
  page: Page,
  viewport: ViewportName,
  prefix: string,
  sections: readonly RawSection[],
  site: Pick<SiteData, 'shots' | 'boxes' | 'blocks'>,
  pageHeight: number,
  { runDir, log }: { runDir: string; log: CaptureLog },
): Promise<void> {
  const vp = VIEWPORTS[viewport];
  const v = viewport === 'desktop' ? 'd' : 'm';
  let lastY = -Infinity;
  for (const s of sections) {
    const y = await page.evaluate((id) => {
      const el = document.querySelector(`[data-capsec="${id}"]`);
      if (!el) return null;
      const top = el.getBoundingClientRect().top + scrollY;
      const target = Math.max(0, Math.min(top - 120, document.documentElement.scrollHeight - innerHeight));
      scrollTo(0, target);
      return scrollY;
    }, s.id);
    if (y === null || Math.abs(y - lastY) < 200) continue; // same framing as the previous shot
    lastY = y;
    await sleep(700); // reveal-on-scroll animations
    // A popup that came up since the page was opened (a newsletter after a few seconds, or on scroll) is not the site.
    if ((await removeOverlays(page, log, `${prefix}${v}-${s.id}`)) > 0) await sleep(300);
    const id = `${prefix}${v}-${s.id}`;
    const file = `media/${id}.png`;
    const shot = await page.screenshot({ path: join(runDir, file) });
    site.shots.push({ id, file, viewport, dpr: DPR, sectionId: s.id, width: vp.width * DPR, height: vp.height * DPR });
    await measure(page, id, shot, {}, false, site, log);
  }
  await page.evaluate(() => scrollTo(0, 0));
  await sleep(500);
  const h = Math.min(pageHeight, MAX_FULL_PAGE_CSS_PX);
  if (pageHeight > MAX_FULL_PAGE_CSS_PX) addNote(log, `${viewport} full page clipped from ${pageHeight} to ${h} css px`);
  const id = `${prefix}${v}-full`;
  const file = `media/${id}.png`;
  const options: ScreenshotOptions = { clip: { x: 0, y: 0, width: vp.width, height: h }, captureBeyondViewport: true };
  const shot = await page.screenshot({ path: join(runDir, file), ...options });
  site.shots.push({ id, file, viewport, dpr: DPR, width: vp.width * DPR, height: h * DPR });
  await measure(page, id, shot, options, true, site, log);
}

/**
 * Adds the boxes and the blocks of the shot just taken (`shot`, taken with `options`) to `site`. The blocks are measured
 * before the media are faded out to see which paint nothing (see withoutBlankMedia).
 */
async function measure(page: Page, id: string, shot: Uint8Array, options: ScreenshotOptions, fullPage: boolean, site: Pick<SiteData, 'boxes' | 'blocks'>, log: CaptureLog): Promise<void> {
  const boxes = await page.evaluate(inPageBoxes, fullPage, MAX_FULL_PAGE_CSS_PX);
  const blocks = await page.evaluate(inPageBlocks, fullPage, MAX_FULL_PAGE_CSS_PX);
  for (const b of await withoutBlankMedia(page, shot, boxes, options, log, id)) site.boxes.push({ shotId: id, ...b });
  addBlocks(site, id, blocks, log);
}

/** The most pictures the director is shown: each is a part of a billed model call, and a site can have many sections. */
export const MAX_DIRECTOR_IMAGES = 20;

/** Whether a shot is of an extra page (`x<n>-`) rather than of the site's own. */
const ofExtraPage = (shot: Shot): boolean => /^x\d+-/.test(shot.id);

/**
 * The shots the director is shown: those of the phone (the video is vertical), without the full-page ones, which are too
 * tall to read; at most MAX_DIRECTOR_IMAGES, the site's own page first and then the extra pages, each in its order.
 */
export const shotsForDirector = (shots: readonly Shot[]): Shot[] => {
  const phone = shots.filter((s) => s.viewport === 'mobile' && !s.id.endsWith('-full'));
  return [...phone.filter((s) => !ofExtraPage(s)), ...phone.filter(ofExtraPage)].slice(0, MAX_DIRECTOR_IMAGES);
};

/** Writes `director/<shot id>.jpg` for each shot the director is shown. */
export async function makeDirectorJpegs(runDir: string, shots: readonly Shot[]): Promise<void> {
  mkdirSync(join(runDir, 'director'), { recursive: true });
  for (const shot of shotsForDirector(shots)) {
    await runFfmpeg(buildDirectorJpegArgs(join(runDir, shot.file), join(runDir, 'director', `${shot.id}.jpg`)), `make the picture of ${shot.id}`);
  }
}
