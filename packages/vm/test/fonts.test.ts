import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fallbackKind, resolveFont, resolveFontFallback } from '../src/capture/fonts';

describe('resolveFontFallback', () => {
  it('maps proprietary fonts to the closest open family', () => {
    expect(resolveFontFallback('Circular Std', 'sans-serif')).toEqual({ family: 'Inter', source: 'google' });
    expect(resolveFontFallback('Tiempos', 'serif').family).toBe('Source Serif 4');
    expect(resolveFontFallback('Berkeley Mono', 'monospace').family).toBe('JetBrains Mono');
  });
});

describe('fallbackKind', () => {
  // [stack, family (its first, as resolveFont reads it), what the page measured of the face] -> [kind, why]
  it.each([
    // 1. Monospace, by the stack's generic word or by the name, whatever was measured: a monospace face has serifs or not.
    ['"Berkeley Mono", ui-monospace, monospace', 'Berkeley Mono', 'serif', 'monospace', 'monospace by the stack'],
    ['"Courier Prime", monospace', 'Courier Prime', 'serif', 'monospace', 'monospace by the stack'],
    ['"Berkeley Mono", sans-serif', 'Berkeley Mono', 'sans-serif', 'monospace', 'monospace by its name'],
    ['"Fira Code", Menlo', 'Fira Code', null, 'monospace', 'monospace by its name'],
    // 2. What the page measured of the face, before its name and before the stack's last word.
    ['"GT Alpina Thin", "GT Alpina Thin Placeholder", sans-serif', 'GT Alpina Thin', 'serif', 'serif', 'measured serif'],
    ['"Brand Text", Georgia, serif', 'Brand Text', 'sans-serif', 'sans-serif', 'measured sans-serif'],
    ['"Tiempos Text", serif', 'Tiempos Text', 'sans-serif', 'sans-serif', 'measured sans-serif'],
    // 3. The face could not be measured: a serif's name, before the stack's last word (Framer ends every stack with sans-serif).
    ['"GT Alpina Thin", "GT Alpina Thin Placeholder", sans-serif', 'GT Alpina Thin', null, 'serif', 'serif by its name'],
    ['"Tiempos Headline", sans-serif', 'Tiempos Headline', null, 'serif', 'serif by its name'],
    ['"Canela Deck", sans-serif', 'Canela Deck', null, 'serif', 'serif by its name'],
    ['"Freight Big Pro", sans-serif', 'Freight Big Pro', null, 'serif', 'serif by its name'],
    ['"GT Sectra Display", sans-serif', 'GT Sectra Display', null, 'serif', 'serif by its name'],
    ['"PP Editorial New", sans-serif', 'PP Editorial New', null, 'serif', 'serif by its name'],
    ['"Garamond Premier"', 'Garamond Premier', null, 'serif', 'serif by its name'],
    // ... unless the name says sans: the sans of a serif family.
    ['"Freight Sans Pro", sans-serif', 'Freight Sans Pro', null, 'sans-serif', 'sans-serif by the stack'],
    ['"Merriweather Sans"', 'Merriweather Sans', null, 'sans-serif', 'sans-serif by default'],
    // 4. The stack's generic word, the first there is; else sans-serif.
    ['"Circular Std", Helvetica, Arial, sans-serif', 'Circular Std', null, 'sans-serif', 'sans-serif by the stack'],
    ['"Söhne", system-ui', 'Söhne', null, 'sans-serif', 'sans-serif by the stack'],
    ['"Brand Book", Georgia, serif', 'Brand Book', null, 'serif', 'serif by the stack'],
    ['"Plain Face"', 'Plain Face', null, 'sans-serif', 'sans-serif by default'],
  ] as const)('reads %s (%s, measured %s) as %s: %s', (stack, family, measured, generic, why) => {
    expect(fallbackKind(stack, family, measured)).toEqual({ generic, why });
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

  it('stands in for a face of the kind the page measured, before its name and the stack, and says why', async () => {
    const { fetchImpl } = fakeGoogle({ Inter: {}, 'Source Serif 4': {} });
    const notes: string[] = [];
    const stack = '"GT Alpina Thin", "GT Alpina Thin Placeholder", sans-serif';

    const measured = await resolveFont(stack, 'display', sources, { outDir: dir, fetchImpl, measured: 'serif', note: (n) => notes.push(n) });
    const byName = await resolveFont(stack, 'display', sources, { outDir: dir, fetchImpl, measured: null, note: (n) => notes.push(n) });
    const sans = await resolveFont('"Brand Text", Georgia, serif', 'body', sources, { outDir: dir, fetchImpl, measured: 'sans-serif', note: (n) => notes.push(n) });

    expect([measured.family, byName.family, sans.family]).toEqual(['Source Serif 4', 'Source Serif 4', 'Inter']);
    expect(notes).toEqual([
      'font "GT Alpina Thin" is not on Google Fonts',
      'font "GT Alpina Thin" replaced by Source Serif 4 (measured serif)',
      'font "GT Alpina Thin" is not on Google Fonts',
      'font "GT Alpina Thin" replaced by Source Serif 4 (serif by its name)',
      'font "Brand Text" is not on Google Fonts',
      'font "Brand Text" replaced by Inter (measured sans-serif)',
    ]);
  });

  it('takes a face that is on Google Fonts as it is, whatever was measured of it', async () => {
    const { fetchImpl } = fakeGoogle({ 'Bricolage Grotesque': {} });

    const font = await resolveFont('"Bricolage Grotesque", sans-serif', 'display', sources, { outDir: dir, fetchImpl, measured: 'serif' });

    expect(font.family).toBe('Bricolage Grotesque');
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

  it('fails, rather than going on without a font file, when Google Fonts cannot be reached, after trying three times', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    await expect(resolveFont('Inter, sans-serif', 'body', sources, { outDir: dir, fetchImpl, retryDelayMs: 0 })).rejects.toThrow(/font/i);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  describe('when Google Fonts has a bad moment', () => {
    const CSS = (family: string): string =>
      `/* latin */\n@font-face {\n  font-family: '${family}';\n  font-style: normal;\n  font-weight: 400 800;\n  src: url(https://fonts.gstatic.com/s/${family.toLowerCase()}/a.woff2) format('woff2');\n}\n`;

    /** A fetch that answers each address by how many times it has been asked: `answer(url, n)`, with n from 1. */
    function scripted(answer: (url: string, n: number) => Response | Error) {
      const asked = new Map<string, number>();
      const fetchImpl = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        const n = (asked.get(url) ?? 0) + 1;
        asked.set(url, n);
        const reply = answer(url, n);
        if (reply instanceof Error) throw reply;
        return reply;
      }) as unknown as typeof fetch;
      return { fetchImpl, asked: (url: string) => asked.get(url) ?? 0, urls: () => [...asked.keys()] };
    }
    const STYLE = (family: string): string => `https://fonts.googleapis.com/css2?family=${family}:wght@400..800&display=swap`;

    it('asks again after a network error or a 5xx, for the stylesheet and for the file, and takes the font', async () => {
      const file = 'https://fonts.gstatic.com/s/inter/a.woff2';
      const { fetchImpl, asked } = scripted((url, n) => {
        if (url === STYLE('Inter')) return n === 1 ? new TypeError('fetch failed') : n === 2 ? new Response('busy', { status: 503 }) : new Response(CSS('Inter'));
        if (url === file) return n === 1 ? new Response('bad gateway', { status: 502 }) : new Response('bytes');
        return new Response('unexpected', { status: 500 });
      });

      const font = await resolveFont('Inter, sans-serif', 'body', sources, { outDir: dir, fetchImpl, retryDelayMs: 0 });

      expect(font.family).toBe('Inter');
      expect(asked(STYLE('Inter'))).toBe(3);
      expect(asked(file)).toBe(2);
      expect(readFileSync(join(dir, 'media/fonts/inter-400-800.woff2'), 'utf8')).toBe('bytes');
    });

    it('fails when the stylesheet keeps answering 5xx: that is an outage, not "not on Google Fonts"', async () => {
      const { fetchImpl, asked, urls } = scripted(() => new Response('busy', { status: 503 }));

      await expect(resolveFont('Circular Std, sans-serif', 'body', sources, { outDir: dir, fetchImpl, retryDelayMs: 0 })).rejects.toThrow(/Google Fonts.*503/);

      // It did not go down the ladder or ask for the open font: three tries at the first stylesheet and no more.
      expect(urls()).toEqual([expect.stringContaining('Circular+Std')]);
      expect(asked(urls()[0] ?? '')).toBe(3);
    });

    it('takes a 4xx as the answer "not on Google Fonts": no retries, down the ladder and then the open font', async () => {
      const { fetchImpl, asked } = scripted((url) => {
        if (url.includes('Circular+Std')) return new Response('not found', { status: 404 });
        return url === STYLE('Inter') ? new Response(CSS('Inter')) : new Response('bytes');
      });

      const font = await resolveFont('Circular Std, sans-serif', 'display', sources, { outDir: dir, fetchImpl, retryDelayMs: 0 });

      expect(font.family).toBe('Inter');
      // Each of the three requests for Circular Std was made once.
      expect(asked(STYLE('Circular+Std'))).toBe(1);
      expect(asked('https://fonts.googleapis.com/css2?family=Circular+Std:wght@400;700&display=swap')).toBe(1);
      expect(asked('https://fonts.googleapis.com/css2?family=Circular+Std&display=swap')).toBe(1);
    });

    it('fails when the font file keeps answering 5xx', async () => {
      const file = 'https://fonts.gstatic.com/s/inter/a.woff2';
      const { fetchImpl, asked } = scripted((url) => (url === STYLE('Inter') ? new Response(CSS('Inter')) : new Response('bad gateway', { status: 502 })));

      await expect(resolveFont('Inter, sans-serif', 'body', sources, { outDir: dir, fetchImpl, retryDelayMs: 0 })).rejects.toThrow(/502/);

      expect(asked(file)).toBe(3);
    });
  });
});
