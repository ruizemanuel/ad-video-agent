// The pictures of a page: one DPR 2 screenshot per section at each viewport, plus the whole page, each with the boxes of
// what is in it; and the small JPEGs the director looks at.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CaptureLog, Shot, SiteData } from '@app/core';
import type { Page } from 'puppeteer-core';
import { buildDirectorJpegArgs, runFfmpeg } from '../render/ffmpeg';
import { inPageBoxes, MAX_FULL_PAGE_CSS_PX, type RawSection } from './extract';
import { addNote, DPR, removeOverlays, sleep, VIEWPORTS, type ViewportName } from './page';

/** The size of a PNG, from its header (the IHDR chunk comes first), or null when the bytes are not a PNG. */
export const pngSize = (bytes: Buffer): { width: number; height: number } | null => {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((byte, i) => bytes[i] !== byte) || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

/**
 * Shoots each of `sections` (the page scrolled so its heading is near the top) and then the whole page, up to
 * 8000 CSS pixels, and adds the shots and their boxes to `site`. Two sections that frame the page the same way give one
 * shot. The ids are `<prefix><d|m>-<section>` and `<prefix><d|m>-full`; `prefix` is empty for the site and `x<n>-` for
 * its extra pages.
 */
export async function shoot(
  page: Page,
  viewport: ViewportName,
  prefix: string,
  sections: readonly RawSection[],
  site: Pick<SiteData, 'shots' | 'boxes'>,
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
    await page.screenshot({ path: join(runDir, file) });
    site.shots.push({ id, file, viewport, dpr: DPR, sectionId: s.id, width: vp.width * DPR, height: vp.height * DPR });
    for (const b of await page.evaluate(inPageBoxes, false, MAX_FULL_PAGE_CSS_PX)) site.boxes.push({ shotId: id, ...b });
  }
  await page.evaluate(() => scrollTo(0, 0));
  await sleep(500);
  const h = Math.min(pageHeight, MAX_FULL_PAGE_CSS_PX);
  if (pageHeight > MAX_FULL_PAGE_CSS_PX) addNote(log, `${viewport} full page clipped from ${pageHeight} to ${h} css px`);
  const id = `${prefix}${v}-full`;
  const file = `media/${id}.png`;
  await page.screenshot({ path: join(runDir, file), clip: { x: 0, y: 0, width: vp.width, height: h }, captureBeyondViewport: true });
  site.shots.push({ id, file, viewport, dpr: DPR, width: vp.width * DPR, height: h * DPR });
  for (const b of await page.evaluate(inPageBoxes, true, MAX_FULL_PAGE_CSS_PX)) site.boxes.push({ shotId: id, ...b });
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
