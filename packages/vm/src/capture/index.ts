// Reads and films a site: the text by section, the brand (colors, fonts, logo), DPR 2 shots with the boxes of what is in
// them and, for the director, small pictures. Besides the site it follows the links that lead to a demo of the product
// and the pages the client named: their shots are kept (prefix `x<n>-`) and their text apart, because only the site's own
// text can back what the video says. It writes `site.json`, `media/*` and `director/*.jpg` under the run folder.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { detectBlocked, findDemoLinks, type Anchor, type CaptureFile, type CaptureInput, type CaptureLog, type CaptureResult, type SiteData, type TaskEnvelope } from '@app/core';
import type { Browser, Page } from 'puppeteer-core';
import { uploadToPresigned } from '../upload';
import { inPageAnchors, inPageBrand, inPageExtractText, inPageFaceKind, inPageFindLogo, pickColors, type PageText } from './extract';
import { download, firstFamily, resolveFont } from './fonts';
import { addNote, launchBrowser, openPage, sleep, UnreachableError, VIEWPORTS } from './page';
import { makeDirectorJpegs, pngSize, shoot } from './shots';

/** What `capture` writes to `site.json`: the site with its blocks, plus the sections of the extra pages and the log of the capture. */
export type CapturedSite = SiteData & Required<Pick<SiteData, 'blocks' | 'extraSections' | 'log'>>;

/** The most demo links the capture will follow. */
const MAX_FOLLOWED_LINKS = 2;
/** Extra pages are skipped once the capture has taken this long: the task has 12 minutes in all, VM start-up included. */
const EXTRA_PAGES_BUDGET_MS = 6 * 60_000;
const BLOCKED_MESSAGE = 'The site shows a challenge or an access-denied page instead of its content.';

/**
 * Whether the VM is shut away from the cloud's metadata server, which would hand its credentials to whatever a site
 * makes the browser fetch. It is: when the call fails or times out. Any answer, even a refusal, means it got through.
 */
export async function metadataBlocked(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl('http://169.254.169.254/computeMetadata/v1/', { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(3000) });
    await response.body?.cancel();
    return false;
  } catch {
    return true;
  }
}

const stopwatch = (log: CaptureLog) => {
  let last = Date.now();
  return (key: string): void => {
    const now = Date.now();
    log.timings[key] = (now - last) / 1000;
    last = now;
  };
};

type Context = { browser: Browser; runDir: string; site: CapturedSite; log: CaptureLog; lap: (key: string) => void };

/** The run folder with nothing of an earlier capture in it. */
function prepareRunDir(runDir: string): void {
  for (const name of ['site.json', 'media', 'director']) rmSync(join(runDir, name), { recursive: true, force: true });
  mkdirSync(join(runDir, 'media', 'fonts'), { recursive: true });
  mkdirSync(join(runDir, 'director'), { recursive: true });
}

/** Section ids are unique across pages: the sections of an extra page continue the numbering of the ones before. */
async function renumber(page: Page, text: PageText, offset: number): Promise<void> {
  await page.evaluate((off) => {
    for (const el of document.querySelectorAll('[data-capsec]')) el.setAttribute('data-capsec', `s${Number((el.getAttribute('data-capsec') ?? 's0').slice(1)) + off}`);
  }, offset);
  for (const s of text.sections) s.id = `s${Number(s.id.slice(1)) + offset}`;
}

/** The colors, the fonts, the logo and the og:image of the site, from its first page at the desktop size. */
async function readBrand(ctx: Context, page: Page, url: string, text: PageText): Promise<void> {
  const { runDir, site, log, lap } = ctx;
  const note = (n: string): void => addNote(log, n);
  const brand = await page.evaluate(inPageBrand);
  site.brand.colors = pickColors(brand, note);
  // Whether each face has serifs, measured here where the page has its faces loaded: the kind of open font that stands
  // in for one that Google Fonts does not have.
  const measured = await page.evaluate(inPageFaceKind, firstFamily(brand.displayStack), brand.displayWeight);
  const display = await resolveFont(brand.displayStack, 'display', brand, { outDir: runDir, stretch: brand.displayStretch, measured, note });
  display.weight = brand.displayWeight;
  if (brand.displayMetrics) Object.assign(display, brand.displayMetrics);
  site.brand.fonts.push(display);
  if (firstFamily(brand.bodyStack) === firstFamily(brand.displayStack)) display.alsoBody = true;
  else {
    const bodyMeasured = await page.evaluate(inPageFaceKind, firstFamily(brand.bodyStack), brand.bodyWeight);
    site.brand.fonts.push(await resolveFont(brand.bodyStack, 'body', brand, { outDir: runDir, measured: bodyMeasured, note }));
  }
  lap('brand');

  const mediaDir = join(runDir, 'media');
  const logo = await page.evaluate(inPageFindLogo);
  if (logo) {
    if (logo.svg && !logo.hasText) {
      writeFileSync(join(mediaDir, 'logo.svg'), logo.svg);
      site.brand.logo = { file: 'media/logo.svg', kind: 'svg' };
    }
    // Always keep a high-DPR raster of the whole logo (icon and wordmark), on a transparent background.
    await page.setViewport({ ...VIEWPORTS.desktop, deviceScaleFactor: 4 });
    // omitBackground only helps if nothing behind the logo paints: clear the backgrounds of its ancestors. The logo's own
    // stays when CSS draws the logo with it: a picture as its background, or its color cut by a mask.
    await page.evaluate(() => {
      for (let p = document.querySelector<HTMLElement>('[data-caplogo]'); p; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (p.hasAttribute('data-caplogo') && (cs.backgroundImage.includes('url(') || cs.maskImage.includes('url('))) continue;
        p.dataset.capbg = p.style.background;
        p.style.background = 'transparent';
      }
    });
    await sleep(300);
    const element = await page.$('[data-caplogo]');
    if (element) {
      await element.screenshot({ path: join(mediaDir, 'logo.png'), omitBackground: true });
      if (site.brand.logo) site.brand.logo.png = 'media/logo.png';
      else site.brand.logo = { file: 'media/logo.png', kind: 'png' };
      // The video decides from this size whether the logo reads (see video/logo.ts), the same in every render.
      const size = pngSize(readFileSync(join(mediaDir, 'logo.png')));
      if (size) Object.assign(site.brand.logo, size);
    }
    await page.evaluate(() => {
      for (const p of document.querySelectorAll<HTMLElement>('[data-capbg]')) p.style.background = p.dataset.capbg ?? '';
    });
    await page.setViewport(VIEWPORTS.desktop);
    await sleep(300);
  } else {
    addNote(log, 'no logo found in the header');
  }

  if (text.ogImage) {
    try {
      const og = new URL(text.ogImage, url).href;
      const type = await download(og, join(mediaDir, 'og.img'));
      const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
      renameSync(join(mediaDir, 'og.img'), join(mediaDir, `og.${ext}`));
      site.brand.ogImage = `media/og.${ext}`;
    } catch (error) {
      addNote(log, `og:image download failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
  lap('logo-og');
}

/**
 * How the capture of a page ended: `blocked` (a wall instead of the site), `failed` (the site's own page gave no text to
 * write from) or `read`, with the links of the site's own page (none for an extra page).
 */
type PageOutcome = { status: 'blocked' } | { status: 'failed'; message: string } | { status: 'read'; anchors: Anchor[] };

/** The words of a text: what stands between spaces and holds a letter or a digit. */
export const countWords = (text: string): number => text.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;

/** Under both, the sections of a capture hold too little of the page's text to write a video from. */
const THIN_CAPTURE = { words: 60, share: 0.25 };

/**
 * Why a capture fails when its sections hold fewer than 60 words and also less than a quarter of the words the page
 * shows (the capture lost the page's text: a video written from it would say nothing), or null when it holds enough.
 */
export function thinCaptureMessage(capturedWords: number, pageWords: number): string | null {
  if (capturedWords >= THIN_CAPTURE.words || capturedWords >= pageWords * THIN_CAPTURE.share) return null;
  return `The capture read ${capturedWords} words of the ${pageWords} the page shows: too little to write from.`;
}

/**
 * The desktop id of each phone section: the k-th phone section with a heading is the k-th desktop section with it. Null
 * for one with no k-th twin on the desktop (the phone layout can have sections the desktop has not).
 */
export function pairPhoneSections(desktop: readonly { id: string; heading: string }[], phone: readonly { heading: string }[]): (string | null)[] {
  const ids = new Map<string, string[]>();
  for (const s of desktop) ids.set(s.heading, [...(ids.get(s.heading) ?? []), s.id]);
  const seen = new Map<string, number>();
  return phone.map(({ heading }) => {
    const k = seen.get(heading) ?? 0;
    seen.set(heading, k + 1);
    return ids.get(heading)?.[k] ?? null;
  });
}

/** An extra page that is not one to film: the capture leaves it out, says why in its log, and goes on. */
export class ExtraPageLeftOut extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ExtraPageLeftOut';
  }
}

type Seen = { title: string; text: string };

/** What the page shows to read whether it is a wall: its title and its text. Runs in the page. */
const inPageSeen = (): Seen => ({ title: document.title, text: document.body?.innerText ?? '' });

/**
 * Throws ExtraPageLeftOut for an extra page that is a wall for automated visitors (a challenge, an access-denied page)
 * or that did not answer with a 2xx: neither is the product. The site's own page is checked apart (a wall there fails the
 * capture); an extra page is best effort, so one that fails is only left out.
 */
export async function checkExtraPage(page: { evaluate(read: () => Seen): Promise<Seen> }, status: number): Promise<void> {
  const seen = await page.evaluate(inPageSeen);
  if (detectBlocked({ ...seen, status })) throw new ExtraPageLeftOut('it shows a challenge or an access-denied page');
  if (status < 200 || status >= 300) throw new ExtraPageLeftOut(`it answered HTTP ${status}`);
}

/**
 * One page, at the desktop size and then at the phone's: its text, its shots and boxes (and, for the site's own page,
 * the brand). `prefix` is empty for the site and `x<n>-` for an extra page.
 */
async function capturePage(ctx: Context, url: string, prefix: string): Promise<PageOutcome> {
  const { browser, site, log, lap, runDir } = ctx;
  const own = prefix === '';
  let anchors: Anchor[] = [];
  let pageWords = 0;

  const desktop = await openPage(browser, url, 'desktop', log);
  let text: PageText;
  try {
    lap(`${prefix}open-desktop`);
    if (own) {
      const seen = await desktop.page.evaluate(inPageSeen);
      if (detectBlocked({ ...seen, status: desktop.status })) return { status: 'blocked' };
      pageWords = countWords(seen.text);
      anchors = await desktop.page.evaluate(inPageAnchors);
    } else {
      await checkExtraPage(desktop.page, desktop.status);
    }
    text = await desktop.page.evaluate(inPageExtractText);
    const offset = site.sections.length + site.extraSections.length;
    if (offset > 0) await renumber(desktop.page, text, offset);
    if (own) {
      site.sections.push(...text.sections);
      Object.assign(site, { lang: text.lang, title: text.title, description: text.description });
      await readBrand(ctx, desktop.page, url, text);
    } else {
      // Extra pages are there to be filmed (spec 5.1): their text never backs a claim, so it stays apart.
      site.extraSections.push(...text.sections.map((s) => ({ ...s, page: url })));
    }
    await shoot(desktop.page, 'desktop', prefix, text.sections, site, desktop.height, { runDir, log });
    lap(`${prefix}shots-desktop`);
  } finally {
    await desktop.page.close().catch(() => {});
  }

  // The site's own page fails here, before the phone pass, when it gave no text to write from: the order is refunded,
  // and does not pay for the phone's capture as well.
  if (own) {
    if (site.sections.length === 0) return { status: 'failed', message: 'The page has no text to read.' };
    const thin = thinCaptureMessage(
      site.sections.reduce((words, s) => words + countWords(s.heading) + countWords(s.text), 0),
      pageWords,
    );
    if (thin !== null) return { status: 'failed', message: thin };
  }

  // The phone: the sections are found again by their heading, and get the ids the desktop gave them.
  const mobile = await openPage(browser, url, 'mobile', log);
  try {
    lap(`${prefix}open-mobile`);
    const mobileText = await mobile.page.evaluate(inPageExtractText);
    const desktopIds = pairPhoneSections(text.sections, mobileText.sections);
    const pairs = mobileText.sections.map((s, i): [string, string | null] => [s.id, desktopIds[i] ?? null]);
    await mobile.page.evaluate((all) => {
      // Found before any is renamed: a new id may be the old id of another one.
      const found = all.map(([from]) => document.querySelector(`[data-capsec="${from}"]`));
      all.forEach(([from, to], i) => found[i]?.setAttribute('data-capsec', to ?? `m-${from}`));
    }, pairs);
    const mapped = mobileText.sections.flatMap((s, i) => {
      const id = desktopIds[i];
      return id ? [{ ...s, id }] : [];
    });
    if (mapped.length < mobileText.sections.length) addNote(log, `${url} mobile: ${mobileText.sections.length - mapped.length} sections not present on desktop (skipped for shots)`);
    await shoot(mobile.page, 'mobile', prefix, mapped, site, mobile.height, { runDir, log });
    lap(`${prefix}shots-mobile`);
  } finally {
    await mobile.page.close().catch(() => {});
  }
  return { status: 'read', anchors };
}

/** The address as a full http or https address, or null: a file, a script, ftp or text that is no address is not a page to film. */
const httpUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
};

const withoutHash = (url: string): string => {
  const copy = new URL(url);
  copy.hash = '';
  return copy.href;
};

/**
 * The extra pages to film: the demo links first, then the pages the client named, each once and never the site itself.
 * What is not an http or https address is left out and counted in `ignored`.
 */
export function pickExtraPages(mainUrl: string, demoLinks: readonly string[], extraUrls: readonly string[]): { pages: string[]; ignored: number } {
  const main = withoutHash(mainUrl);
  const pages = new Set<string>();
  let ignored = 0;
  for (const given of [...demoLinks, ...extraUrls]) {
    const url = httpUrl(given);
    if (url === null) {
      ignored++;
      continue;
    }
    const page = withoutHash(url);
    if (page !== main) pages.add(page);
  }
  return { pages: [...pages], ignored };
}

/**
 * Captures the site into `runDir`. A challenge page instead of the site is `blocked`, an address that cannot be
 * reached is `unreachable`, and a capture whose sections lost the text the page shows is an `error` (see
 * thinCaptureMessage): it is given back right after the desktop pass, before the phone is filmed and before any model
 * is paid to read it. The extra pages (demo links the site shows, `extraUrls`) are best effort: one that fails, is a
 * wall for automated visitors or answers with an error (see checkExtraPage) is left out and noted. `metadataBlocked`
 * says whether this VM is shut away from the cloud's metadata server.
 */
export async function capture(input: CaptureInput, runDir: string): Promise<CaptureResult> {
  // The browser would open a file: address as readily as a web one.
  if (httpUrl(input.url) === null) return { ok: false, code: 'error', message: 'The capture needs an http or https web address.' };
  const started = Date.now();
  const log: CaptureLog = { startedAt: new Date(started).toISOString(), notes: [], timings: {} };
  const lap = stopwatch(log);
  prepareRunDir(runDir);
  const metadata = metadataBlocked();

  let browser: Browser | undefined;
  try {
    browser = await launchBrowser();
    lap('launch');
    const site: CapturedSite = {
      url: input.url,
      lang: '',
      title: '',
      description: '',
      sections: [],
      brand: { colors: [], fonts: [] },
      shots: [],
      boxes: [],
      blocks: [],
      recordings: [],
      extraSections: [],
      log,
    };
    const ctx: Context = { browser, runDir, site, log, lap };

    const own = await capturePage(ctx, input.url, '');
    if (own.status === 'blocked') return { ok: false, code: 'blocked', message: BLOCKED_MESSAGE };
    if (own.status === 'failed') return { ok: false, code: 'error', message: own.message };

    const demo = input.followDemoLinks > 0 ? findDemoLinks(own.anchors, input.url, Math.min(input.followDemoLinks, MAX_FOLLOWED_LINKS)) : [];
    const { pages: extras, ignored } = pickExtraPages(input.url, demo, input.extraUrls);
    if (ignored > 0) addNote(log, `${ignored} extra addresses ignored: only http and https pages are filmed`);
    for (const [i, url] of extras.entries()) {
      if (Date.now() - started > EXTRA_PAGES_BUDGET_MS) {
        addNote(log, `${extras.length - i} extra pages skipped: the capture ran out of time`);
        break;
      }
      const before = { shots: site.shots.length, boxes: site.boxes.length, blocks: site.blocks.length, extraSections: site.extraSections.length };
      try {
        await capturePage(ctx, url, `x${i + 1}-`);
      } catch (error) {
        // Whatever the page added is taken back: a page that is half there would leave shots without sections.
        site.shots.length = before.shots;
        site.boxes.length = before.boxes;
        site.blocks.length = before.blocks;
        site.extraSections.length = before.extraSections;
        addNote(log, `extra page ${url} left out: ${error instanceof Error ? error.message.split('\n')[0] : 'unknown error'}`);
      }
    }

    await browser.close();
    browser = undefined;
    log.finishedAt = new Date().toISOString();
    writeFileSync(join(runDir, 'site.json'), JSON.stringify(site, null, 2));
    await makeDirectorJpegs(runDir, site.shots);
    lap('director-jpegs');
    return { ok: true, metadataBlocked: await metadata, sections: site.sections.length, shots: site.shots.length };
  } catch (error) {
    if (error instanceof UnreachableError) return { ok: false, code: 'unreachable', message: error.message };
    return { ok: false, code: 'error', message: error instanceof Error ? error.message.slice(0, 300) : 'The capture failed.' };
  } finally {
    await browser?.close().catch(() => {});
  }
}

// ---------- the task ----------

export function parseCaptureInput(value: unknown): CaptureInput {
  const given = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const url = httpUrl(given.url);
  if (url === null) throw new Error('The capture task has no usable web address.');
  // Pages that are not http(s) addresses are left out: the capture can do without them.
  const extraUrls = (Array.isArray(given.extraUrls) ? given.extraUrls : []).map(httpUrl).filter((u): u is string => u !== null);
  const followDemoLinks = typeof given.followDemoLinks === 'number' && Number.isFinite(given.followDemoLinks) ? Math.max(0, Math.floor(given.followDemoLinks)) : 0;
  return { url, extraUrls, followDemoLinks };
}

/** `site.json` and the pictures for the director, as the flow reads them. */
export function buildCaptureFile(runDir: string): CaptureFile {
  const site = JSON.parse(readFileSync(join(runDir, 'site.json'), 'utf8')) as SiteData;
  const directorDir = join(runDir, 'director');
  const directorImages = readdirSync(directorDir)
    .filter((name) => name.endsWith('.jpg'))
    .sort()
    .map((name) => ({ shotId: basename(name, '.jpg'), jpegBase64: readFileSync(join(directorDir, name)).toString('base64') }));
  return { site, directorImages };
}

/** What `captureTask` leans on, so that a test can put its own: the capture itself and the upload. */
export type CaptureTaskDeps = { capture: typeof capture; upload: typeof uploadToPresigned };

/**
 * The handler of `capture` tasks: captures the site, then writes `capture.json` to the place the task names. A capture
 * that does not succeed uploads nothing and is given back as it is. It throws if the task has no usable address or no
 * place to write to, and if the upload fails.
 */
export async function captureTask(task: TaskEnvelope, runDir: string, deps: CaptureTaskDeps = { capture, upload: uploadToPresigned }): Promise<CaptureResult> {
  const input = parseCaptureInput(task.input);
  const target = task.urls.captureJson;
  if (!target) throw new Error('The capture task came without a place to put the capture.');
  const result = await deps.capture(input, runDir);
  if (!result.ok) return result;
  await deps.upload(target, JSON.stringify(buildCaptureFile(runDir)), 'application/json');
  return result;
}
