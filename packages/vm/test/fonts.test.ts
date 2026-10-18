import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { genericOf, resolveFont, resolveFontFallback } from '../src/capture/fonts';

describe('resolveFontFallback', () => {
  it('maps proprietary fonts to the closest open family', () => {
    expect(resolveFontFallback('Circular Std', 'sans-serif')).toEqual({ family: 'Inter', source: 'google' });
    expect(resolveFontFallback('Tiempos', 'serif').family).toBe('Source Serif 4');
    expect(resolveFontFallback('Berkeley Mono', 'monospace').family).toBe('JetBrains Mono');
  });
});

describe('genericOf', () => {
  it.each([
    ['"Berkeley Mono", ui-monospace, monospace', 'monospace'],
    ['"Tiempos Text", Georgia, serif', 'serif'],
    ['"Circular Std", Helvetica, Arial, sans-serif', 'sans-serif'],
    ['"Söhne", system-ui', 'sans-serif'],
    ['ui-serif, Georgia', 'serif'],
    // No generic word in the stack: the name of the font is what is left to go by.
    ['"Berkeley Mono"', 'monospace'],
    ['"Fira Code", Menlo', 'monospace'],
    ['"Garamond Premier"', 'serif'],
    ['"Plain Sans"', 'sans-serif'],
  ])('reads %s as %s', (stack, generic) => {
    expect(genericOf(stack)).toBe(generic);
  });
});

// The Google Fonts API and the files it points to, in memory. `known` is what it has, and whether it has a width axis.
function fakeGoogle(known: Record<string, { wdth?: boolean; noLatin?: boolean }>) {
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith('https://fonts.gstatic.com/')) return new Response(`bytes of ${url}`, { headers: { 'content-type': 'font/woff2' } });
    const match = /^https:\/\/fonts\.googleapis\.com\/css2\?family=([^:&]+)(?::([^&]*))?&/.exec(url);
    const family = match ? decodeURIComponent(match[1] ?? '').replace(/\+/g, ' ') : '';
    const axes = match?.[2] ?? '';
    const font = known[family];
    if (!font || (axes.startsWith('wdth') && !font.wdth)) return new Response('Bad Request', { status: 400 });
    const slug = family.toLowerCase().replace(/ /g, '-');
    const block = (label: string, file: string, weight: string, stretch?: string) =>
      `/* ${label} */\n@font-face {\n  font-family: '${family}';\n  font-style: normal;\n  font-weight: ${weight};\n${stretch ? `  font-stretch: ${stretch};\n` : ''}  font-display: swap;\n  src: url(https://fonts.gstatic.com/s/${slug}/${file}.woff2) format('woff2');\n}\n`;
    if (font.noLatin) return new Response(block('japanese', 'jp', '400 800'));
    const wdth = axes.startsWith('wdth');
    return new Response(block('cyrillic', 'cyr', '400 800') + block('latin', wdth ? 'wide' : 'plain', '400 800', wdth ? '75% 125%' : undefined));
  }) as typeof fetch;
  return { fetchImpl, requests };
}

describe('resolveFont', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fonts-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const sources = { fontFaceSrcs: [], stylesheets: [] };

  it('takes a font that is on Google Fonts as it is, with its latin file', async () => {
    const { fetchImpl } = fakeGoogle({ 'Bricolage Grotesque': {} });

    const font = await resolveFont('"Bricolage Grotesque", sans-serif', 'display', sources, { outDir: dir, fetchImpl });

    expect(font).toMatchObject({ family: 'Bricolage Grotesque', role: 'display', source: 'google' });
    expect(font.url).toContain('family=Bricolage+Grotesque');
    expect(font.files).toEqual([{ file: 'media/fonts/bricolage-grotesque-400-800.woff2', weight: '400 800' }]);
    expect(readFileSync(join(dir, 'media/fonts/bricolage-grotesque-400-800.woff2'), 'utf8')).toBe('bytes of https://fonts.gstatic.com/s/bricolage-grotesque/plain.woff2');
  });

  it('uses the closest open family when the site font is not on Google Fonts, and says so', async () => {
    const { fetchImpl } = fakeGoogle({ Inter: {}, 'Source Serif 4': {}, 'JetBrains Mono': {} });
    const notes: string[] = [];

    const sans = await resolveFont('"Circular Std", Helvetica, sans-serif', 'display', sources, { outDir: dir, fetchImpl, note: (n) => notes.push(n) });
    const serif = await resolveFont('"Tiempos Text", Georgia, serif', 'body', sources, { outDir: dir, fetchImpl });
    const mono = await resolveFont('"Berkeley Mono", monospace', 'body', sources, { outDir: dir, fetchImpl });

    expect(sans).toMatchObject({ family: 'Inter', source: 'google', role: 'display' });
    expect(sans.files).toHaveLength(1);
    expect(existsSync(join(dir, sans.files?.[0]?.file ?? 'missing'))).toBe(true);
    expect(serif.family).toBe('Source Serif 4');
    expect(mono.family).toBe('JetBrains Mono');
    expect(notes.join('\n')).toMatch(/Circular Std.*Inter/);
  });

  it('never leaves the default font of the browser: a system stack gets the open family without asking Google for it', async () => {
    const { fetchImpl, requests } = fakeGoogle({ Inter: {} });

    const font = await resolveFont('system-ui, -apple-system, "Segoe UI", sans-serif', 'body', sources, { outDir: dir, fetchImpl });

    expect(font).toMatchObject({ family: 'Inter', source: 'google' });
    expect(font.files?.length).toBeGreaterThan(0);
    expect(requests.some((r) => /system-ui/i.test(r))).toBe(false);
  });

  it('falls back for a family that Google has only in other scripts (no latin file)', async () => {
    const { fetchImpl } = fakeGoogle({ 'Noto Sans JP': { noLatin: true }, Inter: {} });

    const font = await resolveFont('"Noto Sans JP", sans-serif', 'display', sources, { outDir: dir, fetchImpl });

    expect(font.family).toBe('Inter');
  });

  it('gives the file of a width axis a name of its own, so the body font of the same family cannot overwrite it', async () => {
    const { fetchImpl } = fakeGoogle({ Anton: { wdth: true } });

    const display = await resolveFont('Anton, sans-serif', 'display', sources, { outDir: dir, fetchImpl, stretch: '75%' });
    const body = await resolveFont('Anton, sans-serif', 'body', sources, { outDir: dir, fetchImpl });

    expect(display.stretch).toBe('75%');
    expect(display.files).toEqual([{ file: 'media/fonts/anton-400-800-wdth.woff2', weight: '400 800', stretch: '75% 125%' }]);
    expect(body.files).toEqual([{ file: 'media/fonts/anton-400-800.woff2', weight: '400 800' }]);
    // The body font was saved after the display font, and the display font's file is still the one with the width axis.
    expect(readFileSync(join(dir, 'media/fonts/anton-400-800-wdth.woff2'), 'utf8')).toContain('/wide.woff2');
  });

  it('reads the family behind next/font and drops " Variable"', async () => {
    const { fetchImpl } = fakeGoogle({ Geist: {}, Inter: {} });

    expect((await resolveFont('__Geist_a1b2c3d4, sans-serif', 'body', sources, { outDir: dir, fetchImpl })).family).toBe('Geist');
    expect((await resolveFont('"Inter Variable", sans-serif', 'body', sources, { outDir: dir, fetchImpl })).family).toBe('Inter');
  });

  it('keeps "fontsource" as the source when the site loads the font from fontsource', async () => {
    const { fetchImpl } = fakeGoogle({ Geist: {} });

    const font = await resolveFont('Geist, sans-serif', 'body', { fontFaceSrcs: [], stylesheets: ['https://cdn.jsdelivr.net/npm/@fontsource/geist/index.css'] }, { outDir: dir, fetchImpl });

    expect(font.source).toBe('fontsource');
  });

  it('only downloads files from the Google Fonts host', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith('https://fonts.googleapis.com/')) {
        return new Response("/* latin */\n@font-face {\n  font-family: 'Inter';\n  font-weight: 400 800;\n  src: url(https://evil.example/x.woff2) format('woff2');\n}\n");
      }
      throw new Error(`unexpected request to ${url}`);
    }) as typeof fetch;

    await expect(resolveFont('Inter, sans-serif', 'body', sources, { outDir: dir, fetchImpl })).rejects.toThrow(/font/i);
  });

  it('fails, rather than going on without a font file, when Google Fonts cannot be reached', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;

    await expect(resolveFont('Inter, sans-serif', 'body', sources, { outDir: dir, fetchImpl })).rejects.toThrow(/font/i);
  });
});
