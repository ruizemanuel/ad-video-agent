import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { getAdapters } from '../src/adapters';
import OrderPage, { dynamic, metadata } from '../src/app/o/[id]/page';
import { GET } from '../src/app/v1/videos/[id]/route';
import { readStatus, type StatusJson } from '../src/payments/orders';
import { ORDER_STATUSES } from '../src/ports';
import { OrderView } from '../src/site/OrderView';
import { seedOrder, SEEDED_PAYER, type SeedState } from './browser/support/seed';

const BASE = 'https://ad-video-agent.example.com';
const SETTINGS = { LINK_SIGNING_SECRET: 's'.repeat(40), PUBLIC_BASE_URL: BASE };

// The page reads its settings and its store the way the service does: from the environment, once.
const dir = await mkdtemp(join(tmpdir(), 'order-page-'));
vi.stubEnv('AD_AGENT_ADAPTERS', 'fake');
vi.stubEnv('FAKE_DIR', dir);
vi.stubEnv('PAYTO_ADDRESS', `0x${'1'.repeat(40)}`);
vi.stubEnv('LINK_SIGNING_SECRET', SETTINGS.LINK_SIGNING_SECRET);
vi.stubEnv('CRON_SECRET', 'c'.repeat(40));
vi.stubEnv('PUBLIC_BASE_URL', BASE);
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const { store } = await getAdapters();

/** The order page, as the server renders it for this order. */
async function renderPage(id: string): Promise<string> {
  return renderToStaticMarkup(await OrderPage({ params: Promise.resolve({ id }) }));
}

/** The text of some markup, without its tags, with its entities and typographic apostrophes as plain characters. */
const text = (html: string, tagsAs = ''): string =>
  html
    .replace(/<[^>]+>/g, tagsAs)
    .replace(/&#x27;|&#39;|’/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** The words of some markup, as one line. */
const words = (html: string): string => text(html, ' ').replace(/\s+/g, ' ');

/** The steps listed, each with the state it carries and its words. */
const rows = (html: string): { state: string; words: string }[] =>
  [...html.matchAll(/<li [^>]*data-state="(\w+)"[^>]*>([\s\S]*?)<\/li>/g)].map((match) => ({ state: match[1] ?? '', words: words(match[2] ?? '').trim() }));

const links = (html: string): { href: string; words: string }[] =>
  [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((match) => ({ href: text(match[1] ?? ''), words: words(match[2] ?? '').trim() }));

const PROTOCOL_WORDS = ['x402', 'EIP-3009', 'facilitator', 'settlement', 'nonce', 'authorization'];

const REFUND_REASON = "We couldn't make a video that passes our check. Your payment is on its way back.";

describe('the order page', () => {
  it('shows each terminal state without polling', async () => {
    const refunded = await seedOrder(dir, 'refunded');
    const refund = await store.getRefund(refunded);
    const unpaid = await seedOrder(dir, 'unpaid');
    const expired = await seedOrder(dir, 'expired');
    const delivered = await seedOrder(dir, 'delivered');

    // Rendering runs no effect, so this watches only what a render could schedule by itself; the polling is what
    // followStatus does (site-progress.test.ts) and what the browser sees (browser/order-page.test.ts).
    const scheduled = [vi.spyOn(globalThis, 'setTimeout'), vi.spyOn(globalThis, 'setInterval'), vi.spyOn(globalThis, 'fetch')];
    const refundedHtml = await renderPage(refunded);
    const unpaidHtml = await renderPage(unpaid);
    const expiredHtml = await renderPage(expired);
    const deliveredHtml = await renderPage(delivered);
    for (const spy of scheduled) expect(spy).not.toHaveBeenCalled();

    expect(refund?.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(words(refundedHtml)).toContain(REFUND_REASON);
    expect(words(refundedHtml)).toContain('Refund: sent.');
    expect(links(refundedHtml)).toContainEqual({ href: `https://celoscan.io/tx/${refund?.txHash}`, words: 'View the transaction' });

    expect(words(unpaidHtml)).toContain("The payment didn't go through. Nothing was charged.");
    expect(words(expiredHtml)).toContain("This order's files have expired.");

    // The delivery (delivered-view.test.ts has its details): the two videos behind links signed for 30 days.
    expect(words(deliveredHtml)).toContain('Your video is ready');
    const files = links(deliveredHtml).filter(({ href }) => href.startsWith(`${BASE}/v1/files/${delivered}/`));
    expect(files.map(({ words }) => words)).toEqual(['Download MP4', 'Muted version']);

    // None of them is shown as being made, and none offers the link to come back to.
    for (const html of [refundedHtml, unpaidHtml, expiredHtml, deliveredHtml]) {
      expect(words(html)).not.toContain('Making your video');
      expect(words(html)).not.toContain('Copy link');
    }
  });

  it('answers 404 for an unknown order', async () => {
    await expect(renderPage('ord_doesnotexist')).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_HTTP_ERROR_FALLBACK;404$/) });
    // Nothing that is not an order's id gets further than the store.
    await expect(renderPage('../../etc/passwd')).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_HTTP_ERROR_FALLBACK;404$/) });
  });

  it('says the video is being made, with its steps, the link to come back and the refund promise', async () => {
    const id = await seedOrder(dir, 'running');
    const html = await renderPage(id);
    const said = words(html);
    expect(said).toContain('Making your video');
    expect(said).toContain('Usually about 8 minutes. You can close this tab — this link brings you back here.');
    expect(said).toContain('Copy link');
    expect(said).toContain("If the video can't pass our quality check");
    expect(said).toContain('your payment goes back to your wallet automatically.');
    // The link is the order's own, as the service is addressed.
    expect(/<input [^>]*value="([^"]+)"/.exec(html)?.[1]).toBe(`${BASE}/o/${id}`);

    expect(rows(html)).toEqual([
      { state: 'done', words: expect.stringContaining('Payment received') },
      { state: 'now', words: expect.stringContaining('Site captured') },
      { state: 'todo', words: expect.stringContaining('Script written, every line sourced') },
      { state: 'todo', words: expect.stringContaining('Music chosen') },
      { state: 'todo', words: expect.stringContaining('Key frames ready') },
      { state: 'todo', words: expect.stringContaining('Quality check') },
      { state: 'todo', words: expect.stringContaining('Final video') },
    ]);
  });

  it('shows no music step for an order without audio', async () => {
    const id = await seedOrder(dir, 'running');
    const status = (await readStatus(store, id, SETTINGS))?.status as StatusJson;
    const html = renderToStaticMarkup(createElement(OrderView, { initial: status, audio: 'none', site: 'cobrame.example', siteUrl: 'https://cobrame.example/', shortId: id.slice(4, 12), link: `${BASE}/o/${id}` }));
    expect(rows(html).map((row) => row.words)).not.toContainEqual(expect.stringContaining('Music chosen'));
    expect(rows(html)).toHaveLength(6);
  });

  it('names the site and the order, with the start of its number', async () => {
    const id = await seedOrder(dir, 'running');
    expect(id).toMatch(/^ord_[a-z2-7]{24}$/);
    expect(words(await renderPage(id))).toContain(`cobrame.example · order ${id.slice(4, 12)}…`);
  });

  it('keeps the page out of search engines and reads the order when asked', async () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(dynamic).toBe('force-dynamic');
  });

  it('keeps protocol words out of every state', async () => {
    for (const state of ['running', 'delivered', 'refunded', 'unpaid', 'expired'] as SeedState[]) {
      const said = words(await renderPage(await seedOrder(dir, state))).toLowerCase();
      for (const word of PROTOCOL_WORDS) expect(said, `${state}: ${word}`).not.toContain(word.toLowerCase());
    }
  });
});

describe('the refund of an order', () => {
  const HASH = `0x${'ab'.repeat(32)}`;
  const view = (status: StatusJson['status'], refund?: StatusJson['refund'], refundStep?: 'running' | 'done' | 'failed'): string =>
    renderToStaticMarkup(
      createElement(OrderView, {
        initial: {
          id: 'ord_abcdefgh2345678abcdefgh2',
          status,
          steps: [
            { name: 'payment', state: 'done' },
            { name: 'capture', state: 'failed' },
            { name: 'refund', state: refundStep ?? (status === 'refunded' ? 'done' : status === 'refund_failed' ? 'failed' : 'running') },
          ],
          warnings: [],
          ...(refund === undefined ? {} : { refund }),
        },
        audio: 'music',
        site: 'cobrame.example',
        siteUrl: 'https://cobrame.example/',
        shortId: 'abcdefgh',
        link: `${BASE}/o/ord_abcdefgh2345678abcdefgh2`,
      }),
    );

  it('says it is on its way while it is being sent', () => {
    const html = view('refunding', { status: 'broadcast', txHash: null });
    expect(words(html)).toContain(`${REFUND_REASON} Refund: on its way.`);
    expect(links(html).filter(({ href }) => href.includes('celoscan'))).toEqual([]);
  });

  it('says it was sent, with the transaction to look at', () => {
    const html = view('refunded', { status: 'confirmed', txHash: HASH });
    expect(words(html)).toContain(`${REFUND_REASON} Refund: sent.`);
    expect(links(html)).toContainEqual({ href: `https://celoscan.io/tx/${HASH}`, words: 'View the transaction' });
    // No link when there is no transaction to point at.
    expect(links(view('refunded', { status: 'confirmed', txHash: null })).filter(({ href }) => href.includes('celoscan'))).toEqual([]);
  });

  it('says it is delayed, and that it will still reach the wallet that paid', () => {
    const html = view('refund_failed', { status: 'reverted', txHash: null });
    expect(words(html)).toContain(`${REFUND_REASON} Refund: delayed. It will still reach the wallet you paid from.`);
  });

  it('shows the refund step as ended once the order says so, whatever the step says', () => {
    // The step can still say `running` when the order is already over, and the page does not poll again to find out.
    const sent = view('refunded', { status: 'confirmed', txHash: HASH }, 'running');
    expect(rows(sent).at(-1)).toEqual({ state: 'done', words: expect.stringContaining('Refund sent') });
    expect(rows(sent).map(({ state }) => state)).not.toContain('now');
    expect(sent).not.toContain('aria-current');

    const delayed = view('refund_failed', { status: 'reverted', txHash: null }, 'running');
    expect(rows(delayed).at(-1)).toEqual({ state: 'failed', words: expect.stringContaining('Refund sent') });
    expect(delayed).not.toContain('aria-current');
  });

  it('shows a page for every status of an order', () => {
    for (const order of ORDER_STATUSES) {
      const html = view(order, undefined, 'running').replace(/<main[^>]*>/, '');
      expect(words(html).trim(), order).not.toBe('');
      expect(html, order).toMatch(/<h1[ >]/);
    }
  });

  it('shows which step failed and the refund step', () => {
    expect(rows(view('refunding')).map(({ state }) => state)).toEqual(['done', 'failed', 'todo', 'todo', 'todo', 'todo', 'todo', 'now']);
  });
});

describe('readStatus', () => {
  it('gives the order and the very status the API gives, or nothing for an unknown id', async () => {
    const id = await seedOrder(dir, 'delivered');
    const read = await readStatus(store, id, SETTINGS);
    expect(read?.order.id).toBe(id);
    expect(read?.order.payer).toBe(SEEDED_PAYER);

    const res = await GET(new Request(`${BASE}/v1/videos/${id}`), { params: Promise.resolve({ id }) });
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(read?.status)));

    expect(await readStatus(store, 'ord_doesnotexist', SETTINGS)).toBeNull();
  });
});
