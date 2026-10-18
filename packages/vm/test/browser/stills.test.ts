// Opt-in (`pnpm --filter @app/vm test:browser`): captures the fixture site, bundles the video with the capture as its
// public dir and renders the key frames of a fixture edit list in a real Chrome, with ffmpeg making the JPEGs.
// It needs the network (Google Fonts for the capture) and ffmpeg on the PATH.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkStills, FORMATS, layoutScenes, timedScenePath, validateEdl, type Edl, type Format, type SiteData, type Still } from '@app/core';
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

/** An edit list of the fixture site with the five pieces of this task, its claims quoted from the site. */
function makeFixtureEdl(site: SiteData): Edl {
  const sectionId = (heading: string): string => {
    const section = site.sections.find((s) => s.heading === heading);
    if (!section) throw new Error(`The capture has no section "${heading}".`);
    return section.id;
  };
  /** A phone shot of a section and the index of one of its boxes, found by kind and text. */
  const pick = (kind: 'heading' | 'price', text: string): { shotId: string; boxIndex: number } => {
    for (const shot of site.shots.filter((s) => s.viewport === 'mobile' && !s.id.endsWith('-full'))) {
      const boxIndex = site.boxes.filter((b) => b.shotId === shot.id).findIndex((b) => b.kind === kind && b.text === text);
      if (boxIndex >= 0) return { shotId: shot.id, boxIndex };
    }
    throw new Error(`No phone shot shows the ${kind} "${text}".`);
  };
  return {
    lang: 'en',
    bpm: 112,
    style: { energy: 'bold', density: 'airy' },
    hooks: [
      [
        {
          piece: 'UiFocus',
          beats: 6,
          lines: [{ text: 'Sell on WhatsApp with no fees', kind: 'claim', claimId: 'c1', accent: 'no fees' }],
          ...pick('heading', 'Sell on WhatsApp with no fees'),
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
      { id: 'c1', text: 'Tiendita sells on WhatsApp with no fees.', sectionId: sectionId('Sell on WhatsApp with no fees'), quote: 'Sell on WhatsApp with no fees' },
      { id: 'c2', text: 'No commission on sales.', sectionId: sectionId('Why Tiendita'), quote: '0% commission on every sale' },
      { id: 'c3', text: 'The Pro plan costs $4.990 a month and has everything.', sectionId: sectionId('Simple pricing'), quote: 'The Pro plan is $4.990 / mes and has everything.' },
      { id: 'c4', text: 'It takes cards, transfers and cash.', sectionId: sectionId('Every payment method'), quote: 'Cards, transfers and cash on delivery' },
    ],
    musicPrompt: 'Upbeat electronic pop, bright synths, steady four-on-the-floor drums.',
  };
}

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
