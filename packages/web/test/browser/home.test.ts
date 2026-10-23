// The home as a person sees it: laid out at a computer's width and a phone's, with the two examples ready to play in
// place, and everything it loads (fonts included) served by the app itself.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchPage, startApp, type App } from './support/app';

describe('the home page', () => {
  let app: App;
  beforeAll(async () => {
    app = await startApp();
  });
  afterAll(async () => {
    await app?.stop();
  });

  it('has no horizontal scroll at 390 and 1280 px', async () => {
    const { browser, page, blockedRequests } = await launchPage(app);
    try {
      for (const width of [1280, 390]) {
        await page.setViewport({ width, height: 900 });
        expect((await page.goto(`${app.url}/`, { waitUntil: 'load' }))?.status()).toBe(200);
        const { scrollWidth, innerWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        }));
        expect(scrollWidth, `the page's width at ${width} px`).toBeLessThanOrEqual(innerWidth);
      }
      expect(blockedRequests()).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it('plays the examples inline', async () => {
    const { browser, page, blockedRequests } = await launchPage(app);
    try {
      await page.goto(`${app.url}/`, { waitUntil: 'load' });
      const videos = await page.$$eval('video', (found) =>
        found.map((video) => ({
          src: new URL(video.src).pathname,
          muted: video.muted && video.hasAttribute('muted'),
          playsInline: video.hasAttribute('playsinline'),
          controls: video.controls,
          poster: video.poster,
        })),
      );
      expect(videos.map(({ src }) => src)).toEqual(['/examples/cobrame.mp4', '/examples/celo.mp4']);
      for (const video of videos) {
        expect(video, video.src).toMatchObject({ muted: true, playsInline: true, controls: true });
        const poster = await page.evaluate(
          (src) =>
            new Promise<{ width: number; height: number } | null>((done) => {
              const image = new Image();
              image.onload = () => done({ width: image.naturalWidth, height: image.naturalHeight });
              image.onerror = () => done(null);
              image.src = src;
            }),
          video.poster,
        );
        expect(poster, video.poster).toEqual({ width: 540, height: 960 });
        const served = await page.evaluate(async (src) => {
          const res = await fetch(src, { headers: { range: 'bytes=0-15' } });
          await res.arrayBuffer();
          return { ok: res.ok, type: res.headers.get('content-type') };
        }, video.src);
        expect(served, video.src).toEqual({ ok: true, type: 'video/mp4' });
      }
      expect(blockedRequests()).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it('has its name, its sections in the header, and its own fonts', async () => {
    const { browser, page, blockedRequests } = await launchPage(app);
    try {
      await page.goto(`${app.url}/`, { waitUntil: 'load' });
      expect(await page.title()).toBe('Ad Video Agent');
      const links = await page.$$eval('header nav a', (found) => found.map((link) => new URL(link.href).hash));
      expect(links).toEqual(['#examples', '#how', '#agents']);
      for (const hash of links) expect(await page.$(hash), hash).not.toBeNull();

      const loaded = await page.evaluate(async () => {
        await document.fonts.ready;
        return [...document.fonts].filter((face) => face.status === 'loaded').map((face) => face.family.replace(/["']/g, ''));
      });
      for (const family of ['Instrument Serif', 'IBM Plex Sans', 'IBM Plex Mono']) expect(loaded, family).toContain(family);
      // A font asked of Google by the browser would be listed here.
      expect(blockedRequests()).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
