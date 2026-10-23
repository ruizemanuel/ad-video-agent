// What the order form asks the service before any money is involved: the free quote of POST /v1/videos (for the wallet
// that will pay, when the form names it) and the offer of GET /v1/offer, read from answers shaped as the service's.
import { encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { describe, expect, it } from 'vitest';
import { PAYER_HINT_HEADER } from '../src/payments/x402';
import { TOKENS } from '../src/payments/tokens';
import { ORDER_FORM } from '../src/site/copy';
import { normalizeUrl, PAYER_HEADER, requestOffer, requestQuote, type OrderInput } from '../src/site/quote';

const PAYTO = `0x${'d'.repeat(40)}`;
const PAYER = '0x1234567890AbcdEF1234567890aBcdef12345678';
const INPUT: OrderInput = { url: 'https://tiendita.example/', brief: 'For freelancers', extraUrls: ['https://tiendita.example/app'], audio: 'none' };

/** What the PAYMENT-REQUIRED header of a 402 carries: the same amount in USDT and in USDC. */
const required = (amount: string): PaymentRequired => ({
  x402Version: 2,
  resource: { url: 'https://ad-video-agent.example/v1/videos', description: 'Ad video package', mimeType: 'application/json' },
  accepts: (['USDT', 'USDC'] as const).map((symbol) => ({
    scheme: 'exact',
    network: 'eip155:42220',
    amount,
    asset: TOKENS[symbol].address,
    payTo: PAYTO,
    maxTimeoutSeconds: 300,
    extra: { ...TOKENS[symbol].extra },
  })),
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const quote402 = (amount: string, body: Record<string, unknown>): Response =>
  json(402, { termsUrl: 'https://ad-video-agent.example/terms', ...body }, { 'payment-required': encodePaymentRequiredHeader(required(amount)) });

type Sent = { url: string; method?: string; headers: Headers; body: unknown };

/** A fetch that gives `answer` and keeps what it was asked. */
function fakeFetch(answer: () => Response): { fetcher: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    sent.push({ url: String(input), method: init?.method, headers: new Headers(init?.headers), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    return answer();
  };
  return { fetcher, sent };
}

describe('requestQuote', () => {
  it('reads the price and the thin hint from a 402', async () => {
    const thin = fakeFetch(() =>
      quote402('50000', { precheck: { thinSite: true, hint: 'Add extraUrls.' }, price: { amount: '0.05', assets: ['USDT', 'USDC'] } }),
    );
    const quote = await requestQuote(INPUT, undefined, thin.fetcher);
    expect(quote).toEqual({
      kind: 'priced',
      required: required('50000'),
      amountAtomic: 50_000n,
      price: '0.05',
      thin: true,
      hint: 'Add extraUrls.',
      termsUrl: 'https://ad-video-agent.example/terms',
    });
    // The order goes as the form gives it, to the service's own address.
    expect(thin.sent).toEqual([{ url: '/v1/videos', method: 'POST', headers: expect.any(Headers), body: INPUT }]);
    expect(thin.sent[0]?.headers.get('content-type')).toBe('application/json');

    const rich = fakeFetch(() => quote402('50000', { precheck: { thinSite: false }, price: { amount: '0.05', assets: ['USDT', 'USDC'] } }));
    const richQuote = await requestQuote(INPUT, undefined, rich.fetcher);
    expect(richQuote).toMatchObject({ kind: 'priced', thin: false });
    expect(richQuote).not.toHaveProperty('hint');
  });

  it('takes the amount to pay from the header, and the body’s price only as text to show', async () => {
    const { fetcher } = fakeFetch(() => quote402('10000', { precheck: { thinSite: false }, price: { amount: '0.05', assets: ['USDT', 'USDC'] } }));
    expect(await requestQuote(INPUT, PAYER, fetcher)).toMatchObject({ amountAtomic: 10_000n, price: '0.05' });

    // With no text in the body, the amount itself is shown.
    const bare = fakeFetch(() => quote402('2000000', { precheck: { thinSite: false } }));
    expect(await requestQuote(INPUT, undefined, bare.fetcher)).toMatchObject({ amountAtomic: 2_000_000n, price: '2' });
  });

  it('returns the reason of a 400 or 422', async () => {
    const invalid = fakeFetch(() => json(400, { error: 'invalid_request', reason: 'url: Invalid URL' }));
    expect(await requestQuote(INPUT, undefined, invalid.fetcher)).toEqual({ kind: 'refused', reason: 'url: Invalid URL' });
    const login = fakeFetch(() => json(422, { error: 'login_wall', reason: 'The site asks for a login before it shows anything.' }));
    expect(await requestQuote(INPUT, undefined, login.fetcher)).toEqual({ kind: 'refused', reason: 'The site asks for a login before it shows anything.' });
    // The service always says why; should it not, the page says it plainly.
    const silent = fakeFetch(() => json(422, { error: 'login_wall' }));
    expect(await requestQuote(INPUT, undefined, silent.fetcher)).toEqual({ kind: 'refused', reason: ORDER_FORM.errors.refused });
  });

  it('returns retryAfter of a 503', async () => {
    const capped = fakeFetch(() => json(503, { error: 'precheck_unavailable', reason: 'Later.' }, { 'retry-after': '3600' }));
    expect(await requestQuote(INPUT, undefined, capped.fetcher)).toEqual({ kind: 'unavailable', retryAfterSeconds: 3600 });
    // A 503 that does not say when: a minute.
    const silent = fakeFetch(() => json(503, { error: 'precheck_unavailable', reason: 'Later.' }));
    expect(await requestQuote(INPUT, undefined, silent.fetcher)).toEqual({ kind: 'unavailable', retryAfterSeconds: 60 });
  });

  it('sends x-payer only when given', async () => {
    const answer = () => quote402('50000', { precheck: { thinSite: false }, price: { amount: '0.05', assets: ['USDT', 'USDC'] } });
    const anonymous = fakeFetch(answer);
    await requestQuote(INPUT, undefined, anonymous.fetcher);
    expect(anonymous.sent[0]?.headers.has(PAYER_HEADER)).toBe(false);

    const named = fakeFetch(answer);
    await requestQuote(INPUT, PAYER, named.fetcher);
    expect(named.sent[0]?.headers.get(PAYER_HEADER)).toBe(PAYER);
    // The header the service reads.
    expect(PAYER_HEADER).toBe(PAYER_HINT_HEADER);
  });

  it('throws on an answer that is no quote', async () => {
    const broken = fakeFetch(() => new Response('<h1>Internal Server Error</h1>', { status: 500 }));
    await expect(requestQuote(INPUT, undefined, broken.fetcher)).rejects.toThrow(/500/);
    // A 402 with no price in its header has nothing to sign.
    const unpriced = fakeFetch(() => json(402, { precheck: { thinSite: false } }));
    await expect(requestQuote(INPUT, undefined, unpriced.fetcher)).rejects.toThrow();
    // Nor does one that asks a different amount in each token.
    const split = required('50000');
    split.accepts[1] = { ...split.accepts[1]!, amount: '60000' };
    const uneven = fakeFetch(() => json(402, { precheck: { thinSite: false } }, { 'payment-required': encodePaymentRequiredHeader(split) }));
    await expect(requestQuote(INPUT, undefined, uneven.fetcher)).rejects.toThrow();
  });
});

describe('requestOffer', () => {
  it('reads the price and the promo of GET /v1/offer', async () => {
    const on = fakeFetch(() => json(200, { price: '2', assets: ['USDT', 'USDC'], promo: { price: '0.01', left: 7 } }));
    expect(await requestOffer(on.fetcher)).toEqual({ price: '2', promo: { price: '0.01', left: 7 } });
    expect(on.sent[0]?.url).toBe('/v1/offer');

    const off = fakeFetch(() => json(200, { price: '0.05', assets: ['USDT', 'USDC'], promo: null }));
    expect(await requestOffer(off.fetcher)).toEqual({ price: '0.05', promo: null });

    const down = fakeFetch(() => new Response('', { status: 500 }));
    await expect(requestOffer(down.fetcher)).rejects.toThrow();
  });
});

describe('normalizeUrl', () => {
  it('takes a site with or without its scheme, adding https:// when it has none', () => {
    expect(normalizeUrl('yourproject.xyz')).toBe('https://yourproject.xyz/');
    expect(normalizeUrl('  https://yourproject.xyz/app?x=1  ')).toBe('https://yourproject.xyz/app?x=1');
    expect(normalizeUrl('http://yourproject.xyz')).toBe('http://yourproject.xyz/');
    expect(normalizeUrl('HTTPS://YourProject.xyz')).toBe('https://yourproject.xyz/');
    expect(normalizeUrl('yourproject.xyz:8080/app')).toBe('https://yourproject.xyz:8080/app');
  });

  it('refuses what is not an http(s) address with a host', () => {
    for (const text of ['', '   ', 'ftp://yourproject.xyz', 'javascript:alert(1)', 'mailto:me@yourproject.xyz', 'https://', 'your project.xyz', 'https://me:secret@yourproject.xyz']) {
      expect(normalizeUrl(text), text).toBeNull();
    }
  });
});
