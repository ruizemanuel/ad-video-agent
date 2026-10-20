// Opt-in (`pnpm --filter @app/vm test:browser`): drives a real Chrome against a small site served from test/fixtures/site.
// The first run downloads chrome-headless-shell, and the fonts come from Google Fonts, so it needs the network.
// A capture takes half a minute, so the describes below share one capture each.
import { ensureBrowser } from '@remotion/renderer';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CaptureInput, CaptureResult } from '@app/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCaptureFile, capture, type CapturedSite } from '../../src/capture';
import { inPageFindLogo, inPageSetup } from '../../src/capture/extract';
import { launchBrowser } from '../../src/capture/page';
import { pngSize } from '../../src/capture/shots';
import { serveFixtureSite } from './support/fixture-site';
import { pngHasInk } from './support/png';

let fixture: Awaited<ReturnType<typeof serveFixtureSite>>;
let fixtureUrl: string;
const dirs: string[] = [];

beforeAll(async () => {
  await ensureBrowser();
  fixture = await serveFixtureSite();
  fixtureUrl = fixture.url;
});
afterAll(async () => {
  await fixture.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const runDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'capture-'));
  dirs.push(dir);
  return dir;
};
const readSite = (dir: string): CapturedSite => JSON.parse(readFileSync(join(dir, 'site.json'), 'utf8')) as CapturedSite;

/** Captures once, in `beforeAll`, and gives the tests of the describe what came out. */
function sharedCapture(input: () => CaptureInput) {
  const shared = { dir: '', result: undefined as unknown as CaptureResult, site: undefined as unknown as CapturedSite };
  beforeAll(async () => {
    shared.dir = runDir();
    shared.result = await capture(input(), shared.dir);
    if (!shared.result.ok) throw new Error(`The capture failed: ${shared.result.message}`);
    shared.site = readSite(shared.dir);
  });
  return shared;
}

describe('capture', () => {
  it('captures the fixture site: sections, shots, boxes, no banner or modal, and the demo page as an extra', async () => {
    const dir = runDir();
    const r = await capture({ url: fixtureUrl, extraUrls: [], followDemoLinks: 2 }, dir);
    expect(r).toMatchObject({ ok: true });
    const site = readSite(dir);
    expect(site.sections.length).toBeGreaterThanOrEqual(4);
    expect(site.extraSections).toHaveLength(1);
    expect(site.log.notes).toEqual(expect.arrayContaining(['cookies dismissed', 'overlay removed']));
    expect(existsSync(join(dir, 'director', `${site.shots.find((s) => s.viewport === 'mobile')!.id}.jpg`))).toBe(true);
  });

  it('reports a challenge page as blocked', async () => {
    const r = await capture({ url: `${fixtureUrl}challenge.html`, extraUrls: [], followDemoLinks: 2 }, runDir());
    expect(r).toMatchObject({ ok: false, code: 'blocked' });
  });

  it('reports an address nobody answers as unreachable', async () => {
    const r = await capture({ url: 'http://127.0.0.1:1/', extraUrls: [], followDemoLinks: 0 }, runDir());
    expect(r).toMatchObject({ ok: false, code: 'unreachable' });
  });

  it('fails a page with no text instead of filming nothing', async () => {
    const r = await capture({ url: `${fixtureUrl}empty.html`, extraUrls: [], followDemoLinks: 0 }, runDir());
    expect(r).toMatchObject({ ok: false, code: 'error', message: expect.stringContaining('no text') });
  });

  it('fails a capture whose sections lost the text the page shows, saying how much it read of how much', async () => {
    // The page shows 100 words, 91 of them in a menu the capture does not read: its one section holds 9.
    const r = await capture({ url: `${fixtureUrl}thin.html`, extraUrls: [], followDemoLinks: 0 }, runDir());
    expect(r).toEqual({ ok: false, code: 'error', message: 'The capture read 9 words of the 100 the page shows: too little to write from.' });
  });
});

describe('a Framer site: content in wrappers with no box, figures split over headings, a carousel, cards that fade in, a CSS wordmark', () => {
  const run = sharedCapture(() => ({ url: `${fixtureUrl}framer.html`, extraUrls: [], followDemoLinks: 0 }));
  const section = (heading: string) => run.site.sections.find((s) => s.heading === heading)!;

  it('reads the text in the wrappers with no box of their own, and not the variant that is display: none', () => {
    expect(section('Rails for global finance').text).toContain('The most widely adopted chain for stablecoin payments, on the desktop.');
    expect(section('How it is different').text).toContain('Built for agents\nInfrastructure for high-frequency transactions.');
    expect(JSON.stringify(run.site.sections)).not.toContain('on the phone');
  });

  it('keeps each figure with its label in one section, and opens no section on a piece of a heading', () => {
    expect(run.site.sections.map((s) => s.heading)).toEqual(['Rails for global finance', 'How it is different', 'Cards that fade in']);
    // A label above its figure or under it; a figure split over headings is one line.
    expect(section('Rails for global finance').text.split('\n')).toEqual([
      'The most widely adopted chain for stablecoin payments, on the desktop.',
      '1.5 B',
      'Total transactions',
      'Source: example.org',
      'Monthly stablecoin volume',
      '$ 6.2 Billion',
      'Avg block time',
      '1 second',
      'Avg gas fee',
      '$0.0004',
    ]);
    // The phone's figure ("1 sec.") opens none either: each phone section has its desktop twin and its shot.
    expect(run.site.log.notes.join('\n')).not.toContain('not present on desktop');
    expect(run.site.shots.filter((s) => s.viewport === 'mobile').map((s) => s.id)).toEqual(['m-s1', 'm-s2', 'm-s3', 'm-full']);
  });

  it('keeps a line the carousel repeats once, where it first comes', () => {
    expect(section('How it is different').text).toBe(
      'Built for agents\nInfrastructure for high-frequency transactions.\nDesigned for payments\nSub-cent fees and one-block finality.',
    );
  });

  it('measures no box or block on content under 0.05 effective opacity, and does on content half-way there, but reads the text of all', () => {
    const { site } = run;
    const fade = section('Cards that fade in');
    for (const line of ['Not revealed yet: $7 / month', 'Not started yet: $8 / month', 'Dim twice over: $6 / month']) expect(fade.text).toContain(line);
    for (const v of ['d', 'm']) {
      for (const shotId of [`${v}-${fade.id}`, `${v}-full`]) {
        const boxes = site.boxes.filter((b) => b.shotId === shotId && b.sectionId === fade.id);
        expect(boxes.filter((b) => b.kind === 'price').map((b) => b.text), shotId).toEqual(['Half revealed: $9 / month', '$9 / month']);
        expect(boxes.filter((b) => b.kind === 'image'), shotId).toHaveLength(1);
        // The card half-way there is 200 px tall. Not measured: the one at opacity 0 (180 px), the one at 0.001 (170 px)
        // and the one at 0.2 in a wrapper at 0.2 (160 px).
        expect(site.blocks.filter((b) => b.shotId === shotId).map((b) => b.h), shotId).toEqual([400]);
      }
    }
  });

  it('takes the wordmark a CSS background paints in the link home as the logo, as an SVG at its size, and not the menu label', () => {
    const { site, dir } = run;
    expect(site.brand.logo).toMatchObject({ file: 'media/logo.svg', kind: 'svg', png: 'media/logo.png', width: 444, height: 100 });
    const svg = readFileSync(join(dir, 'media', 'logo.svg'), 'utf8');
    expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 110 25"/);
    expect(svg).toMatch(/^<svg [^>]* width="111"/);
    expect(svg).toMatch(/^<svg [^>]* height="25"/);
    expect(svg).toContain('d="M40 0H65V25H40Z"');
  });
});

describe('a site that repeats a heading, at the desktop and on the phone, with a menu label alone in its header', () => {
  const run = sharedCapture(() => ({ url: `${fixtureUrl}repeated.html`, extraUrls: [], followDemoLinks: 0 }));

  it('films the k-th phone section with a heading as the k-th desktop one, and gives each shot an id of its own', () => {
    const { site } = run;
    const ids = site.shots.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const fees = site.sections.filter((s) => s.heading === 'Fees');
    expect(fees).toHaveLength(2);
    const prices = (shotId: string): string => site.boxes.filter((b) => b.shotId === shotId && b.kind === 'price').map((b) => b.text).join(' | ');
    for (const v of ['d', 'm']) {
      expect(prices(`${v}-${fees[0]!.id}`), v).toContain('$10 / month');
      expect(prices(`${v}-${fees[0]!.id}`), v).not.toMatch(/\$20|\$30/);
      expect(prices(`${v}-${fees[1]!.id}`), v).toContain('$20 / month');
      expect(prices(`${v}-${fees[1]!.id}`), v).not.toMatch(/\$10|\$30/);
    }
    // The third "Fees" is only on the phone: it has no desktop twin, and no shot.
    expect(site.log.notes).toContain(`${fixtureUrl}repeated.html mobile: 1 sections not present on desktop (skipped for shots)`);
  });

  it('finds no logo rather than take the menu label for one, and says so', () => {
    expect(run.site.brand.logo).toBeUndefined();
    expect(existsSync(join(run.dir, 'media', 'logo.png'))).toBe(false);
    expect(run.site.log.notes).toContain('no logo found in the header');
  });
});

describe('a logo cut by a CSS mask out of the color of the link home', () => {
  const run = sharedCapture(() => ({ url: `${fixtureUrl}mask-logo.html`, extraUrls: [], followDemoLinks: 0 }));

  it('keeps it as a PNG of the link, with the shape in it, and no SVG', () => {
    const { site, dir } = run;
    // The link is 120 x 30 px, shot at DPR 4.
    expect(site.brand.logo).toEqual({ file: 'media/logo.png', kind: 'png', width: 480, height: 120 });
    expect(existsSync(join(dir, 'media', 'logo.svg'))).toBe(false);
    expect(pngHasInk(readFileSync(join(dir, 'media', 'logo.png')))).toBe(true);
  });
});

describe('the logo finder, in a page of its own', () => {
  let browser: Awaited<ReturnType<typeof launchBrowser>>;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  /** The logo the finder reads on a page that is a 120 x 30 px div saying it is the logo, painted from this base64 SVG. */
  const findPainted = async (svg: string) => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<div class="site-logo" style="width: 120px; height: 30px; background: url(data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}) 0 0 / 100% 100%"></div>`);
      await page.evaluate(inPageSetup);
      return await page.evaluate(inPageFindLogo);
    } finally {
      await page.close();
    }
  };

  it('reads an SVG painted from base64 in an element that says it is the logo, at its size, with a viewBox for it to scale', async () => {
    const logo = await findPainted('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="10"><rect width="40" height="10" fill="#c81e6b"/></svg>');
    expect(logo).toMatchObject({ hasText: false, rect: { w: 120, h: 30 } });
    expect(logo?.svg).toMatch(/^<svg [^>]*viewBox="0 0 40 10"/);
    expect(logo?.svg).toMatch(/^<svg [^>]* width="120"/);
    expect(logo?.svg).toMatch(/^<svg [^>]* height="30"/);
    expect(logo?.svg).toContain('<rect width="40" height="10" fill="#c81e6b"/>');
  });

  it('makes the viewBox from a size in px too, and from none in percent, which says nothing of the drawing', async () => {
    const inPx = await findPainted('<svg xmlns="http://www.w3.org/2000/svg" width="40px" height="10.5px"><rect width="40" height="10" fill="#c81e6b"/></svg>');
    expect(inPx?.svg).toMatch(/^<svg [^>]*viewBox="0 0 40 10.5"/);
    expect(inPx?.svg).toMatch(/^<svg [^>]* width="120"/);
    const inPercent = await findPainted('<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><rect width="40" height="10" fill="#c81e6b"/></svg>');
    expect(inPercent?.svg).toMatch(/^<svg [^>]* width="120"/);
    expect(inPercent?.svg).not.toContain('viewBox');
  });
});

describe('a stats band right before a one-word title, and a title shaped like a figure', () => {
  const run = sharedCapture(() => ({ url: `${fixtureUrl}figures.html`, extraUrls: [], followDemoLinks: 0 }));
  const section = (heading: string) => run.site.sections.find((s) => s.heading === heading)!;

  it('opens a section on a one-word title that follows a figure from afar: it is no piece of the figure', () => {
    expect(run.site.sections.map((s) => s.heading)).toEqual(['Payments for every shop', 'Pricing', 'Get started']);
    expect(section('Payments for every shop').text).toBe('One account for cards and transfers.\nMerchants\n10,000+');
    const pricing = section('Pricing');
    expect(run.site.shots.filter((s) => s.sectionId === pricing.id).map((s) => s.viewport)).toEqual(['desktop', 'mobile']);
  });

  // The trade-off of the figure rule: "24/7 support" has the shape of "1 second", and no rule of syntax tells them
  // apart. Its words stay, in the section before it; its section and its shot go.
  it('reads a title shaped like a figure ("24/7 support") as text of the section before it', () => {
    expect(section('Pricing').text).toBe('One plan, no setup fee.\n24/7 support\nSomeone answers every message, day and night.');
  });
});

describe('a scroll stage pinned over the screen that holds only figures, and a cookie banner that comes up late', () => {
  const run = sharedCapture(() => ({ url: `${fixtureUrl}fixed-stage.html`, extraUrls: [], followDemoLinks: 0 }));

  it('keeps the stage on the screen when it films the steps that scroll over it, at both sizes', () => {
    const { site } = run;
    expect(site.log.notes.join(' | ')).not.toMatch(/hid [^|]*stage/);
    const step = site.sections.find((s) => s.heading === 'People pay from their phones')!;
    for (const v of ['d', 'm']) {
      const figures = site.boxes.filter((b) => b.shotId === `${v}-${step.id}` && b.kind === 'heading').map((b) => b.text);
      expect(figures, v).toEqual(expect.arrayContaining(['453K', '$6.2B']));
    }
  });

  it('still hides the banner, whose title is a heading too', () => {
    expect(run.site.log.notes.join(' | ')).toMatch(/hid div#late-cookies/);
    expect(run.site.boxes.some((b) => b.text === 'We use cookies')).toBe(false);
  });
});

describe('a site with a demo page, followed once as a link and once as an extra', () => {
  const run = sharedCapture(() => ({ url: fixtureUrl, extraUrls: [`${fixtureUrl}demo.html#again`], followDemoLinks: 2 }));

  it('keeps the banner and the modal out of the site, and the text of the demo page apart', () => {
    const { site, result } = run;
    const text = JSON.stringify(site.sections);
    expect(text).toContain('Sell on WhatsApp with no fees');
    expect(text).not.toMatch(/cookies|Join our newsletter|Aceitar|Subscribe/);
    // The text of the demo page is kept apart, with the page it came from, and its ids continue the site's.
    expect(site.extraSections).toHaveLength(1);
    expect(site.extraSections[0]).toMatchObject({ heading: 'Demo shop', page: `${fixtureUrl}demo.html` });
    const ids = [...site.sections, ...site.extraSections].map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(site.title).toBe('Tiendita | Sell on WhatsApp');
    expect(site.lang).toBe('en');
    expect(result).toMatchObject({ sections: site.sections.length, shots: site.shots.length });
  });

  it('films the demo page with shots of its own, prefixed x1-, and once even if it is also asked for as an extra', () => {
    const { site, dir } = run;
    const demoShots = site.shots.filter((s) => s.id.startsWith('x1-'));
    expect(demoShots.some((s) => s.viewport === 'desktop')).toBe(true);
    expect(demoShots.some((s) => s.viewport === 'mobile')).toBe(true);
    expect(site.shots.some((s) => s.id.startsWith('x2-'))).toBe(false);
    for (const shot of site.shots) expect(existsSync(join(dir, shot.file)), shot.id).toBe(true);
  });

  it('gives the director a 480 px JPEG of each phone shot but the full-page ones, and the capture file carries them', () => {
    const { site, dir } = run;
    const wanted = site.shots.filter((s) => s.viewport === 'mobile' && !s.id.endsWith('-full')).map((s) => s.id);
    expect(wanted.length).toBeGreaterThan(0);
    expect(wanted.some((id) => id.startsWith('x1-'))).toBe(true);

    const file = buildCaptureFile(dir);
    expect(file.directorImages.map((i) => i.shotId).sort()).toEqual([...wanted].sort());
    const jpeg = Buffer.from(file.directorImages[0]!.jpegBase64, 'base64');
    expect(jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    // The width is in the start-of-frame segment (marker, length, precision, height, width).
    const sof = jpeg.findIndex((byte, i) => byte === 0xff && jpeg[i + 1] === 0xc0);
    expect(jpeg.readUInt16BE(sof + 7)).toBe(480);
    expect(file.site.url).toBe(fixtureUrl);
  });

  it('records the size of the logo raster, so that every render of the video decides the same about it', () => {
    const { site, dir } = run;
    const logo = site.brand.logo!;
    expect(logo.png ?? logo.file).toBe('media/logo.png');
    expect(pngSize(readFileSync(join(dir, 'media', 'logo.png')))).toEqual({ width: logo.width, height: logo.height });
    expect(logo.width).toBeGreaterThan(0);
  });

  it('uses the open font that stands in for a proprietary one, with its file, and says so', () => {
    const { site, dir } = run;
    const display = site.brand.fonts.find((f) => f.role === 'display')!;
    expect(display).toMatchObject({ family: 'Inter', source: 'google', alsoBody: true });
    expect(display.files?.length).toBeGreaterThan(0);
    for (const file of display.files ?? []) expect(existsSync(join(dir, file.file))).toBe(true);
    expect(site.log.notes.join('\n')).toMatch(/Circular Std.*Inter/);
    expect(site.brand.colors.find((c) => c.role === 'primary')?.hex).toBe('#c81e6b');
  });
});

describe('a site that is not asked to follow its links, with an extra page nobody answers and addresses that are not web pages', () => {
  const run = sharedCapture(() => ({ url: fixtureUrl, extraUrls: ['http://127.0.0.1:1/', 'file:///etc/passwd', 'javascript:alert(1)'], followDemoLinks: 0 }));

  it('takes the shots at DPR 2 with the boxes in pixels of the shot', () => {
    const { site, dir } = run;
    const full = site.shots.find((s) => s.id === 'd-full');
    const mobile = site.shots.find((s) => s.viewport === 'mobile');
    expect(full).toMatchObject({ viewport: 'desktop', dpr: 2, width: 2880 });
    expect(mobile).toMatchObject({ viewport: 'mobile', dpr: 2, width: 780, height: 1688 });
    for (const shot of site.shots) expect(existsSync(join(dir, shot.file)), shot.id).toBe(true);

    expect(new Set(site.boxes.map((b) => b.kind))).toEqual(new Set(['heading', 'cta', 'price']));
    for (const box of site.boxes) {
      const shot = site.shots.find((s) => s.id === box.shotId)!;
      expect(box.x + box.w, box.shotId).toBeLessThanOrEqual(shot.width);
      expect(box.y + box.h, box.shotId).toBeLessThanOrEqual(shot.height);
    }
    expect(site.boxes.find((b) => b.kind === 'price')?.text).toBe('$4.990 / mes');
  });

  it('records the cards of a section shot and of the full page as blocks, in pixels of the shot, and nothing that only looks like one', () => {
    const { site } = run;
    const why = site.sections.find((s) => s.heading === 'Why Tiendita')!;
    for (const [v, viewport] of [['m', 'mobile'], ['d', 'desktop']] as const) {
      // The cards sit in the section's padding (32 px) and are 640 px wide at most: 326 px on a 390 px phone.
      const width = viewport === 'mobile' ? 390 - 2 * 32 : 640;
      const fromHeading: number[][] = [];
      for (const shotId of [`${v}-${why.id}`, `${v}-full`]) {
        const blocks = site.blocks.filter((b) => b.shotId === shotId);
        // The bordered card, the one with a shadow and the one with a background of its own, in document order. Not the
        // band as wide as the page, the plain div, the div the color of the section, the 20 px badge, the div whose shadow
        // is transparent, the card stuck to the top of the screen, or the bar fixed to the screen and the card inside it.
        expect(
          blocks.map(({ x, w, h }) => ({ x, w, h })),
          shotId,
        ).toEqual([64, 72, 80].map((h) => ({ x: 32 * 2, w: width * 2, h: h * 2 })));
        const heading = site.boxes.find((b) => b.shotId === shotId && b.kind === 'heading' && b.text === 'Why Tiendita')!;
        fromHeading.push(blocks.map((b) => b.y - heading.y));
      }
      // As far below the heading in the section's shot as in the full page's: the same pixels as the boxes.
      const [inSection = [], inFull = []] = fromHeading;
      inSection.forEach((dy, i) => expect(Math.abs(dy - (inFull[i] ?? Infinity)), viewport).toBeLessThanOrEqual(1));
      expect(inSection[0], viewport).toBeGreaterThan(0);
    }
  });

  it('follows no link when it is not asked to, and leaves out the extra page it cannot reach, saying so', () => {
    const { site } = run;
    expect(site.extraSections).toHaveLength(0);
    expect(site.shots.some((s) => s.id.startsWith('x'))).toBe(false);
    expect(site.log.notes.join('\n')).toMatch(/extra page http:\/\/127\.0\.0\.1:1\/ left out/);
  });

  it('does not open an extra address that is not http or https, and counts it as ignored', () => {
    const notes = run.site.log.notes.join(' | ');
    expect(notes).toContain('2 extra addresses ignored');
    // Not tried as a page either: the only one that was tried and left out is the web address nobody answers.
    expect(notes).not.toMatch(/file:|javascript:/);
    expect(notes.match(/left out/g)).toHaveLength(1);
  });

  it('says whether the metadata server is out of reach (it is, on this machine)', () => {
    expect(run.result).toMatchObject({ ok: true, metadataBlocked: true });
  });
});

describe('a section shot that starts partway through a card', () => {
  const run = sharedCapture(() => ({ url: `${fixtureUrl}clipped.html`, extraUrls: [], followDemoLinks: 0 }));

  it('records the card and the picture that begin above the shot as clipped at its top, and nothing else', () => {
    const { site } = run;
    const section = site.sections.find((s) => s.heading === 'Right under the picture')!;
    for (const v of ['m', 'd'] as const) {
      const shotId = `${v}-${section.id}`;
      const boxes = site.boxes.filter((b) => b.shotId === shotId);
      const blocks = site.blocks.filter((b) => b.shotId === shotId);
      const picture = boxes.find((b) => b.kind === 'image');
      // The card with the picture and the picture in it begin above the top of the screen: the capture keeps their part on
      // it, from y 0, and says that they go on above.
      expect(picture, shotId).toMatchObject({ y: 0, clippedTop: true });
      expect(blocks[0], shotId).toMatchObject({ y: 0, clippedTop: true });
      // The heading and the card under it are whole on the screen.
      expect(boxes.find((b) => b.kind === 'heading')?.clippedTop, shotId).toBeUndefined();
      expect(blocks.slice(1).map((b) => b.clippedTop), shotId).toEqual([undefined]);
      // The full page has them whole.
      const full = [...site.boxes, ...site.blocks].filter((r) => r.shotId === `${v}-full`);
      expect(full.length, `${v}-full`).toBeGreaterThan(0);
      expect(full.filter((r) => r.clippedTop), `${v}-full`).toEqual([]);
    }
  });
});

describe('a scrollytelling stage and a popup that comes up late', () => {
  const run = sharedCapture(() => ({ url: `${fixtureUrl}stage.html`, extraUrls: [], followDemoLinks: 0 }));

  it('reads the section on the sticky stage, at the desktop and at the phone, and not the popup', () => {
    const headings = run.site.sections.map((s) => s.heading);
    expect(headings).toEqual(expect.arrayContaining(['A story told by scrolling', 'Pinned story', 'After the story']));
    expect(headings).not.toContain('Last chance');
  });

  it('films the stage with its heading on the screen in the shots of its section, at both sizes', () => {
    const { site } = run;
    const stage = site.sections.find((s) => s.heading === 'Pinned story')!;
    for (const prefix of ['d-', 'm-']) {
      const shot = site.shots.find((s) => s.id.startsWith(prefix) && s.sectionId === stage.id);
      expect(shot, `a ${prefix} shot of the stage`).toBeDefined();
      const heading = site.boxes.find((b) => b.shotId === shot?.id && b.kind === 'heading' && b.text === 'Pinned story');
      expect(heading, `the heading of the stage in ${shot?.id}`).toBeDefined();
    }
  });

  it('hides the popup when it films, and says so, without touching the stage', () => {
    const { site } = run;
    const notes = site.log.notes.join(' | ');
    expect(notes).toContain('overlay removed');
    expect(notes).toMatch(/hid div#late-offer/);
    expect(notes).not.toContain('.stage');
    // Nothing of the popup is in any shot: no box of its heading.
    expect(site.boxes.some((b) => b.text === 'Last chance')).toBe(false);
  });
});
