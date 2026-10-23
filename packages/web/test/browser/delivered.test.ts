// The delivery view as a person sees it: the video plays on the page, the files download, X opens with a text ready, each
// line of the video sits next to its quote, and "Did you post it?" saves what is answered, keeps it across a reload and
// never stands between the person and the video. The orders are seeded into the fake store the app reads, and what the
// page saved is read from the same store.
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { HTTPRequest, Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileStore } from '../../src/adapters/fake/store';
import type { Feedback } from '../../src/ports';
import { SEEDED_SUMMARY, seedOrder } from './support/seed';
import { launchPage, startApp, type App } from './support/app';

/** How long any one thing may take to show: a first compile of the page included. */
const WAIT = { timeout: 60_000 };
/** A save is one request to a route that is compiled already. */
const SAVES = { timeout: 15_000 };
const VIDEO = fileURLToPath(new URL('./fixtures/video-9x16.mp4', import.meta.url));
const POST = 'https://x.com/cobrame/status/1234567890';
const FAILED = 'We couldn’t save that. What you typed is still here; try again.';
const LINK_FIELD = 'input[placeholder="Link to your post (optional)"]';

const orderUrl = (app: App, id: string): string => `${app.url}/o/${id}`;

/** What the page says, as a person reads it. */
const said = (page: Page): Promise<string> => page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));

/** Waits until the page's own text says `text`. */
const waitForText = (page: Page, text: string, options: { timeout: number }): Promise<unknown> =>
  page.waitForFunction((wanted) => document.body.innerText.replace(/\s+/g, ' ').includes(wanted), options, text);

async function open(page: Page, url: string): Promise<number | undefined> {
  return (await page.goto(url, { waitUntil: 'load', timeout: WAIT.timeout }))?.status();
}

/**
 * Opens the delivered order's page once it runs in the browser. The video's length is shown by the page's own script once
 * the video has loaded its metadata, so when it shows, a click on the form is the page's and not the server's markup's.
 */
async function openDelivered(page: Page, url: string): Promise<void> {
  expect(await open(page, url)).toBe(200);
  await page.waitForFunction(() => /\d+\.\d s/.test(document.body.innerText), WAIT);
}

/** The feedback the app stored for the order, as soon as `wanted` says it is the one. */
async function storedFeedback(store: FileStore, id: string, wanted: (feedback: Feedback | null) => boolean): Promise<Feedback | null> {
  for (const deadline = Date.now() + SAVES.timeout; ; await new Promise((done) => setTimeout(done, 100))) {
    const feedback = await store.getFeedback(id);
    if (wanted(feedback)) return feedback;
    if (Date.now() > deadline) throw new Error(`The order ${id} has no such feedback in the store: ${JSON.stringify(feedback)}`);
  }
}

const isFeedbackPost = (request: HTTPRequest): boolean => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/feedback');

describe('the delivery view', () => {
  let app: App;
  let store: FileStore;
  beforeAll(async () => {
    app = await startApp();
    store = new FileStore(app.fakeDir);
    // The first request to a page or a route compiles it: warm both, so the waits below time the page and not Next.
    const id = await seedOrder(app.fakeDir, 'delivered');
    await (await fetch(orderUrl(app, id), { signal: AbortSignal.timeout(WAIT.timeout) })).arrayBuffer();
    const saved = await fetch(`${app.url}/v1/videos/${id}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: 'not_yet' }),
      signal: AbortSignal.timeout(WAIT.timeout),
    });
    expect(saved.status).toBe(200);
  });
  afterAll(async () => {
    await app?.stop();
  });

  it('plays the delivered video and saves the feedback', async () => {
    const id = await seedOrder(app.fakeDir, 'delivered');
    const fixture = (await stat(VIDEO)).size;
    const { browser, page, blockedRequests } = await launchPage(app);
    try {
      await openDelivered(page, orderUrl(app, id));

      // The video loads its metadata from the delivery link and says its length, read from the video itself.
      await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 1, WAIT);
      const video = await page.$eval('video', (element) => ({
        width: element.videoWidth,
        height: element.videoHeight,
        duration: element.duration,
        controls: element.controls,
        preload: element.preload,
        src: element.getAttribute('src'),
      }));
      expect(video.height / video.width).toBeCloseTo(16 / 9, 2);
      expect(video.duration).toBeGreaterThanOrEqual(1);
      expect(video.duration).toBeLessThanOrEqual(2);
      expect(video).toMatchObject({ controls: true, preload: 'metadata' });
      expect(video.src).toMatch(new RegExp(`^${app.url}/v1/files/${id}/hook-a-9x16\\.mp4\\?exp=\\d+&sig=[0-9a-f]{64}$`));
      await waitForText(page, `${video.duration.toFixed(1)} s`, { timeout: 5_000 });
      expect(await said(page)).toContain(`cobrame.example · 1080×1920 · ${video.duration.toFixed(1)} s`);

      // It plays: a press on the picture starts it.
      await page.click('video');
      await page.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 0, { timeout: 10_000 });

      // The two downloads are the two files, behind the service's signed links.
      const downloads = await page.$$eval('a[download]', (links) => links.map((link) => ({ words: link.textContent, href: link.href, download: link.getAttribute('download') })));
      expect(downloads.map(({ words, download }) => [words, download])).toEqual([
        ['Download MP4', 'hook-a-9x16.mp4'],
        ['Muted version', 'hook-a-9x16-muted.mp4'],
      ]);
      for (const { href } of downloads) {
        const got = await page.evaluate(async (link) => {
          const res = await fetch(link);
          return { status: res.status, type: res.headers.get('content-type'), bytes: (await res.arrayBuffer()).byteLength };
        }, href);
        expect(got).toEqual({ status: 200, type: 'video/mp4', bytes: fixture });
      }

      // X opens in a tab of its own, with the first line of the video and the site.
      const post = await page.$eval('a[href^="https://x.com/intent/post"]', (link) => ({ href: link.href, words: link.textContent, target: link.target, rel: link.rel }));
      expect(post).toMatchObject({ words: 'Post on X', target: '_blank', rel: 'noopener noreferrer' });
      expect(new URL(post.href).searchParams.get('text')).toBe('Get paid on time https://cobrame.example/');

      // Every line of the video sits next to the words it comes from.
      const lines = await page.$$eval('li', (items) => items.map((item) => (item as HTMLElement).innerText.replace(/\s+/g, ' ')));
      expect(lines).toHaveLength(SEEDED_SUMMARY.claims.length);
      SEEDED_SUMMARY.claims.forEach(({ onScreen, quote, section }, index) => {
        expect(lines[index]).toContain(onScreen);
        expect(lines[index]).toContain(`“${quote}”`);
        expect(lines[index]).toContain(section);
      });
      expect(await said(page)).toContain('Music: made for this video by Google Lyria 3.5, 120 BPM. You may use it in this ad, paid ads included.');

      // Nothing was answered yet. Choosing "As is" saves it at once, with no link: the field is blank and is left out.
      expect(await store.getFeedback(id)).toBeNull();
      expect(await page.$eval('input[type="checkbox"]', (box) => (box as HTMLInputElement).disabled)).toBe(true);
      await page.click('label ::-p-text(As is)');
      expect(await storedFeedback(store, id, (feedback) => feedback !== null)).toMatchObject({ answer: 'as_is', postUrl: null, mayShow: false });
      await waitForText(page, 'Saved', SAVES);

      // The link, and the permission once there is one, are saved with the button.
      await page.type(LINK_FIELD, POST);
      expect(await page.$eval('input[type="checkbox"]', (box) => (box as HTMLInputElement).disabled)).toBe(false);
      await page.click('label ::-p-text(You can show this post as an example)');
      await page.click('button ::-p-text(Save)');
      expect(await storedFeedback(store, id, (feedback) => feedback?.postUrl === POST)).toMatchObject({ answer: 'as_is', postUrl: POST, mayShow: true });

      // After a reload it is as it was left, and it can be changed.
      await openDelivered(page, orderUrl(app, id));
      expect(await page.$$eval('input[type="radio"]', (radios) => radios.filter((radio) => (radio as HTMLInputElement).checked).map((radio) => (radio as HTMLInputElement).value))).toEqual(['as_is']);
      expect(await page.$eval(LINK_FIELD, (field) => (field as HTMLInputElement).value)).toBe(POST);
      expect(await page.$eval('input[type="checkbox"]', (box) => (box as HTMLInputElement).checked)).toBe(true);
      await page.click('label ::-p-text(With changes)');
      expect(await storedFeedback(store, id, (feedback) => feedback?.answer === 'with_changes')).toMatchObject({ answer: 'with_changes', postUrl: POST, mayShow: true });
      expect(blockedRequests()).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it('saves "Not yet" with no link, and takes the link away again', async () => {
    const id = await seedOrder(app.fakeDir, 'delivered');
    const { browser, page, blockedRequests } = await launchPage(app);
    try {
      await openDelivered(page, orderUrl(app, id));
      await page.type(LINK_FIELD, POST);
      await page.click('label ::-p-text(You can show this post as an example)');
      await page.click('label ::-p-text(Not yet)');
      expect(await storedFeedback(store, id, (feedback) => feedback !== null)).toMatchObject({ answer: 'not_yet', postUrl: POST, mayShow: true });

      // Cleared, the link goes and the permission with it: the page does not keep one for a post it does not know.
      await page.click(LINK_FIELD, { count: 3 });
      await page.keyboard.press('Backspace');
      expect(await page.$eval('input[type="checkbox"]', (box) => ({ disabled: (box as HTMLInputElement).disabled, checked: (box as HTMLInputElement).checked }))).toEqual({ disabled: true, checked: false });
      await page.click('button ::-p-text(Save)');
      expect(await storedFeedback(store, id, (feedback) => feedback?.postUrl === null)).toMatchObject({ answer: 'not_yet', postUrl: null, mayShow: false });
      expect(blockedRequests()).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it('keeps what was typed when a save fails, and never blocks the downloads', async () => {
    const id = await seedOrder(app.fakeDir, 'delivered');
    const { browser, page, answerForApp, blockedRequests } = await launchPage(app);
    try {
      let failing = true;
      const attempts: string[] = [];
      answerForApp((request) => {
        if (!isFeedbackPost(request)) return null;
        attempts.push(request.postData() ?? '');
        return failing ? { status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable' }) } : null;
      });
      await openDelivered(page, orderUrl(app, id));
      await page.click('label ::-p-text(As is)');
      await waitForText(page, FAILED, SAVES);
      await page.type(LINK_FIELD, POST);
      await page.click('button ::-p-text(Save)');
      for (const deadline = Date.now() + SAVES.timeout; attempts.length < 2; await new Promise((done) => setTimeout(done, 50))) {
        if (Date.now() > deadline) throw new Error(`The second save was never sent (${attempts.length} so far).`);
      }
      await waitForText(page, FAILED, SAVES);
      expect(attempts.map((body) => JSON.parse(body) as unknown)).toEqual([{ answer: 'as_is' }, { answer: 'as_is', postUrl: POST, mayShow: false }]);
      expect(await store.getFeedback(id)).toBeNull();
      // What was chosen and typed is still there, and so is everything else on the page.
      expect(await page.$eval(LINK_FIELD, (field) => (field as HTMLInputElement).value)).toBe(POST);
      expect(await page.$$eval('input[type="radio"]', (radios) => radios.filter((radio) => (radio as HTMLInputElement).checked).map((radio) => (radio as HTMLInputElement).value))).toEqual(['as_is']);
      expect(await page.$$eval('a[download], a[href^="https://x.com/intent"]', (links) => links.map((link) => link.textContent))).toEqual(['Download MP4', 'Muted version', 'Post on X']);

      // The next try goes through.
      failing = false;
      await page.click('button ::-p-text(Save)');
      expect(await storedFeedback(store, id, (feedback) => feedback !== null)).toMatchObject({ answer: 'as_is', postUrl: POST });
      await waitForText(page, 'Saved', SAVES);
      expect(blockedRequests()).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it('asks for an answer and for a whole link before it saves', async () => {
    const id = await seedOrder(app.fakeDir, 'delivered');
    const { browser, page, answerForApp, blockedRequests } = await launchPage(app);
    try {
      const attempts: string[] = [];
      answerForApp((request) => {
        if (isFeedbackPost(request)) attempts.push(request.postData() ?? '');
        return null;
      });
      await openDelivered(page, orderUrl(app, id));
      // Nothing is chosen yet: the button says so, and sends nothing.
      await page.click('button ::-p-text(Save)');
      await waitForText(page, 'Choose one of the answers first.', SAVES);
      expect(attempts).toEqual([]);

      await page.click('label ::-p-text(With changes)');
      await storedFeedback(store, id, (feedback) => feedback !== null);
      await page.type(LINK_FIELD, 'http://x.com/cobrame/status/1');
      await page.click('button ::-p-text(Save)');
      await waitForText(page, 'Paste the whole link to your post, starting with https://.', SAVES);
      expect(attempts).toHaveLength(1);
      expect((await store.getFeedback(id))?.postUrl).toBeNull();
      expect(await page.$eval(LINK_FIELD, (field) => (field as HTMLInputElement).value)).toBe('http://x.com/cobrame/status/1');
      expect(blockedRequests()).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it('has no horizontal scroll at 390 px', async () => {
    // Words that do not break, the longest a site can put in a quote or a section: they wrap inside their box.
    const unbroken = 'u'.repeat(400);
    const id = await seedOrder(app.fakeDir, 'delivered', {
      summary: {
        music: SEEDED_SUMMARY.music,
        claims: [
          { onScreen: `Get paid ${unbroken}`, quote: `Invoices ${unbroken} that chase themselves.`, url: `https://cobrame.example/${unbroken}`, section: unbroken },
          ...SEEDED_SUMMARY.claims,
        ],
      },
    });
    const { browser, page, blockedRequests } = await launchPage(app);
    try {
      for (const width of [390, 1280]) {
        await page.setViewport({ width, height: 900 });
        await openDelivered(page, orderUrl(app, id));
        const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
        expect(scrollWidth, `${width} px`).toBeLessThanOrEqual(innerWidth);
        // The video fits its column.
        const box = await page.$eval('video', (element) => element.getBoundingClientRect().toJSON() as { left: number; right: number });
        expect(box.left, `${width} px`).toBeGreaterThanOrEqual(0);
        expect(box.right, `${width} px`).toBeLessThanOrEqual(innerWidth);
      }
      expect(blockedRequests()).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
