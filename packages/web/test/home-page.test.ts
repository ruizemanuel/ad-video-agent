import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * The home as the server renders it with the settings the service would read from its environment. env() keeps what it
 * first reads, so each render starts afresh.
 */
async function render(settings: Record<string, string> = {}) {
  const stubs = {
    AD_AGENT_ADAPTERS: 'fake',
    PAYTO_ADDRESS: `0x${'1'.repeat(40)}`,
    LINK_SIGNING_SECRET: 's'.repeat(40),
    CRON_SECRET: 'c'.repeat(40),
    PRICE_ATOMIC: '50000',
    ...settings,
  };
  for (const [name, value] of Object.entries(stubs)) vi.stubEnv(name, value);
  vi.resetModules();
  const page = await import('../src/app/page');
  return { page, html: renderToStaticMarkup(createElement(page.default)) };
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

/** The example the agents section gives, as the design fixes it. */
const BUY_EXAMPLE = `npx @celo/buy curl --token USDT --max-amount 2 -X POST -H 'content-type: application/json' \\
  --data '{"url":"https://yourproject.xyz"}' https://advideoagent.com/v1/videos`;

/** The element with this id, from its opening tag to the closing tag of the same name (no element of that name inside). */
const byId = (html: string, id: string): string => {
  const match = new RegExp(`<(\\w+)[^>]* id="${id}"[^>]*>[\\s\\S]*?</\\1>`).exec(html);
  if (match === null) throw new Error(`The home has no element with id "${id}".`);
  return match[0];
};

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));

describe('the home page', () => {
  it('says what it is, what it costs to try and how refunds work', async () => {
    const { html } = await render({ PRICE_ATOMIC: '2000000' });
    const said = words(html);
    expect(said).toContain('Your site, as a video ad. Ready to post.');
    expect(said).toContain('Paste your URL. In about 8 minutes you get a vertical video made from your real product');
    expect(said).toContain('2 USDT or USDC');
    expect(said).toContain(
      "Pay with USDT or USDC on Celo. No gas, no account. If we can't deliver, the payment goes back to your wallet automatically.",
    );

    // The price is the one in the settings, never one written in the page.
    const cheap = words((await render({ PRICE_ATOMIC: '50000' })).html);
    expect(cheap).toContain('0.05 USDT or USDC');
    expect(cheap).not.toMatch(/(^|[^.\d])2 USDT/);
  });

  it('renders at request time, where the settings are', async () => {
    const { page } = await render();
    expect(page.dynamic).toBe('force-dynamic');
  });

  it('leaves a place for the order form, with its title', async () => {
    const { html } = await render();
    const order = byId(html, 'order');
    expect(order).toMatch(/^<section /);
    expect(words(order).trim()).toBe('Order your video');
  });

  it('links the terms', async () => {
    const { html } = await render();
    const finePrint = /<p[^>]*>(?:(?!<\/p>)[\s\S])*No gas, no account(?:(?!<\/p>)[\s\S])*<\/p>/.exec(html)?.[0] ?? '';
    expect(finePrint).toMatch(/<a [^>]*href="\/terms"/);
  });

  it('shows both examples with their captions', async () => {
    const { html } = await render();
    const examples = byId(html, 'examples');
    expect(words(examples)).toContain('Made from the site alone, no editing');

    const videos = [...examples.matchAll(/<video [^>]*>/g)].map(([tag]) => ({
      src: /\ssrc="([^"]+)"/.exec(tag)?.[1],
      poster: /\sposter="([^"]+)"/.exec(tag)?.[1],
    }));
    expect(videos).toEqual([
      { src: '/examples/cobrame.mp4', poster: '/examples/cobrame.jpg' },
      { src: '/examples/celo.mp4', poster: '/examples/celo.jpg' },
    ]);
    for (const { src, poster } of videos) {
      expect(existsSync(`${PUBLIC}${src}`), src).toBe(true);
      expect(existsSync(`${PUBLIC}${poster}`), poster).toBe(true);
    }

    const captions = [...examples.matchAll(/<figcaption[^>]*>[\s\S]*?<\/figcaption>/g)].map(([caption]) => words(caption).trim());
    expect(captions).toHaveLength(2);
    expect(captions[0]).toMatch(/^cobrame\.app 19 s$/);
    expect(captions[1]).toMatch(/^celo\.org 20 s Made from the public site, no editing$/);
  });

  it('explains how it works in three steps, and the API for agents with a buy example', async () => {
    const { html } = await render();
    const how = words(byId(html, 'how'));
    expect(how).toMatch(/Paste and pay.*Come back in ~8 min.*Download or post/);

    const agents = byId(html, 'agents');
    expect(agents).toMatch(/^<section /);
    expect(words(agents)).toMatch(/POST \/v1\/videos.*402.*202.*statusUrl.*delivered/);
    const example = /<pre[^>]*>([\s\S]*?)<\/pre>/.exec(agents)?.[1];
    expect(text(example ?? '')).toBe(BUY_EXAMPLE);
  });

  it('keeps protocol words out of everything but the agents section', async () => {
    const { html } = await render();
    const agents = byId(html, 'agents');
    // The words are there, in the one place they may be.
    expect(agents).toMatch(/x402/);
    const rest = html.replace(agents, '');
    for (const word of ['x402', 'EIP-3009', 'facilitator', 'settlement', 'nonce', 'authorization']) {
      expect(rest.toLowerCase(), word).not.toContain(word.toLowerCase());
    }
  });

  it('does not promise a redo yet', async () => {
    const { html } = await render();
    expect(words(html)).not.toMatch(/\bredo|regenerat/i);
  });
});
