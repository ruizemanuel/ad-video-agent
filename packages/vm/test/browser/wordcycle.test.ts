// Opt-in (`pnpm --filter @app/vm test:browser`): renders frames of a WordCycle in a real Chrome and reads the pixels, to see
// that its mask never cuts the ink of a word (a flat-cut baseline or descender is the failure) and that the word rolling
// out never draws over the prefix. It needs the network (the brand's fonts come from Google Fonts, as the capture gets
// them) and ffmpeg on the PATH (it turns the PNG of a frame into pixels). The bundle is the Ad's, with a measure beside it
// (support/wordcycle-entry.tsx) that reports the rectangle each probed line is clipped to.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundle } from '@remotion/bundler';
import { openBrowser, renderStill, selectComposition } from '@remotion/renderer';
import { FORMATS, layoutScenes, type Edl, type SiteData, type SiteFont, type TimedScene } from '@app/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveFont } from '../../src/capture/fonts';
import { runFfmpeg } from '../../src/render/ffmpeg';
import { wordEnterFrame } from '../../src/video/rhythm';
import { readClips, type ClippedLine, type Rect } from './support/clips';

const BPM = 90;
const PREFIX = 'play with';
// Words with deep descenders ("Pago": g; "playa": p and y), and a third so that the cycle goes on. "Pago" starts under the
// p of the prefix, whose descender hangs down into the mask: the word that rolls out rises right through it.
const WORDS = ['Pago', 'playa', 'links'];
const BG = '#fbf7f4';
const FG = '#1a1614';
const ACCENT = '#c81e6b';

const edl: Edl = {
  lang: 'en',
  bpm: BPM,
  style: { energy: 'bold', density: 'airy' },
  hooks: [[{ piece: 'WordCycle', beats: 8, lines: [PREFIX, ...WORDS].map((text) => ({ text, kind: 'framing' as const })) }]],
  body: [],
  cta: { piece: 'EndCard', beats: 4, lines: [{ text: 'Start', kind: 'framing' }] },
  claims: [],
  musicPrompt: 'Upbeat electronic pop.',
};
// The scene is the first of the video, so its frames are the video's.
let timed: TimedScene;
/** The frame at which word k is at rest: settled, and before the next one comes in. */
const restFrame = (k: number): number => wordEnterFrame(k, timed, BPM) + 12;

const siteWith = (font: SiteFont, lineHeight: number): SiteData => ({
  url: 'https://x.example/',
  lang: 'en',
  title: 'X',
  description: '',
  sections: [],
  brand: {
    colors: [
      { hex: BG, role: 'bg', weight: 1 },
      { hex: FG, role: 'text', weight: 1 },
      { hex: ACCENT, role: 'primary', weight: 1 },
    ],
    fonts: [{ ...font, weight: '700', letterSpacingEm: -0.02, lineHeight }],
  },
  shots: [],
  boxes: [],
  recordings: [],
});

const channels = (hex: string): number[] => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));

type Shot = { rgb: Buffer; width: number; lines: ClippedLine[] };

let dir: string;
let work: string;
let serveUrl: string;
let browser: Awaited<ReturnType<typeof openBrowser>>;
const fonts: Record<string, SiteFont> = {};
let shots = 0;

/** The frame of the video of `site` as pixels (RGB), with the lines the measure found in it. */
async function shoot(site: SiteData, frame: number): Promise<Shot> {
  const inputProps = { edl, site, format: '9x16', hook: 0 };
  const composition = await selectComposition({ serveUrl, id: 'wordcycle', inputProps, puppeteerInstance: browser });
  const png = join(work, `${shots}.png`);
  const raw = join(work, `${shots++}.rgb`);
  let lines: ClippedLine[] | undefined;
  await renderStill({
    composition,
    serveUrl,
    output: png,
    frame,
    inputProps,
    imageFormat: 'png',
    puppeteerInstance: browser,
    onBrowserLog: (log) => {
      lines = readClips(log.text, frame) ?? lines;
    },
  });
  if (!lines) throw new Error(`Frame ${frame} came out without its lines measured.`);
  await runFfmpeg(['-v', 'error', '-y', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw], 'read the pixels of a frame');
  return { rgb: readFileSync(raw), width: composition.width, lines };
}

const lineOf = (shot: Shot, text: string): ClippedLine => {
  const line = shot.lines.find((l) => l.text === text);
  if (!line) throw new Error(`The frame has no line "${text}": it has ${shot.lines.map((l) => `"${l.text}"`).join(', ')}.`);
  return line;
};

/** The first and last rows of the rectangle that have ink of the accent color (at least a fifth covered) in them. */
function accentRows(shot: Shot, rect: Rect): { first: number; last: number } | undefined {
  const [bgR = 0, bgG = 0] = channels(BG);
  let first: number | undefined;
  let last: number | undefined;
  for (let y = Math.floor(rect.y); y < Math.ceil(rect.y + rect.h); y++) {
    for (let x = Math.floor(rect.x); x < Math.ceil(rect.x + rect.w); x++) {
      const at = (y * shot.width + x) * 3;
      // The accent is pink: red well above green, as the background and the dark prefix are not.
      if (shot.rgb[at]! - shot.rgb[at + 1]! - (bgR - bgG) > 30) {
        first ??= y;
        last = y;
        break;
      }
    }
  }
  return first === undefined || last === undefined ? undefined : { first, last };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wordcycle-run-'));
  work = mkdtempSync(join(tmpdir(), 'wordcycle-work-'));
  for (const family of ['Inter', 'Oswald']) fonts[family] = await resolveFont(family, 'display', { fontFaceSrcs: [], stylesheets: [] }, { outDir: dir });
  timed = layoutScenes(edl, 0).scenes[0]!;
  serveUrl = await bundle({ entryPoint: join(import.meta.dirname, 'support', 'wordcycle-entry.tsx'), publicDir: dir });
  browser = await openBrowser('chrome');
});
afterAll(async () => {
  await browser?.close({ silent: true }).catch(() => {});
  if (serveUrl) rmSync(serveUrl, { recursive: true, force: true });
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (work) rmSync(work, { recursive: true, force: true });
});

// The line heights are the theme's: 1.12 is the most it allows (a heading set with line-height normal, as the fixture
// site's, asks for 1.2) and 0.94 the least, where the glyphs reach furthest past the line box: Oswald's descenders go
// 0.19 em past it, more than the 0.16 em of room a mask has at least.
const CASES: [family: string, lineHeight: number][] = [
  ['Inter', 1.12],
  ['Inter', 0.94],
  ['Oswald', 0.94],
];

describe('the mask of a WordCycle', () => {
  describe.each(CASES)('in %s at line height %s', (family, lineHeight) => {
    it.each([
      ['Pago', 0],
      ['playa', 1],
    ] as const)('leaves room around the ink of "%s" at rest', async (word, k) => {
      const shot = await shoot(siteWith(fonts[family]!, lineHeight), restFrame(k));
      const { clip } = lineOf(shot, word);
      expect(clip, 'the mask').not.toBeNull();
      const rows = accentRows(shot, clip!);
      expect(rows, `the ink of "${word}"`).toBeDefined();
      // The clip's own first and last rows: a glyph that is cut has ink on the last one.
      const firstRow = Math.floor(clip!.y);
      const lastRow = Math.ceil(clip!.y + clip!.h) - 1;
      expect(rows!.last, `the last row of ink, in a mask that ends on row ${lastRow}`).toBeLessThan(lastRow);
      expect(rows!.first, `the first row of ink, in a mask that starts on row ${firstRow}`).toBeGreaterThan(firstRow);
    });
  });

  describe.each(CASES)('in %s at line height %s, the layout', (family, lineHeight) => {
    it('keeps the text where the Ad has always set it: the prefix, and under it the word', async () => {
      const shot = await shoot(siteWith(fonts[family]!, lineHeight), restFrame(0));
      const prefix = lineOf(shot, PREFIX).box;
      const word = lineOf(shot, WORDS[0]!).box;
      const size = word.h / lineHeight;
      const { safe, height } = FORMATS['9x16'];
      // The block is centered in the safe zone: the prefix and the slot of the mask, which is its line less 0.16 em (the
      // word hangs under it), whatever room the mask has. The word is 0.14 em under the prefix, where the room above is.
      const top = safe.top + (height - safe.top - safe.bottom - (2 * lineHeight - 0.16) * size) / 2;
      expect(prefix.y).toBeCloseTo(top, 0);
      expect(word.y).toBeCloseTo(top + (lineHeight + 0.14) * size, 0);
    });
  });

  describe('against the prefix', () => {
    const site = () => siteWith(fonts['Inter']!, 0.94);

    it('starts under the prefix line, so that the word rolling out never reaches the prefix glyphs', async () => {
      const shot = await shoot(site(), restFrame(0));
      const prefix = lineOf(shot, PREFIX);
      const mask = lineOf(shot, WORDS[0]!).clip!;
      expect(mask.y).toBeGreaterThanOrEqual(prefix.box.y + prefix.box.h - 0.5);
    });

    it('never draws the word rolling out over the ink of the prefix, descenders included', async () => {
      const [fgR = 0, fgG = 0] = channels(FG);
      const before = await shoot(site(), wordEnterFrame(0, timed, BPM) - 1);
      const prefix = lineOf(before, PREFIX).box;
      // The core of the prefix's glyphs (not the antialiased edge, which the pink behind it would tint), with room below for its descenders.
      const covered = (shot: Shot): number => {
        let changed = 0;
        for (let y = Math.floor(prefix.y); y < Math.ceil(prefix.y + prefix.h * 1.3); y++) {
          for (let x = Math.floor(prefix.x); x < Math.ceil(prefix.x + prefix.w); x++) {
            const at = (y * shot.width + x) * 3;
            const core = Math.abs(before.rgb[at]! - fgR) + Math.abs(before.rgb[at + 1]! - fgG) < 24;
            const moved = [0, 1, 2].reduce((sum, c) => sum + Math.abs(shot.rgb[at + c]! - before.rgb[at + c]!), 0);
            if (core && moved > 48) changed++;
          }
        }
        return changed;
      };
      // Word 0 rolls out as word 1 rolls in: the frames from just before beat 2, a little longer than the roll lasts.
      const rolling = Array.from({ length: 8 }, (_, i) => wordEnterFrame(1, timed, BPM) - 1 + i);
      for (const frame of rolling) {
        const shot = await shoot(site(), frame);
        expect(covered(shot), `pixels of the prefix drawn over, in frame ${frame}`).toBe(0);
      }
    });
  });
});
