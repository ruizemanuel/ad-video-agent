import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CaptureResult, TaskEnvelope } from '@app/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capture, captureTask, checkExtraPage, countWords, ExtraPageLeftOut, pairPhoneSections, parseCaptureInput, pickExtraPages, thinCaptureMessage } from '../src/capture';

const OK: CaptureResult = { ok: true, metadataBlocked: true, sections: 2, shots: 3 };
const TARGET = 'https://store.example/orders/o1/capture.json?signature=SECRET';

const task = (input: unknown, urls: Record<string, string> = { captureJson: TARGET }): TaskEnvelope => ({ id: 't1', kind: 'capture', input, urls });

describe('parseCaptureInput', () => {
  it('reads the address, the extra pages and the number of links to follow', () => {
    expect(parseCaptureInput({ url: 'https://x.example/a', extraUrls: ['https://x.example/b'], followDemoLinks: 2 })).toEqual({
      url: 'https://x.example/a',
      extraUrls: ['https://x.example/b'],
      followDemoLinks: 2,
    });
  });

  it('leaves out the extra addresses that are not http or https, and the ones that are not addresses', () => {
    const input = parseCaptureInput({
      url: 'https://x.example/',
      extraUrls: ['https://a.example/ok', 'http://b.example/ok', 'file:///etc/passwd', 'ftp://c.example/', 'javascript:alert(1)', 'data:text/html,hi', 'not an address', 42, null],
      followDemoLinks: 0,
    });
    expect(input.extraUrls).toEqual(['https://a.example/ok', 'http://b.example/ok']);
  });

  it.each([
    ['is missing', undefined],
    ['is empty', ''],
    ['is not text', 5],
    ['is a file', 'file:///etc/passwd'],
    ['is ftp', 'ftp://x.example/'],
    ['is a script', 'javascript:alert(1)'],
    ['is not an address', 'x.example'],
  ])('refuses a task whose address %s', (_what, url) => {
    expect(() => parseCaptureInput({ url, extraUrls: [], followDemoLinks: 0 })).toThrow(/web address/);
  });

  it('refuses an input that is not an object', () => {
    expect(() => parseCaptureInput(null)).toThrow(/web address/);
    expect(() => parseCaptureInput('https://x.example/')).toThrow(/web address/);
  });

  it.each([
    [undefined, 0],
    [-3, 0],
    [1.9, 1],
    [2, 2],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    ['2', 0],
  ])('reads followDemoLinks %s as %s', (given, expected) => {
    expect(parseCaptureInput({ url: 'https://x.example/', followDemoLinks: given }).followDemoLinks).toBe(expected);
    expect(parseCaptureInput({ url: 'https://x.example/', followDemoLinks: given }).extraUrls).toEqual([]);
  });
});

describe('pickExtraPages', () => {
  it('puts the demo links first, then the extra pages, each page once and never the site itself', () => {
    const { pages, ignored } = pickExtraPages(
      'https://x.example/',
      ['https://x.example/demo', 'https://x.example/#top'],
      ['https://x.example/demo#again', 'https://x.example', 'https://y.example/app'],
    );
    expect(pages).toEqual(['https://x.example/demo', 'https://y.example/app']);
    expect(ignored).toBe(0);
  });

  it('leaves out, and counts, what is not an http or https address', () => {
    const { pages, ignored } = pickExtraPages('https://x.example/', [], ['file:///etc/passwd', 'ftp://x.example/', 'javascript:alert(1)', 'nothing', 'https://x.example/ok']);
    expect(pages).toEqual(['https://x.example/ok']);
    expect(ignored).toBe(4);
  });
});

describe('checkExtraPage', () => {
  /** A page as the browser opened it, that shows this title and text. */
  const opened = (title: string, text: string) => ({ evaluate: vi.fn(async () => ({ title, text })) });
  const content = 'Our shop sells handmade mugs and plates, shipped in two days to the whole country. '.repeat(5);

  it('lets through a page that loaded well', async () => {
    await expect(checkExtraPage(opened('Mugs', content), 200)).resolves.toBeUndefined();
  });

  it.each([
    ['a challenge', 'Just a moment...', 'Checking your browser', 200],
    ['an access-denied page', 'Access denied', 'You do not have permission', 403],
    ['an error with no text', '', '', 404],
  ])('leaves out %s, which is not the site, saying why', async (_label, title, text, status) => {
    await expect(checkExtraPage(opened(title, text), status)).rejects.toThrow(ExtraPageLeftOut);
  });

  it.each([404, 500, 301])('leaves out a page that answered HTTP %s, even with text on it', async (status) => {
    await expect(checkExtraPage(opened('Not found', content), status)).rejects.toThrow(`HTTP ${status}`);
  });
});

describe('pairPhoneSections', () => {
  const desktop = [
    { id: 's1', heading: '' },
    { id: 's2', heading: 'Fees' },
    { id: 's3', heading: 'Support' },
    { id: 's4', heading: 'Fees' },
  ];

  it('gives the k-th phone section with a heading the id of the k-th desktop section with it', () => {
    expect(pairPhoneSections(desktop, [{ heading: '' }, { heading: 'Fees' }, { heading: 'Support' }, { heading: 'Fees' }])).toEqual(['s1', 's2', 's3', 's4']);
    expect(pairPhoneSections(desktop, [{ heading: 'Support' }, { heading: 'Fees' }, { heading: 'Fees' }])).toEqual(['s3', 's2', 's4']);
  });

  it('gives no id to a phone section that has no k-th twin on the desktop', () => {
    expect(pairPhoneSections(desktop, [{ heading: 'Fees' }, { heading: 'Fees' }, { heading: 'Fees' }, { heading: 'Pricing' }])).toEqual(['s2', 's4', null, null]);
  });
});

describe('countWords', () => {
  it('counts what stands between spaces and holds a letter or a digit', () => {
    expect(countWords('  Pay gas in USD₮ — 1 sec. blocks\n$0.0004 · $ 6.2 ')).toBe(9);
    expect(countWords('')).toBe(0);
    expect(countWords(' — · $ ')).toBe(0);
  });
});

describe('thinCaptureMessage', () => {
  const thin = (read: number, shown: number): string => `The capture read ${read} words of the ${shown} the page shows: too little to write from.`;

  it('fails a capture of fewer than 60 words that is also less than a quarter of the page, with both numbers', () => {
    expect(thinCaptureMessage(27, 2617)).toBe(thin(27, 2617));
    expect(thinCaptureMessage(59, 237)).toBe(thin(59, 237));
    expect(thinCaptureMessage(24, 100)).toBe(thin(24, 100));
  });

  it('passes 60 words or more, however large the page', () => {
    expect(thinCaptureMessage(60, 100_000)).toBeNull();
    expect(thinCaptureMessage(500, 20_000)).toBeNull();
  });

  it('passes a quarter of the page or more, however few the words', () => {
    expect(thinCaptureMessage(50, 50)).toBeNull();
    expect(thinCaptureMessage(59, 236)).toBeNull();
    expect(thinCaptureMessage(25, 100)).toBeNull();
  });
});

describe('capture refuses what it must not open', () => {
  it.each(['file:///etc/passwd', 'ftp://x.example/', 'javascript:alert(1)', 'not an address'])('does not open %s as the site, and starts no browser', async (url) => {
    const dir = mkdtempSync(join(tmpdir(), 'capture-refuse-'));
    try {
      const result = await capture({ url, extraUrls: [], followDemoLinks: 0 }, dir);
      expect(result).toMatchObject({ ok: false, code: 'error', message: expect.stringContaining('http') });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('captureTask', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'capture-task-'));
    mkdirSync(join(dir, 'director'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const site = { url: 'https://x.example/', sections: [{ id: 's1', heading: 'Hi', text: 'There', ctas: [] }], shots: [], boxes: [] };
  const writeCapture = (): void => {
    writeFileSync(join(dir, 'site.json'), JSON.stringify(site));
    writeFileSync(join(dir, 'director', 'm-s2.jpg'), Buffer.from([0xff, 0xd8, 0x02]));
    writeFileSync(join(dir, 'director', 'm-s1.jpg'), Buffer.from([0xff, 0xd8, 0x01]));
    writeFileSync(join(dir, 'director', 'notes.txt'), 'not a picture');
  };
  const deps = (result: CaptureResult = OK) => ({
    capture: vi.fn(async (_input: unknown, _runDir: string): Promise<CaptureResult> => {
      if (result.ok) writeCapture();
      return result;
    }),
    upload: vi.fn(async (_url: string, _body: string | Uint8Array, _type: string): Promise<void> => {}),
  });

  it('captures, builds the capture file and uploads it to the place the task names', async () => {
    const d = deps();

    const result = await captureTask(task({ url: 'https://x.example/', extraUrls: ['https://x.example/app'], followDemoLinks: 1 }), dir, d);

    expect(result).toEqual(OK);
    expect(d.capture).toHaveBeenCalledWith({ url: 'https://x.example/', extraUrls: ['https://x.example/app'], followDemoLinks: 1 }, dir);
    expect(d.upload).toHaveBeenCalledTimes(1);
    const [url, body, type] = d.upload.mock.calls[0] ?? [];
    expect(url).toBe(TARGET);
    expect(type).toBe('application/json');
    expect(JSON.parse(String(body))).toEqual({
      site,
      directorImages: [
        { shotId: 'm-s1', jpegBase64: Buffer.from([0xff, 0xd8, 0x01]).toString('base64') },
        { shotId: 'm-s2', jpegBase64: Buffer.from([0xff, 0xd8, 0x02]).toString('base64') },
      ],
    });
  });

  it('gives the capture only http and https addresses', async () => {
    const d = deps();

    await captureTask(task({ url: 'https://x.example/', extraUrls: ['file:///etc/passwd', 'javascript:alert(1)', 'https://x.example/ok'], followDemoLinks: 0 }), dir, d);

    expect(d.capture.mock.calls[0]?.[0]).toEqual({ url: 'https://x.example/', extraUrls: ['https://x.example/ok'], followDemoLinks: 0 });
  });

  it.each(['file:///etc/passwd', 'ftp://x.example/', 'javascript:alert(1)'])('refuses a site address of %s: nothing is captured or uploaded', async (url) => {
    const d = deps();

    await expect(captureTask(task({ url, extraUrls: [], followDemoLinks: 0 }), dir, d)).rejects.toThrow(/web address/);

    expect(d.capture).not.toHaveBeenCalled();
    expect(d.upload).not.toHaveBeenCalled();
  });

  it.each<[string, CaptureResult]>([
    ['blocked', { ok: false, code: 'blocked', message: 'wall' }],
    ['unreachable', { ok: false, code: 'unreachable', message: 'down' }],
    ['error', { ok: false, code: 'error', message: 'broke' }],
  ])('uploads nothing when the capture ends %s, and gives back why', async (_code, failure) => {
    const d = deps(failure);

    expect(await captureTask(task({ url: 'https://x.example/', extraUrls: [], followDemoLinks: 0 }), dir, d)).toEqual(failure);

    expect(d.upload).not.toHaveBeenCalled();
  });

  it('throws, before capturing anything, when the task has no place to put the capture', async () => {
    const d = deps();

    await expect(captureTask(task({ url: 'https://x.example/', extraUrls: [], followDemoLinks: 0 }, {}), dir, d)).rejects.toThrow(/place to put/);

    expect(d.capture).not.toHaveBeenCalled();
    expect(d.upload).not.toHaveBeenCalled();
  });

  it('lets a failed upload through, so that the worker reports the task as failed', async () => {
    const d = deps();
    d.upload.mockRejectedValue(new Error('The upload was refused (HTTP 403).'));

    await expect(captureTask(task({ url: 'https://x.example/', extraUrls: [], followDemoLinks: 0 }), dir, d)).rejects.toThrow(/403/);
  });
});
