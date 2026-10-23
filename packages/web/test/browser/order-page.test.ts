// The order page as a person sees it: it follows the order every 5 s as the flow moves it, shows each end state at once
// and never goes on asking after one, and fits a phone as well as a computer. The test moves a seeded order by writing
// to the fake store the app reads, the way the flow does.
import type { HTTPRequest, Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileStore } from '../../src/adapters/fake/store';
import { TOKENS } from '../../src/payments/tokens';
import { launchPage, startApp, type App } from './support/app';
import { SEEDED_PAYER, seedOrder } from './support/seed';

/** How long any one thing may take to show: a first compile of the page included. */
const WAIT = { timeout: 60_000 };
/** The page asks every 5 s: a change in the store shows within this. */
const FOLLOWS = { timeout: 7_000 };
const CURRENT = '[aria-current="step"]';
const PROTOCOL_WORDS = ['x402', 'EIP-3009', 'facilitator', 'settlement', 'nonce', 'authorization'];

const orderUrl = (app: App, id: string): string => `${app.url}/o/${id}`;

/** What the page says, as a person reads it. */
const said = (page: Page): Promise<string> => page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));

/** Waits until the current step of the page says `label`. */
const waitForCurrent = (page: Page, label: string, options: { timeout: number }): Promise<unknown> =>
  page.waitForFunction((wanted) => document.querySelector('[aria-current="step"]')?.textContent?.includes(wanted) === true, options, label);

/** Waits until the page's own text says `text`. */
const waitForText = (page: Page, text: string, options: { timeout: number }): Promise<unknown> =>
  page.waitForFunction((wanted) => document.body.innerText.replace(/\s+/g, ' ').includes(wanted), options, text);

const isStatusRequest = (request: HTTPRequest): boolean => new URL(request.url()).pathname.startsWith('/v1/videos/');

async function open(page: Page, url: string): Promise<number | undefined> {
  return (await page.goto(url, { waitUntil: 'load', timeout: WAIT.timeout }))?.status();
}

/** Waits for the page to ask for its order's status once and get the answer: the page runs in the browser from then on. */
async function waitForFirstPoll(page: Page): Promise<void> {
  await page.waitForResponse((response) => new URL(response.url()).pathname.startsWith('/v1/videos/') && response.ok(), { timeout: 30_000 });
}

describe('the order page', () => {
  let app: App;
  let store: FileStore;
  beforeAll(async () => {
    app = await startApp();
    store = new FileStore(app.fakeDir);
    // The first request to a page or a route compiles it: warm both, so the waits below time the page and not Next.
    const id = await seedOrder(app.fakeDir, 'running');
    for (const path of [`/o/${id}`, `/v1/videos/${id}`]) await (await fetch(`${app.url}${path}`, { signal: AbortSignal.timeout(WAIT.timeout) })).arrayBuffer();
  });
  afterAll(async () => {
    await app?.stop();
  });

  it('updates as the order moves', async () => {
    const id = await seedOrder(app.fakeDir, 'running');
    const { browser, page, blockedRequests } = await launchPage(app);
    try {
      expect(await open(page, orderUrl(app, id))).toBe(200);
      const first = await said(page);
      expect(first).toContain(`cobrame.example · order ${id.slice(4, 12)}…`);
      expect(first).toContain('Making your video');
      expect(first).toContain('Usually about 8 minutes. You can close this tab — this link brings you back here.');
      for (const word of PROTOCOL_WORDS) expect(first.toLowerCase(), word).not.toContain(word.toLowerCase());
      expect(await page.$eval('meta[name="robots"]', (meta) => meta.getAttribute('content'))).toBe('noindex, nofollow');

      // The capture is running: it is the step the page marks as now, and the one before it is done.
      await waitForCurrent(page, 'Site captured', WAIT);
      expect(await page.$$eval('ol li', (items) => items.map((item) => item.getAttribute('data-state')))).toEqual(['done', 'now', 'todo', 'todo', 'todo', 'todo', 'todo']);

      // From here the page runs in the browser and follows the order: the capture ends and the script starts.
      await waitForFirstPoll(page);
      await store.setStep(id, 'capture', 'done');
      await store.setStep(id, 'script', 'running');
      await waitForCurrent(page, 'Script written, every line sourced', FOLLOWS);
      expect(await page.$$eval('ol li', (items) => items.map((item) => item.getAttribute('data-state')))).toEqual(['done', 'done', 'now', 'todo', 'todo', 'todo', 'todo']);
      expect(blockedRequests()).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it('copies the link to the order', async () => {
    const id = await seedOrder(app.fakeDir, 'running');
    const { browser, page, blockedRequests } = await launchPage(app);
    try {
      await browser.defaultBrowserContext().overridePermissions(app.url, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
      expect(await open(page, orderUrl(app, id))).toBe(200);
      // The button works once the page runs in the browser.
      await waitForFirstPoll(page);
      await page.bringToFront();
      const button = await page.waitForSelector('button ::-p-text(Copy link)', WAIT);
      await button?.click();
      await waitForText(page, 'Copied', { timeout: 5_000 });
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(orderUrl(app, id));
      expect(blockedRequests()).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it('selects the link for the person to copy when the browser will not copy it', async () => {
    const id = await seedOrder(app.fakeDir, 'running');
    const { browser, page, blockedRequests } = await launchPage(app);
    try {
      // No permission for the clipboard here: the browser refuses the copy.
      expect(await open(page, orderUrl(app, id))).toBe(200);
      await waitForFirstPoll(page);
      const button = await page.waitForSelector('button ::-p-text(Copy link)', WAIT);
      await button?.click();
      await waitForText(page, 'Link selected. Copy it from here.', { timeout: 5_000 });
      expect(await page.$eval('input', (field) => [field.selectionStart, field.selectionEnd, field.value.length])).toEqual([0, orderUrl(app, id).length, orderUrl(app, id).length]);
      expect(blockedRequests()).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it('shows each terminal state without polling', async () => {
    const orders: Record<string, { id: string; message: string; extra?: string }> = {
      refunded: { id: await seedOrder(app.fakeDir, 'refunded'), message: "We couldn't make a video that passes our check. Your payment is on its way back.", extra: 'Refund: sent.' },
      unpaid: { id: await seedOrder(app.fakeDir, 'unpaid'), message: "The payment didn't go through. Nothing was charged." },
      expired: { id: await seedOrder(app.fakeDir, 'expired'), message: "This order's files have expired." },
    };
    await Promise.all(
      Object.entries(orders).map(async ([state, { id, message, extra }]) => {
        const { browser, page, blockedRequests } = await launchPage(app);
        try {
          const asked: string[] = [];
          page.on('request', (request) => {
            if (isStatusRequest(request)) asked.push(request.url());
          });
          expect(await open(page, orderUrl(app, id)), state).toBe(200);
          // The message is there at once, not after a wait, and it is no page of a video being made.
          const first = (await said(page)).replace(/’/g, "'");
          expect(first, state).toContain(message);
          if (extra !== undefined) expect(first, state).toContain(extra);
          expect(first, state).not.toContain('Making your video');
          // Longer than the page waits between two questions, from a page that is running by now.
          await new Promise((done) => setTimeout(done, 8_000));
          expect(asked, `${state}: the status was asked for after the page showed an end`).toEqual([]);
          expect(blockedRequests(), state).toEqual([]);
        } finally {
          await browser.close();
        }
      }),
    );
  });

  it('follows a refund from on its way to sent', async () => {
    const id = await seedOrder(app.fakeDir, 'running');
    const txHash = `0x${'ab'.repeat(32)}`;
    await store.transition(id, 'refunding', { failureReason: 'capture', steps: { payment: 'done', vm: 'done', capture: 'failed', refund: 'running' } });
    await store.insertRefund({
      orderId: id,
      to: SEEDED_PAYER,
      asset: TOKENS.USDT.address,
      amount: 50_000n,
      status: 'broadcast',
      reason: 'capture',
      rawTx: null,
      txHash,
      nonce: 0,
      signer: `0x${'e'.repeat(40)}`,
    });
    const { browser, page, blockedRequests } = await launchPage(app);
    try {
      expect(await open(page, orderUrl(app, id))).toBe(200);
      expect((await said(page)).replace(/’/g, "'")).toContain("We couldn't make a video that passes our check. Your payment is on its way back. Refund: on its way.");
      expect(await page.$$eval('ol li', (items) => items.map((item) => item.getAttribute('data-state')))).toEqual(['done', 'failed', 'todo', 'todo', 'todo', 'todo', 'todo', 'now']);

      // It is not over, so the page goes on asking, and shows the end when it comes.
      await waitForFirstPoll(page);
      await store.updateRefund(id, txHash, { status: 'confirmed' });
      await store.transition(id, 'refunded');
      await store.setStep(id, 'refund', 'done');
      await waitForText(page, 'Refund: sent.', FOLLOWS);
      expect(await page.$$eval('a', (links) => links.map((link) => link.href))).toContain(`https://celoscan.io/tx/${txHash}`);
      expect(await page.$$eval('ol li', (items) => items.map((item) => item.getAttribute('data-state')))).toEqual(['done', 'failed', 'todo', 'todo', 'todo', 'todo', 'todo', 'done']);
      expect(blockedRequests()).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it('answers 404 for an unknown order', async () => {
    const { browser, page, blockedRequests } = await launchPage(app);
    try {
      expect(await open(page, orderUrl(app, 'ord_aaaaaaaaaaaaaaaaaaaaaaaa'))).toBe(404);
      expect(blockedRequests()).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it('has no horizontal scroll at 390 and 1280 px', async () => {
    const ids = [await seedOrder(app.fakeDir, 'running'), await seedOrder(app.fakeDir, 'refunded'), await seedOrder(app.fakeDir, 'delivered')];
    const { browser, page, blockedRequests } = await launchPage(app);
    try {
      for (const id of ids) {
        for (const width of [1280, 390]) {
          await page.setViewport({ width, height: 900 });
          expect(await open(page, orderUrl(app, id))).toBe(200);
          const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
          expect(scrollWidth, `${id} at ${width} px`).toBeLessThanOrEqual(innerWidth);
        }
      }
      expect(blockedRequests()).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
