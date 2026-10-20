// Opt-in (`pnpm --filter @app/vm test:browser`): renders frames of a WordCycle, and of a headline set the way every piece
// sets its lines (TypeLines), in a real Chrome and reads the pixels, to see that their clips never cut the ink of a word
// (a flat-cut baseline or descender is the failure), that the word rolling out never draws over the prefix and that the
// prefix does not climb over the wipe that follows. It needs the network (the brand's fonts come from Google Fonts, as the capture gets
// them) and ffmpeg on the PATH (it turns the PNG of a frame into pixels). The bundle is the Ad's, with a measure beside it
// (support/wordcycle-entry.tsx) that reports the rectangle each probed line is clipped to.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundle } from '@remotion/bundler';
import { openBrowser, renderStill, selectComposition } from '@remotion/renderer';
import { beatsToFrames, FORMATS, layoutScenes, settledFrame, type Edl, type SiteData, type SiteFont, type TimedScene } from '@app/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveFont } from '../../src/capture/fonts';
import { runFfmpeg } from '../../src/render/ffmpeg';
import { wordEnterFrame } from '../../src/video/rhythm';
import { ROOM } from '../../src/video/type';
import { readClips, type ClippedLine, type Rect } from './support/clips';

const BPM = 90;
const PREFIX = 'play with';
// Three words over 8 beats: each holds 2 beats (they come in on beats 1, 3 and 5) and the last keeps the rest of the scene.
// Words with deep descenders ("Pago": g; "playa": p and y), and a third so that the cycle goes on. "Pago" starts under the
// p of the prefix, whose descender hangs down into the mask: the word that rolls out rises right through it.
const WORDS = ['Pago', 'playa', 'links'];
const HEADLINE = ['Pago playa', 'links hoy', 'gypsy jazz'];
const BG = '#fbf7f4';
const FG = '#1a1614';
const ACCENT = '#c81e6b';

const edl: Edl = {
  lang: 'en',
  bpm: BPM,
  style: { energy: 'bold', density: 'airy' },
  hooks: [[{ piece: 'WordCycle', beats: 8, lines: [PREFIX, ...WORDS].map((text) => ({ text, kind: 'framing' as const })) }]],
  // The headline has three lines, so that the last has no line under it; its scene comes in with the brand wipe.
  body: [{ piece: 'KineticHeadline', beats: 8, lines: HEADLINE.map((text) => ({ text, kind: 'framing' as const })), transitionIn: 'wipe' }],
  cta: { piece: 'EndCard', beats: 4, lines: [{ text: 'Start', kind: 'framing' }] },
  claims: [],
  musicPrompt: 'Upbeat electronic pop.',
};
// The WordCycle is the first scene of the video, so its frames are the video's; the headline's scene follows it.
let timed: TimedScene;
let headline: TimedScene;
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

/** The frame of the video of `site` (of `scenes`, the edit list of the test unless another is given) as pixels (RGB), with the lines the measure found in it. */
async function shoot(site: SiteData, frame: number, scenes: Edl = edl): Promise<Shot> {
  const inputProps = { edl: scenes, site, format: '9x16', hook: 0 };
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

/**
 * The boxes of the lines of a headline at rest are a line height and 0.14 em of the one before apart, and the block they
 * make is centered in the safe zone, whatever room each line's clip has for its ink.
 */
const expectLinesSet = (boxes: Rect[], lineHeight: number): void => {
  const size = boxes[0]!.h / lineHeight;
  const { safe, height } = FORMATS['9x16'];
  const block = (boxes.length * lineHeight + (boxes.length - 1) * 0.14) * size;
  const top = safe.top + (height - safe.top - safe.bottom - block) / 2;
  boxes.forEach((box, i) => expect(box.y, `line ${i}`).toBeCloseTo(top + i * (lineHeight + 0.14) * size, 0));
};

type Pixel = (r: number, g: number, b: number) => boolean;

const [bgR = 0, bgG = 0, bgB = 0] = channels(BG);
// The accent is pink: red well above green, as the background and the dark text are not (at least a fifth covered).
const isAccent: Pixel = (r, g) => r - g - (bgR - bgG) > 30;
// Anything but the background, at least a seventh covered by dark text or by the accent.
const isInk: Pixel = (r, g, b) => Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB) > 100;

/** The first and last rows of the rectangle that have a pixel `ink` accepts in them, and how many pixels of the rectangle there are. */
function inkRows(shot: Shot, rect: Rect, ink: Pixel): { first: number; last: number; count: number } | undefined {
  let first: number | undefined;
  let last: number | undefined;
  let count = 0;
  for (let y = Math.floor(rect.y); y < Math.ceil(rect.y + rect.h); y++) {
    for (let x = Math.floor(rect.x); x < Math.ceil(rect.x + rect.w); x++) {
      const at = (y * shot.width + x) * 3;
      if (!ink(shot.rgb[at]!, shot.rgb[at + 1]!, shot.rgb[at + 2]!)) continue;
      first ??= y;
      last = y;
      count++;
    }
  }
  return first === undefined || last === undefined ? undefined : { first, last, count };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wordcycle-run-'));
  work = mkdtempSync(join(tmpdir(), 'wordcycle-work-'));
  for (const family of ['Inter', 'Oswald']) fonts[family] = await resolveFont(family, 'display', { fontFaceSrcs: [], stylesheets: [] }, { outDir: dir });
  [timed, headline] = layoutScenes(edl, 0).scenes as [TimedScene, TimedScene];
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

describe('the clips of a WordCycle and of the lines of a headline', () => {
  describe.each(CASES)('in %s at line height %s', (family, lineHeight) => {
    it.each([
      ['Pago', 0],
      ['playa', 1],
    ] as const)('leaves room around the ink of "%s" at rest', async (word, k) => {
      const shot = await shoot(siteWith(fonts[family]!, lineHeight), restFrame(k));
      const { clip } = lineOf(shot, word);
      expect(clip, 'the mask').not.toBeNull();
      const rows = inkRows(shot, clip!, isAccent);
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

  describe('the hold of the words', () => {
    // The cycle starts the video, so a beat of the video is a frame of the scene.
    const beat = (b: number): number => beatsToFrames(b, BPM);
    const wordsOn = async (frame: number): Promise<string[]> => {
      const shot = await shoot(siteWith(fonts['Inter']!, 1.12), frame);
      return shot.lines.map((line) => line.text).filter((text) => WORDS.includes(text));
    };

    it('keeps each word on screen until its two beats are over, and the last one to the end of the scene', async () => {
      expect(await wordsOn(beat(1) - 1), 'before beat 1').toEqual([]);
      expect(await wordsOn(beat(1) + 12), 'word 0, in on beat 1').toEqual(['Pago']);
      expect(await wordsOn(beat(3) - 1), 'word 0, the frame before beat 3').toEqual(['Pago']);
      expect(await wordsOn(beat(3) + 12), 'word 1, in on beat 3').toEqual(['playa']);
      expect(await wordsOn(beat(5) - 1), 'word 1, the frame before beat 5').toEqual(['playa']);
      expect(await wordsOn(beat(5) + 12), 'word 2, in on beat 5').toEqual(['links']);
      expect(await wordsOn(timed.duration - 1), 'word 2, the last frame of the scene').toEqual(['links']);
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
      // Word 0 rolls out as word 1 rolls in: the frames from just before its beat (3), a little longer than the roll lasts.
      const rolling = Array.from({ length: 8 }, (_, i) => wordEnterFrame(1, timed, BPM) - 1 + i);
      for (const frame of rolling) {
        const shot = await shoot(site(), frame);
        expect(covered(shot), `pixels of the prefix drawn over, in frame ${frame}`).toBe(0);
      }
    });

    it('stays under the brand wipe that follows it: the panel covers the prefix, which does not climb over it', async () => {
      // The frame before the cut: the panel is about to cover the whole frame, and the WordCycle is still on screen.
      const shot = await shoot(site(), headline.from - 1);
      const prefix = lineOf(shot, PREFIX).box;
      const [fgR = 0, fgG = 0] = channels(FG);
      let dark = 0;
      for (let y = Math.floor(prefix.y); y < Math.ceil(prefix.y + prefix.h); y++) {
        for (let x = Math.floor(prefix.x); x < Math.ceil(prefix.x + prefix.w); x++) {
          const at = (y * shot.width + x) * 3;
          if (Math.abs(shot.rgb[at]! - fgR) + Math.abs(shot.rgb[at + 1]! - fgG) < 24) dark++;
        }
      }
      expect(dark, 'pixels of the prefix over the panel').toBe(0);
    });
  });

  // The lines of every piece are set in clips of their own (TypeLines), with room for the ink above and below.
  describe.each(CASES)('a headline in %s at line height %s', (family, lineHeight) => {
    const site = () => siteWith(fonts[family]!, lineHeight);
    const last = HEADLINE[HEADLINE.length - 1]!;

    it('shows the last line whole once it is revealed: the descenders of g, p, y and j are not cut', async () => {
      const shot = await shoot(site(), settledFrame(headline));
      const { clip } = lineOf(shot, last);
      expect(clip, 'the clip').not.toBeNull();
      const rows = inkRows(shot, clip!, isInk);
      expect(rows, `the ink of "${last}"`).toBeDefined();
      const lastRow = Math.ceil(clip!.y + clip!.h) - 1;
      expect(rows!.last, `the last row of ink, in a clip that ends on row ${lastRow}`).toBeLessThan(lastRow);
    });

    it('shows nothing of a line that waits to be revealed, at the bottom of its clip', async () => {
      // Line 2 comes in on beat 2; thirty frames into the scene it is still waiting, and the lines above it are rising in.
      const shot = await shoot(site(), headline.from + 30);
      const { clip } = lineOf(shot, last);
      // The lower half of the clip, where the waiting line shows first: nothing else is drawn there.
      const lower = { ...clip!, y: clip!.y + clip!.h / 2, h: clip!.h / 2 };
      expect(inkRows(shot, lower, isInk)?.count ?? 0, 'pixels of ink in the lower half of its clip').toBe(0);
    });

    it('keeps the lines where they have always been: 0.14 em between them, centered in the safe zone', async () => {
      const shot = await shoot(site(), settledFrame(headline));
      const boxes = HEADLINE.map((text) => lineOf(shot, text).box);
      expectLinesSet(boxes, lineHeight);
    });
  });

  // The lines are the children of a flex column, whose items' margins never collapse: the room of a clip over the next
  // (a negative margin, to leave the text where it is) cannot pull the lines together. In a block, adjacent margins collapse to
  // the larger, so the lines would sit a line height plus the lesser room apart: 0.14 em while the room above is the least a
  // clip leaves, and further as soon as an accented capital makes it grow. No other headline of this file makes it grow.
  describe('a headline with accented capitals in Oswald at line height 0.94', () => {
    const lineHeight = 0.94;
    const accented = ['Ética', 'ÁGIL', 'Pago playa'];
    const edlOf = (texts: string[]): Edl => ({ ...edl, body: [{ ...edl.body[0]!, lines: texts.map((text) => ({ text, kind: 'framing' as const })) }] });

    it('keeps 0.14 em between the lines and the block centered, whatever room the clips have above them', async () => {
      const scenes = edlOf(accented);
      const scene = layoutScenes(scenes, 0).scenes[1] as TimedScene;
      const shot = await shoot(siteWith(fonts['Oswald']!, lineHeight), settledFrame(scene), scenes);
      const lines = accented.map((text) => lineOf(shot, text));
      const size = lines[0]!.box.h / lineHeight;
      // The precondition: the clips do have more room above their lines than the least they leave, or this proves nothing.
      lines.forEach(({ box, clip }, i) => expect((box.y - clip!.y) / size, `room above line ${i}, in em`).toBeGreaterThan(ROOM.above + 0.02));
      expectLinesSet(lines.map((line) => line.box), lineHeight);
    });
  });
});
