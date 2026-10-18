// Opt-in (`pnpm --filter @app/vm test:browser`): drives a real Chrome against a small site served from test/fixtures/site.
// The first run downloads chrome-headless-shell, and the fonts come from Google Fonts, so it needs the network.
// A capture takes half a minute, so the describes below share one capture each.
import { ensureBrowser } from '@remotion/renderer';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { CaptureInput, CaptureResult } from '@app/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCaptureFile, capture, type CapturedSite } from '../../src/capture';

const SITE = join(import.meta.dirname, '..', 'fixtures', 'site');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css' };

let server: Server;
let fixtureUrl: string;
const dirs: string[] = [];

beforeAll(async () => {
  await ensureBrowser();
  server = createServer((req, res) => {
    const name = !req.url || req.url === '/' ? 'index.html' : (req.url.slice(1).split('?')[0] ?? '');
    const file = join(SITE, name);
    if (name.includes('..') || !existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  fixtureUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
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

describe('a site that is not asked to follow its links, with an extra page nobody answers', () => {
  const run = sharedCapture(() => ({ url: fixtureUrl, extraUrls: ['http://127.0.0.1:1/'], followDemoLinks: 0 }));

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

  it('follows no link when it is not asked to, and leaves out the extra page it cannot reach, saying so', () => {
    const { site } = run;
    expect(site.extraSections).toHaveLength(0);
    expect(site.shots.some((s) => s.id.startsWith('x'))).toBe(false);
    expect(site.log.notes.join('\n')).toMatch(/extra page http:\/\/127\.0\.0\.1:1\/ left out/);
  });

  it('says whether the metadata server is out of reach (it is, on this machine)', () => {
    expect(run.result).toMatchObject({ ok: true, metadataBlocked: true });
  });
});
