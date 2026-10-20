// Opt-in (`pnpm --filter @app/vm test:browser`): captures the fixture site, bundles the video with the capture as its
// public dir and renders the key frames of a fixture edit list in a real Chrome, with ffmpeg making the JPEGs.
// It needs the network (Google Fonts for the capture) and ffmpeg on the PATH.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkStills, FORMATS, layoutScenes, theme, timedScenePath, validateEdl, type Edl, type Format, type SiteData, type Still } from '@app/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capture, type CapturedSite } from '../../src/capture';
import { getServeUrl } from '../../src/render/bundle';
import { renderKeyframes } from '../../src/render/keyframes';
import { serveFixtureSite } from './support/fixture-site';

/** Captures the fixture site into `dir` and gives back what it wrote to site.json. */
async function captureFixture(dir: string, url: string): Promise<CapturedSite> {
  const result = await capture({ url, extraUrls: [], followDemoLinks: 0 }, dir);
  if (!result.ok) throw new Error(`The capture failed: ${result.message}`);
  return JSON.parse(readFileSync(join(dir, 'site.json'), 'utf8')) as CapturedSite;
}

const sectionIdOf = (site: SiteData, heading: string): string => {
  const section = site.sections.find((s) => s.heading === heading);
  if (!section) throw new Error(`The capture has no section "${heading}".`);
  return section.id;
};

/** A phone shot of a section and the index of one of its boxes, found by kind and text. */
const pickBox = (site: SiteData, kind: 'heading' | 'price', text: string): { shotId: string; boxIndex: number } => {
  for (const shot of site.shots.filter((s) => s.viewport === 'mobile' && !s.id.endsWith('-full'))) {
    const boxIndex = site.boxes.filter((b) => b.shotId === shot.id).findIndex((b) => b.kind === kind && b.text === text);
    if (boxIndex >= 0) return { shotId: shot.id, boxIndex };
  }
  throw new Error(`No phone shot shows the ${kind} "${text}".`);
};

/** An edit list of the fixture site with the five pieces tested first, its claims quoted from the site. */
function makeFixtureEdl(site: SiteData): Edl {
  const sectionId = (heading: string): string => sectionIdOf(site, heading);
  const pick = (kind: 'heading' | 'price', text: string) => pickBox(site, kind, text);
  return {
    lang: 'en',
    bpm: 112,
    style: { energy: 'bold', density: 'airy' },
    hooks: [
      [
        {
          piece: 'UiFocus',
          beats: 6,
          lines: [{ text: 'Everything in one plan', kind: 'claim', claimId: 'c3', accent: 'one plan' }],
          // A UI scene films product UI (see isProductTarget): the fixture site has no image, and its only price is in the pricing section.
          ...pick('price', '$4.990 / mes'),
        },
      ],
    ],
    body: [
      {
        piece: 'ClaimStack',
        beats: 6,
        lines: [
          { text: '0% commission', kind: 'claim', claimId: 'c2', accent: '0%' },
          { text: 'Cards, transfers and cash', kind: 'claim', claimId: 'c4' },
        ],
        transitionIn: 'wipe',
      },
      {
        piece: 'UiScroll',
        beats: 7,
        lines: [
          { text: 'Pro plan: $4.990 / mes', kind: 'claim', claimId: 'c3', accent: '$4.990 / mes' },
          { text: 'Everything included', kind: 'claim', claimId: 'c3', atBeat: 4 },
        ],
        ...pick('price', '$4.990 / mes'),
      },
      {
        piece: 'KineticHeadline',
        beats: 6,
        lines: [
          { text: 'Your shop', kind: 'framing' },
          { text: 'in one link.', kind: 'framing', accent: 'one link' },
        ],
      },
    ],
    cta: { piece: 'EndCard', beats: 5, lines: [{ text: 'Start free', kind: 'framing' }], transitionIn: 'wipe' },
    claims: [
      { id: 'c2', text: 'No commission on sales.', sectionId: sectionId('Why Tiendita'), quote: '0% commission on every sale' },
      { id: 'c3', text: 'The Pro plan costs $4.990 a month and has everything.', sectionId: sectionId('Simple pricing'), quote: 'The Pro plan is $4.990 / mes and has everything.' },
      { id: 'c4', text: 'It takes cards, transfers and cash.', sectionId: sectionId('Every payment method'), quote: 'Cards, transfers and cash on delivery' },
    ],
    musicPrompt: 'Upbeat electronic pop, bright synths, steady four-on-the-floor drums.',
  };
}

/**
 * An edit list of the fixture site with the new pieces: a typed address (and, as hook 1, a typed question; hook 2 opens
 * on a headline under the brand), a word cycle, a UI scene whose caption is replaced on a beat, a headline whose lines
 * come in on the beat, and the close in two steps with a tagline.
 */
function makeNewPiecesEdl(site: SiteData): Edl {
  const host = new URL(site.url).hostname.replace(/^www\./, '');
  const hero = sectionIdOf(site, 'Sell on WhatsApp with no fees');
  return {
    lang: 'en',
    bpm: 112,
    style: { energy: 'bold', density: 'airy' },
    hooks: [
      [{ piece: 'TypeIn', beats: 4, variant: 'url', lines: [{ text: host, kind: 'framing' }] }],
      [{ piece: 'TypeIn', beats: 4, variant: 'prompt', lines: [{ text: 'Where do my customers pay me?', kind: 'framing' }] }],
      [{ piece: 'KineticHeadline', beats: 4, lines: [{ text: 'Sell on WhatsApp', kind: 'framing' }, { text: 'with no fees.', kind: 'framing', accent: 'no fees' }] }],
    ],
    body: [
      {
        piece: 'WordCycle',
        beats: 6,
        lines: [
          { text: 'Get paid with', kind: 'framing' },
          { text: 'cards', kind: 'claim', claimId: 'c4' },
          { text: 'transfers', kind: 'claim', claimId: 'c4' },
          { text: 'cash', kind: 'claim', claimId: 'c4' },
        ],
        transitionIn: 'wipe',
      },
      {
        piece: 'UiFocus',
        beats: 8,
        lines: [
          { text: 'One plan, everything in it', kind: 'claim', claimId: 'c3', accent: 'everything in it' },
          { text: 'Priced at $4.990 / mes', kind: 'claim', claimId: 'c3', atBeat: 4 },
        ],
        // The fixture site has no image, and its only price is in the pricing section: a UI scene films product UI.
        ...pickBox(site, 'price', '$4.990 / mes'),
      },
      {
        piece: 'KineticHeadline',
        beats: 6,
        lines: [
          { text: 'Your shop', kind: 'framing' },
          { text: 'in one link.', kind: 'framing', accent: 'one link' },
          { text: 'Today.', kind: 'framing' },
        ],
      },
    ],
    cta: {
      piece: 'EndCard',
      beats: 6,
      lines: [
        { text: 'Start free', kind: 'framing' },
        { text: 'Your shop in one link.', kind: 'claim', claimId: 'c6' },
      ],
      transitionIn: 'wipe',
    },
    claims: [
      { id: 'c3', text: 'The Pro plan costs $4.990 a month and has everything.', sectionId: sectionIdOf(site, 'Simple pricing'), quote: 'The Pro plan is $4.990 / mes and has everything.' },
      { id: 'c4', text: 'It takes cards, transfers and cash.', sectionId: sectionIdOf(site, 'Every payment method'), quote: 'Cards, transfers and cash on delivery' },
      { id: 'c6', text: 'The shop is one link.', sectionId: hero, quote: 'Your shop in one link.' },
    ],
    musicPrompt: 'Upbeat electronic pop, bright synths, steady four-on-the-floor drums.',
  };
}

/** The texts the probe measured in the stills of a scene. */
const textsOf = (stills: Still[], path: string): string[] => stills.filter((s) => s.path === path).flatMap((s) => s.text.map((t) => t.text));

/** `#rrggbb` as Chrome writes a computed color. */
const cssRgb = (hex: string): string => `rgb(${[1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).join(', ')})`;

// Logos written into the capture before the bundle copies it: one of ordinary proportions (8:3), and one so small
// (100x60 px) that the close would enlarge it 4.5 times, while the opening, 84 px high, would not even double it.
const MARK_FILE = 'media/test-mark.svg';
const markSvg = (width: number, height: number): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 320 120"><circle cx="60" cy="60" r="48" fill="#c81e6b"/><rect x="130" y="38" width="170" height="44" rx="22" fill="#1a1614"/></svg>`;
const SMALL_MARK_FILE = 'media/small-mark.svg';

const jpegWidth = (base64: string): number => {
  const jpeg = Buffer.from(base64, 'base64');
  // The width is in the start-of-frame segment (marker, length, precision, height, width).
  const sof = jpeg.findIndex((byte, i) => byte === 0xff && jpeg[i + 1] === 0xc0);
  return jpeg.readUInt16BE(sof + 7);
};

let fixture: Awaited<ReturnType<typeof serveFixtureSite>>;
let dir: string;
let site: CapturedSite;
let edl: Edl;
/** The bundle the tests made, removed at the end. */
let bundleDir: string | undefined;

beforeAll(async () => {
  fixture = await serveFixtureSite();
  dir = mkdtempSync(join(tmpdir(), 'stills-'));
  site = await captureFixture(dir, fixture.url);
  // The bundle copies the run folder when it is made: the extra logo goes in before the first render.
  writeFileSync(join(dir, MARK_FILE), markSvg(320, 120));
  writeFileSync(join(dir, SMALL_MARK_FILE), markSvg(100, 60));
  edl = makeFixtureEdl(site);
});
afterAll(async () => {
  await fixture?.close();
  if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('the key frames of the video', () => {
  let stills: Still[];
  beforeAll(async () => {
    stills = await renderKeyframes({ edl, site, runDir: dir, format: '9x16', hook: 0 });
    // The one bundle renderKeyframes made for this run folder.
    bundleDir = await getServeUrl(dir);
  });

  it('starts from an edit list the site backs', () => {
    expect(validateEdl(edl, site)).toEqual([]);
  });

  it('renders every scene of a fixture EDL in 9x16 and the stills pass the code checks', () => {
    const { scenes } = layoutScenes(edl, 0);
    expect(new Set(stills.map((s) => s.index))).toEqual(new Set(scenes.map((s) => s.index)));
    expect(checkStills(stills, edl, site, '9x16').filter((c) => !c.pass)).toEqual([]);
  });

  it('labels each still with its scene, and takes the scene whose caption is replaced twice', () => {
    const { scenes } = layoutScenes(edl, 0);
    for (const still of stills) {
      const timed = scenes[still.index]!;
      expect(still).toMatchObject({ role: timed.role, piece: timed.scene.piece, path: timedScenePath(edl, 0, timed) });
      expect(still.frame).toBeGreaterThanOrEqual(timed.from);
      expect(still.frame).toBeLessThan(timed.from + timed.duration);
    }
    expect(stills.filter((s) => s.path === 'body[1]')).toHaveLength(2);
  });

  it('measures the text of every frame and makes each picture a JPEG 720 px wide', () => {
    for (const still of stills) {
      expect(still.text.length, still.path).toBeGreaterThan(0);
      expect(jpegWidth(still.jpegBase64), still.path).toBe(720);
    }
  });
});

describe('the other formats', () => {
  it.each(['16x9', '4x5'] as Format[])('renders every scene in %s and the stills pass the code checks', async (format) => {
    const stills = await renderKeyframes({ edl, site, runDir: dir, format, hook: 0 });
    expect(stills.length).toBeGreaterThanOrEqual(layoutScenes(edl, 0).scenes.length);
    expect(checkStills(stills, edl, site, format).filter((c) => !c.pass)).toEqual([]);
  });

  it('registers one composition per format, at its size and the length of the edit list', async () => {
    const { selectComposition } = await import('@remotion/renderer');
    const serveUrl = await getServeUrl(dir);
    for (const format of ['9x16', '16x9', '4x5'] as Format[]) {
      const composition = await selectComposition({ serveUrl, id: `ad-${format}`, inputProps: { edl, site, format, hook: 0 } });
      expect(composition).toMatchObject({ width: FORMATS[format].width, height: FORMATS[format].height, fps: 30, durationInFrames: layoutScenes(edl, 0).total });
    }
  });
});

describe('the new pieces and the rhythm', () => {
  let pieces: Edl;
  let stills: Still[];
  beforeAll(async () => {
    pieces = makeNewPiecesEdl(site);
    stills = await renderKeyframes({ edl: pieces, site, runDir: dir, format: '9x16', hook: 0 });
  });

  it('starts from an edit list the site backs', () => {
    expect(validateEdl(pieces, site)).toEqual([]);
  });

  it('renders a typed address, a word cycle, a caption replaced on its beat and the close in two steps in 9x16, and the stills pass the code checks', () => {
    expect(checkStills(stills, pieces, site, '9x16').filter((c) => !c.pass)).toEqual([]);
    // One still per text a scene shows: three words, two captions.
    expect(stills.map((s) => s.path)).toEqual(['hooks[0][0]', 'body[0]', 'body[0]', 'body[0]', 'body[1]', 'body[1]', 'body[2]', 'cta']);
    expect(textsOf(stills, 'body[0]')).toEqual(['Get paid with', 'cards', 'Get paid with', 'transfers', 'Get paid with', 'cash']);
    expect(stills.filter((s) => s.path === 'body[1]').map((s) => s.text.map((t) => t.text).join(' '))).toEqual([
      'One plan, everything in it',
      'Priced at $4.990 / mes',
    ]);
    expect(textsOf(stills, 'body[2]')).toEqual(['Your shop', 'in one link.', 'Today.']);
  });

  it('types the whole address by the settled frame', () => {
    expect(textsOf(stills, 'hooks[0][0]')).toEqual([new URL(site.url).hostname]);
  });

  it('closes on the brand name, in the heading font and the brand color, when the logo is a whole text header', () => {
    const close = stills.find((s) => s.path === 'cta')!;
    expect(close.text.map((t) => t.text)).toEqual(['Tiendita', 'Your shop in one link.', 'Start free', new URL(site.url).hostname]);
    const { display, accentText } = theme(site);
    const name = close.text[0]!;
    expect(name.font.startsWith(display.family)).toBe(true);
    expect(name.colors).toEqual([cssRgb(accentText)]);
  });

  it('closes on the logo when it reads', async () => {
    const withMark: SiteData = { ...site, brand: { ...site.brand, logo: { file: MARK_FILE, kind: 'svg' } } };
    const close = (await renderKeyframes({ edl: pieces, site: withMark, runDir: dir, format: '9x16', hook: 0 })).find((s) => s.path === 'cta')!;
    expect(close.text.map((t) => t.text)).toEqual(['Your shop in one link.', 'Start free', new URL(site.url).hostname]);
  });

  it('opens on the brand name over the headline when the logo is a whole text header, and on the logo when it reads', async () => {
    const opening = (await renderKeyframes({ edl: pieces, site, runDir: dir, format: '9x16', hook: 2 })).filter((s) => s.path === 'hooks[2][0]');
    expect(checkStills(opening, pieces, site, '9x16', 2).filter((c) => !c.pass)).toEqual([]);
    expect(textsOf(opening, 'hooks[2][0]')).toEqual(['Tiendita', 'Sell on WhatsApp', 'with no fees.']);
    const withMark: SiteData = { ...site, brand: { ...site.brand, logo: { file: MARK_FILE, kind: 'svg' } } };
    const marked = await renderKeyframes({ edl: pieces, site: withMark, runDir: dir, format: '9x16', hook: 2 });
    expect(textsOf(marked, 'hooks[2][0]')).toEqual(['Sell on WhatsApp', 'with no fees.']);
  });

  it('decides once whether the video shows the logo: a logo too small for the close is the name at the opening too', async () => {
    const small: SiteData = { ...site, brand: { ...site.brand, logo: { file: SMALL_MARK_FILE, kind: 'svg', width: 100, height: 60 } } };
    const stills = await renderKeyframes({ edl: pieces, site: small, runDir: dir, format: '9x16', hook: 2 });
    expect(textsOf(stills, 'hooks[2][0]')[0]).toBe('Tiendita');
    expect(textsOf(stills, 'cta')[0]).toBe('Tiendita');
  });

  it('fails the render, rather than closing on the name in some frames, when the logo cannot be loaded', async () => {
    const broken: SiteData = { ...site, brand: { ...site.brand, logo: { file: 'media/missing-logo.png', kind: 'png' } } };
    await expect(renderKeyframes({ edl: pieces, site: broken, runDir: dir, format: '9x16', hook: 0 })).rejects.toThrow(/logo/);
  });

  it.each(['distribuidoradelnorte.com.ar', 'distribuidoradelnorte-mayorista.com.ar'])('keeps the long address %s whole and inside the safe zone, typed and under the button of the close', async (host) => {
    const long: SiteData = { ...site, url: `https://www.${host}/` };
    const edl = makeNewPiecesEdl(long);
    expect(validateEdl(edl, long)).toEqual([]);
    const stills = await renderKeyframes({ edl, site: long, runDir: dir, format: '9x16', hook: 0 });
    expect(checkStills(stills, edl, long, '9x16').filter((c) => !c.pass)).toEqual([]);
    expect(textsOf(stills, 'hooks[0][0]')).toEqual([host]);
    expect(textsOf(stills, 'cta')).toContain(host);
  });

  it('renders a typed question as hook 1 and its stills pass the code checks', async () => {
    const hook1 = await renderKeyframes({ edl: pieces, site, runDir: dir, format: '9x16', hook: 1 });
    expect(checkStills(hook1, pieces, site, '9x16', 1).filter((c) => !c.pass)).toEqual([]);
    expect(textsOf(hook1, 'hooks[1][0]').join(' ')).toBe('Where do my customers pay me?');
  });
});
