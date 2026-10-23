import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePaymentRequiredHeader, decodePaymentSignatureHeader } from '@x402/core/http';
import { NextRequest } from 'next/server';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { start } from 'workflow/api';
import { getAdapters } from '../src/adapters';
import { FakeLlm } from '../src/adapters/fake/llm';
import { FileStore } from '../src/adapters/fake/store';
import { setVideosDeps } from '../src/app/v1/videos/deps';
import { POST } from '../src/app/v1/videos/route';
import { ModelCallFailed, ModelOutputInvalid, type NewOrder, type OrderStore } from '../src/ports';
import { PROMO_PRICE_ATOMIC, TOKENS } from '../src/payments/x402';
import type { FetchedPage } from '../src/precheck/fetch-page';
import { orderWorkflow } from '../src/workflows/order';
import { FAKE_SETTLE_TX, FakeFacilitator } from './support/fake-facilitator';
import { requestFromNext } from './support/next-request';
import { pay as payFor, type PaymentHeaders, type PayOptions } from './support/pay';

vi.mock('workflow/api', () => ({ start: vi.fn(async () => ({ runId: 'wrun_test' })) }));

const BASE = 'https://ad-video-agent.example.com';
const U = 'https://tiendita.example/';
const PAYTO = `0x${'1'.repeat(40)}`;
const THIN_HINT = 'Your site shows little of the product. Adding up to 3 public pages of the app as extraUrls makes a better video.';
const fixture = (name: string): string => readFileSync(new URL(`./precheck/fixtures/${name}`, import.meta.url), 'utf8');
const thinHtml = fixture('thin.html');
const loginHtml = fixture('login.html');
const richHtml = fixture('rich.html');

// The route reads its settings and its store the way the service does: from the environment, once.
const dir = await mkdtemp(join(tmpdir(), 'videos-route-'));
vi.stubEnv('AD_AGENT_ADAPTERS', 'fake');
vi.stubEnv('FAKE_DIR', dir);
vi.stubEnv('PAYTO_ADDRESS', PAYTO);
vi.stubEnv('LINK_SIGNING_SECRET', 's'.repeat(40));
vi.stubEnv('CRON_SECRET', 'c'.repeat(40));
vi.stubEnv('PUBLIC_BASE_URL', BASE);
// The first-video promo is on, for 2 wallets: a client that sends no x-payer header must not notice it.
vi.stubEnv('PROMO_SLOTS', '2');
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

// The outside world of the route, as doubles: every site is the thin one, except an address that says "login" (a
// login wall) or "rich" (a site that shows its product well).
const { store } = await getAdapters();
const llm = new FakeLlm();
const facilitator = new FakeFacilitator();
const fetchPage = vi.fn(async (url: string): Promise<FetchedPage> => {
  const html = url.includes('login') ? loginHtml : url.includes('rich') ? richHtml : thinHtml;
  return { finalUrl: url, status: 200, html };
});
const deps = { store, llm, fetchPage, facilitator };
setVideosDeps(deps);

// Each request reaches the route the way Next hands it over in production: see requestFromNext.
const post = (body: unknown, headers: Record<string, string> = {}) =>
  requestFromNext(`${BASE}/v1/videos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const json = async (res: Response | Promise<Response>) => (await res).json() as Promise<Record<string, unknown>>;
/** Asks for the price of `body`, then signs what the 402 asks for, from a new wallet. */
const pay = async (body: unknown = { url: U }, options: PayOptions = {}): Promise<PaymentHeaders> => payFor(await POST(post(body)), options);
/** The order a payment made, found the way the reconciliation finds it. */
const orderOf = async (headers: PaymentHeaders, inStore: OrderStore = store) => {
  const payment = decodePaymentSignatureHeader(headers['PAYMENT-SIGNATURE']);
  const { from, nonce } = (payment.payload as { authorization: { from: string; nonce: string } }).authorization;
  return inStore.findOrderByPayment(payment.accepted.asset, from, nonce);
};

beforeEach(() => {
  vi.clearAllMocks();
  facilitator.verification = 'valid';
  facilitator.settlement = 'success';
  facilitator.calls.verify = 0;
  facilitator.calls.settle = 0;
});

describe('POST /v1/videos without a payment', () => {
  it('reads the request as Next hands it over, never making a new request from it', async () => {
    // In production this request is not of the class `next/server` gives the route, and no request can be made from it.
    const request = post({ url: 'nope' });
    expect(request).not.toBeInstanceOf(NextRequest);
    expect(() => new Request(request)).toThrow('Cannot read private member #state');
    const res = await POST(request);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('answers 400 without a 402 for an invalid body', async () => {
    const res = await POST(post({ url: 'nope' }));
    expect(res.status).toBe(400);
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
    expect(await res.json()).toMatchObject({ error: 'invalid_request', reason: expect.stringContaining('url') });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('answers 400 for a body that is not JSON', async () => {
    const res = await POST(post('{"url": '));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('answers 400 for audio "voice" (not available yet)', async () => {
    const res = await POST(post({ url: U, audio: 'voice' }));
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'voice_not_available_yet' });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('answers 422 when the pre-check fails, without a 402', async () => {
    const res = await POST(post({ url: 'https://login.example/' }));
    expect(res.status).toBe(422);
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
    expect(await res.json()).toEqual({ error: 'login_wall', reason: expect.stringMatching(/login/i) });
  });

  it('answers 503 without a 402 when the classifier cannot give a verdict, and asks it again next time', async () => {
    const site = 'https://unavailable.example/';
    const before = await store.orderCost('precheck');
    llm.classifySite = async () => {
      throw new ModelOutputInvalid('The classify model did not answer with a valid classification.', 0.0007);
    };
    try {
      const res = await POST(post({ url: site }));
      expect(res.status).toBe(503);
      expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
      expect(res.headers.get('retry-after')).toBe('60');
      expect(await res.json()).toEqual({ error: 'precheck_unavailable', reason: expect.any(String) });
      expect(await store.orderCost('precheck')).toBeCloseTo(before + 0.0007, 6);
    } finally {
      llm.classifySite = async () => ({ admissible: true, reason: 'The site is a normal business site.', usd: 0.0004 });
    }
    const calls = llm.calls.classifySite;
    expect((await POST(post({ url: site }))).status).toBe(402);
    expect(llm.calls.classifySite).toBe(calls + 1);
  });

  it('answers 503 with a retry hint when the classifier call fails without an answer, and asks it again next time', async () => {
    const site = 'https://gateway-down.example/';
    llm.classifySite = async () => {
      throw new ModelCallFailed('classify', 'AI_APICallError', 502);
    };
    try {
      const res = await POST(post({ url: site }));
      expect(res.status).toBe(503);
      expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
      expect(res.headers.get('retry-after')).toBe('60');
      expect(await res.json()).toEqual({ error: 'precheck_unavailable', reason: expect.any(String) });
    } finally {
      llm.classifySite = async () => ({ admissible: true, reason: 'The site is a normal business site.', usd: 0.0004 });
    }
    expect((await POST(post({ url: site }))).status).toBe(402);
  });

  it("answers 503, saying when to try again, once the day's checks have cost PRECHECK_DAILY_CAP_USD, and asks no model", async () => {
    // A store of its own: the cap is over every check of the day.
    const spent = new FileStore(await mkdtemp(join(tmpdir(), 'videos-route-cap-')));
    await spent.addCost('precheck', 'llm:classify', 2, 'card');
    setVideosDeps({ ...deps, store: spent });
    try {
      const calls = llm.calls.classifySite;
      const res = await POST(post({ url: 'https://over-the-cap.example/' }));
      expect(res.status).toBe(503);
      expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
      expect(await res.json()).toEqual({ error: 'precheck_unavailable', reason: expect.any(String) });
      const retryAfter = Number(res.headers.get('retry-after'));
      expect(Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= 24 * 3600).toBe(true);
      expect(llm.calls.classifySite).toBe(calls);
    } finally {
      setVideosDeps(deps);
    }
  });

  describe('the extra pages', () => {
    it('checks each one before asking for a payment, and answers 422 naming the one that fails', async () => {
      const res = await POST(post({ url: U, extraUrls: ['https://rich.example/app', 'https://login.example/account'] }));
      expect(res.status).toBe(422);
      expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
      const body = (await res.json()) as { reason: string };
      expect(body).toEqual({ error: 'login_wall', reason: expect.stringContaining('extraUrls[1] (https://login.example/account)') });
      expect(body.reason).toMatch(/login/i);
    });

    it('asks for the payment when every one passes, and checks each one once a day, as the site', async () => {
      const order = { url: 'https://main-with-extras.example/', extraUrls: ['https://rich.example/pricing', 'https://extras.example/app'] };
      const calls = llm.calls.classifySite;
      expect((await POST(post(order))).status).toBe(402);
      for (const url of order.extraUrls) expect(fetchPage).toHaveBeenCalledWith(url);
      expect(llm.calls.classifySite).toBe(calls + 3);

      expect((await POST(post(order))).status).toBe(402);
      expect(llm.calls.classifySite).toBe(calls + 3);
    });

    it('answers 503 when an extra page cannot be checked, as for the site', async () => {
      llm.classifySite = async (input) => {
        if (input.url.includes('flaky')) throw new ModelCallFailed('classify', 'AI_APICallError');
        return { admissible: true, reason: 'ok', usd: 0.0004 };
      };
      try {
        const res = await POST(post({ url: U, extraUrls: ['https://flaky.example/app'] }));
        expect(res.status).toBe(503);
        expect(res.headers.get('retry-after')).toBe('60');
      } finally {
        llm.classifySite = async () => ({ admissible: true, reason: 'The site is a normal business site.', usd: 0.0004 });
      }
    });
  });

  it('answers 402 with USDT and USDC at PRICE_ATOMIC and the thin-site hint', async () => {
    const res = await POST(post({ url: U }));
    expect(res.status).toBe(402);
    const req = decodePaymentRequiredHeader(res.headers.get('PAYMENT-REQUIRED')!);
    expect(req.accepts.map((a) => [a.asset, a.amount])).toEqual([
      [TOKENS.USDT.address, '5000000'],
      [TOKENS.USDC.address, '5000000'],
    ]);
    expect(await res.json()).toEqual({
      precheck: { thinSite: true, hint: THIN_HINT },
      termsUrl: `${BASE}/terms`,
      price: { amount: '5', assets: ['USDT', 'USDC'] },
    });
  });

  it('asks for the payment on Celo, to the service wallet, signed with the EIP-712 domain of each token', async () => {
    const req = decodePaymentRequiredHeader((await POST(post({ url: U }))).headers.get('PAYMENT-REQUIRED')!);
    expect(req.accepts).toEqual([
      expect.objectContaining({ scheme: 'exact', network: 'eip155:42220', payTo: PAYTO, maxTimeoutSeconds: 300, extra: { name: 'Tether USD', version: '1' } }),
      expect.objectContaining({ scheme: 'exact', network: 'eip155:42220', payTo: PAYTO, maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2' } }),
    ]);
    expect(req.resource.description).toBe(
      'Ad video package from a website URL. Costs 5 USDT or USDC on Celo. x402 clients with a default $1 per-payment cap must raise it.',
    );
  });

  it('gives no hint for a site that shows its product well', async () => {
    const res = await POST(post({ url: 'https://rich.example/' }));
    expect(res.status).toBe(402);
    expect((await json(res)).precheck).toEqual({ thinSite: false });
  });

  it('keeps the price out of every cache', async () => {
    expect((await POST(post({ url: U }))).headers.get('cache-control')).toBe('no-store');
  });
});

describe('POST /v1/videos with a payment', () => {
  it('creates the order on a paid request, answers 202 with Content-Location, then starts the workflow after settlement', async () => {
    const res = await POST(post({ url: U }, await pay()));
    expect(res.status).toBe(202);
    const { orderId, statusUrl } = (await res.json()) as { orderId: string; statusUrl: string };
    expect(statusUrl).toBe(`${BASE}/v1/videos/${orderId}`);
    expect(res.headers.get('Content-Location')).toBe(statusUrl);
    expect((await store.getOrder(orderId))!.status).toBe('paid');
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(orderWorkflow, [orderId]);
  });

  it('records the payment, the settlement and the run on the order', async () => {
    const headers = await pay({ url: U, brief: '  For shops that sell on WhatsApp  ' });
    const res = await POST(post({ url: U, brief: '  For shops that sell on WhatsApp  ' }, headers));
    const { orderId } = (await res.json()) as { orderId: string };
    const order = (await store.getOrder(orderId))!;
    const { authorization } = decodePaymentSignatureHeader(headers['PAYMENT-SIGNATURE']).payload as {
      authorization: { from: string; nonce: string; validAfter: string; validBefore: string };
    };
    expect(order).toMatchObject({
      request: { url: U, brief: 'For shops that sell on WhatsApp', audio: 'music' },
      network: 'eip155:42220',
      asset: TOKENS.USDT.address,
      payer: authorization.from,
      amount: 5_000_000n,
      nonce: authorization.nonce,
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      settleTx: FAKE_SETTLE_TX,
      runId: 'wrun_test',
      steps: { payment: 'done' },
    });
    expect(order.paidAt).toBeInstanceOf(Date);
  });

  it('takes USDC as well as USDT', async () => {
    const res = await POST(post({ url: U }, await pay({ url: U }, { asset: TOKENS.USDC.address })));
    expect(res.status).toBe(202);
    const { orderId } = (await res.json()) as { orderId: string };
    expect((await store.getOrder(orderId))!.asset).toBe(TOKENS.USDC.address);
  });

  it('does not create two orders or two runs for the same payment', async () => {
    const headers = await pay();
    const first = await json(POST(post({ url: U }, headers)));
    const second = await json(POST(post({ url: U }, headers)));
    expect(second.orderId).toBe(first.orderId);
    expect(start).toHaveBeenCalledTimes(1);
    expect((await orderOf(headers))!.id).toBe(first.orderId);
  });

  it('leaves the order awaiting settlement when settle fails, and still tells the payer where it is', async () => {
    const headers = await pay();
    facilitator.settlement = 'failure';
    const res = await POST(post({ url: U }, headers));
    expect(res.status).toBe(402);
    expect(start).not.toHaveBeenCalled();
    const order = (await orderOf(headers))!;
    expect(order).toMatchObject({ status: 'awaiting_settlement', settleTx: null, runId: null, steps: {} });
    const statusUrl = `${BASE}/v1/videos/${order.id}`;
    expect(await res.json()).toMatchObject({ orderId: order.id, statusUrl, price: { amount: '5' } });
    expect(res.headers.get('Content-Location')).toBe(statusUrl);
    // What the facilitator said stays there for the x402 client.
    expect(res.headers.get('PAYMENT-RESPONSE')).not.toBeNull();
  });

  it('tells the payer where the order is when the settlement times out, an outcome nobody knows yet', async () => {
    const headers = await pay();
    facilitator.settlement = 'timeout';
    const res = await POST(post({ url: U }, headers));
    expect(res.status).toBe(502);
    expect(start).not.toHaveBeenCalled();
    const order = (await orderOf(headers))!;
    expect(order.status).toBe('awaiting_settlement');
    const statusUrl = `${BASE}/v1/videos/${order.id}`;
    expect(await res.json()).toMatchObject({ orderId: order.id, statusUrl });
    expect(res.headers.get('Content-Location')).toBe(statusUrl);
  });

  it('answers the plain 402 to a payment the facilitator refuses, such as one sent again after it settled', async () => {
    const headers = await pay();
    facilitator.verification = 'invalid';
    const res = await POST(post({ url: U }, headers));
    expect(res.status).toBe(402);
    expect(res.headers.get('Content-Location')).toBeNull();
    const body = await res.json();
    expect(body).toMatchObject({ termsUrl: `${BASE}/terms` });
    expect(body).not.toHaveProperty('orderId');
    expect(body).not.toHaveProperty('statusUrl');
    expect(await orderOf(headers)).toBeNull();
  });

  it.each([
    ['for less than the price', { amount: '1' }],
    ['to another address', { payTo: `0x${'9'.repeat(40)}` }],
  ])('refuses a payment signed %s, and never settles it', async (_label, signed) => {
    const headers = await pay({ url: U }, { signed });
    const res = await POST(post({ url: U }, headers));
    expect(res.status).toBe(400);
    expect(res.headers.get('Content-Location')).toBeNull();
    const body = await res.json();
    expect(body).toMatchObject({ error: 'invalid_payment' });
    expect(body).not.toHaveProperty('orderId');
    expect(facilitator.calls.settle).toBe(0);
    expect(start).not.toHaveBeenCalled();
    expect(await orderOf(headers)).toBeNull();
  });

  describe('the time window of the authorization', () => {
    const now = () => Math.floor(Date.now() / 1000);
    /** The offer gives a signed payment 300 s to be settled, and the client's clock may be a minute ahead. */
    const LONGEST = 300 + 60;

    /** Posts a payment whose authorization says these times, and expects it refused before anything was charged. */
    const refused = async (times: { validAfter?: string; validBefore?: string }) => {
      const headers = await pay({ url: U }, { times });
      const res = await POST(post({ url: U }, headers));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_payment', reason: expect.any(String) });
      expect(res.headers.get('Content-Location')).toBeNull();
      expect(facilitator.calls.settle).toBe(0);
      expect(start).not.toHaveBeenCalled();
      expect(await orderOf(headers)).toBeNull();
    };

    it('refuses an authorization valid for longer than the offer asks, and never settles it', async () => {
      await refused({ validBefore: String(now() + LONGEST + 5) });
      await refused({ validBefore: String(now() + 365 * 24 * 3600) });
    });

    it('refuses an authorization that is not valid yet, and never settles it', async () => {
      await refused({ validAfter: String(now() + 30) });
    });

    it('takes an authorization valid for up to a minute more than the offer asks, from a client whose clock is ahead', async () => {
      const headers = await pay({ url: U }, { times: { validAfter: String(now()), validBefore: String(now() + LONGEST - 5) } });
      expect((await POST(post({ url: U }, headers))).status).toBe(202);
    });
  });

  it('logs a settled payment that has no order, without starting anything', async () => {
    // A store that cannot find the order the request has just made: the settlement then belongs to no order.
    const forgetful = new Proxy(store, {
      get(target, name) {
        if (name === 'findOrderByPayment') return async () => null;
        const value: unknown = Reflect.get(target, name);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setVideosDeps({ ...deps, store: forgetful });
    try {
      const headers = await pay();
      expect((await POST(post({ url: U }, headers))).status).toBe(202);
      const { from, nonce } = (decodePaymentSignatureHeader(headers['PAYMENT-SIGNATURE']).payload as { authorization: { from: string; nonce: string } })
        .authorization;
      expect(logged).toHaveBeenCalledWith('[settled_without_order]', TOKENS.USDT.address, from, nonce);
      expect(start).not.toHaveBeenCalled();
    } finally {
      setVideosDeps(deps);
      logged.mockRestore();
    }
  });

  it('never looks at the payment of a site that fails the pre-check, so it is never charged', async () => {
    const headers = await pay();
    const res = await POST(post({ url: 'https://login.example/' }, headers));
    expect(res.status).toBe(422);
    expect(facilitator.calls.verify).toBe(0);
    expect(facilitator.calls.settle).toBe(0);
    expect(await orderOf(headers)).toBeNull();
  });

  it('never looks at the payment when an extra page fails the pre-check, so it is never charged', async () => {
    const headers = await pay();
    const res = await POST(post({ url: U, extraUrls: ['https://login.example/'] }, headers));
    expect(res.status).toBe(422);
    expect(facilitator.calls.verify).toBe(0);
    expect(facilitator.calls.settle).toBe(0);
    expect(await orderOf(headers)).toBeNull();
  });

  it('never looks at the payment of an invalid body', async () => {
    const res = await POST(post({ url: U, audio: 'voice' }, await pay()));
    expect(res.status).toBe(400);
    expect(facilitator.calls.verify).toBe(0);
  });
});

describe('POST /v1/videos at the first-video price', () => {
  const FULL = ['5000000', '5000000'];
  const PROMO = ['10000', '10000'];
  const GONE = 'The first-video price is no longer available for this wallet. Ask for a new quote.';

  // Each test on a store of its own, so both of its slots start free.
  let fresh: FileStore;
  beforeEach(async () => {
    fresh = new FileStore(await mkdtemp(join(dir, 'promo-')));
    setVideosDeps({ ...deps, store: fresh });
  });
  afterEach(() => {
    setVideosDeps(deps);
  });

  /** A wallet the test signs with: a key made now, and its address. */
  const newWallet = () => {
    const key = generatePrivateKey();
    return { key, address: privateKeyToAccount(key).address };
  };
  /** The test's store, with these methods in place of its own, as the route's store from now on. */
  const useStoreWith = (overrides: Partial<OrderStore>) => {
    const store = new Proxy(fresh, {
      get(target, name) {
        if (typeof name === 'string' && name in overrides) return overrides[name as keyof OrderStore];
        const value: unknown = Reflect.get(target, name);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    setVideosDeps({ ...deps, store });
  };
  /** The free quote, naming the wallet in x-payer when one is given. */
  const quote = (address?: string) => POST(post({ url: U }, address === undefined ? {} : { 'x-payer': address }));
  /** What a 402 asks for in each token, in atomic units. */
  const asked = (res: Response) => decodePaymentRequiredHeader(res.headers.get('PAYMENT-REQUIRED')!).accepts.map((offer) => offer.amount);
  let nonce = 0;
  /** Another wallet's payment at the first-video price, as the store keeps it. */
  const someoneElse = (): NewOrder => ({
    request: { url: U, audio: 'music' },
    network: 'eip155:42220',
    asset: TOKENS.USDT.address,
    payer: privateKeyToAccount(generatePrivateKey()).address,
    amount: PROMO_PRICE_ATOMIC,
    nonce: `0x${(++nonce).toString(16).padStart(64, '0')}`,
    validAfter: 0n,
    validBefore: 1_790_000_000n,
  });

  it('makes a promo order when the eligible wallet pays 0.01 with x-payer', async () => {
    const me = newWallet();
    const res402 = await quote(me.address);
    expect(res402.status).toBe(402);
    expect(asked(res402)).toEqual(PROMO);
    expect(await res402.clone().json()).toMatchObject({ price: { amount: '0.01', assets: ['USDT', 'USDC'] } });

    // The header may write the address in any case.
    const headers = await payFor(res402, { key: me.key });
    const res = await POST(post({ url: U }, { 'x-payer': me.address.toLowerCase(), ...headers }));
    expect(res.status).toBe(202);
    const { orderId, statusUrl } = (await res.json()) as { orderId: string; statusUrl: string };
    expect(res.headers.get('Content-Location')).toBe(statusUrl);
    expect(await fresh.getOrder(orderId)).toMatchObject({ status: 'paid', payer: me.address, amount: 10_000n, promoSlot: 1, runId: 'wrun_test' });
    expect(facilitator.calls.settle).toBe(1);
    expect(start).toHaveBeenCalledTimes(1);

    // Its first video is on its way: the next quote is at the full price.
    expect(asked(await quote(me.address))).toEqual(FULL);
  });

  it('refuses a promo payment signed by another wallet than x-payer', async () => {
    const asker = newWallet();
    const signer = newWallet();
    const headers = await payFor(await quote(asker.address), { key: signer.key });
    const res = await POST(post({ url: U }, { 'x-payer': asker.address, ...headers }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_payment', reason: expect.stringContaining('wallet that asked for it') });
    expect(res.headers.get('Content-Location')).toBeNull();
    expect(facilitator.calls.settle).toBe(0);
    expect(start).not.toHaveBeenCalled();
    expect(await orderOf(headers, fresh)).toBeNull();
    expect(await fresh.promoSlotsUsed()).toBe(0);
  });

  it('refuses a promo payment without x-payer', async () => {
    const me = newWallet();
    const headers = await payFor(await quote(me.address), { key: me.key });
    const res = await POST(post({ url: U }, headers));
    // Without the header the offer is the full price, which the payment does not match: x402 answers it with a fresh
    // 402 at the full price before the facilitator is asked anything, and nothing is charged.
    expect(res.status).toBe(402);
    expect(asked(res)).toEqual(FULL);
    expect(await res.json()).toMatchObject({ price: { amount: '5' } });
    expect(facilitator.calls.verify).toBe(0);
    expect(facilitator.calls.settle).toBe(0);
    expect(await orderOf(headers, fresh)).toBeNull();
    expect(await fresh.promoSlotsUsed()).toBe(0);
  });

  it('answers 409 promo_unavailable when the last slot went to someone else', async () => {
    expect(await fresh.createPromoOrder(someoneElse(), 2)).toMatchObject({ created: true });
    const me = newWallet();
    const headers = await payFor(await quote(me.address), { key: me.key });
    // Between the price this payment was offered and its order, another wallet takes the last slot.
    const takeSlot = fresh.createPromoOrder.bind(fresh);
    useStoreWith({
      createPromoOrder: async (order, slots) => {
        await takeSlot(someoneElse(), slots);
        return takeSlot(order, slots);
      },
    });

    const res = await POST(post({ url: U }, { 'x-payer': me.address, ...headers }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'promo_unavailable', reason: GONE });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(facilitator.calls.settle).toBe(0);
    expect(start).not.toHaveBeenCalled();
    expect(await orderOf(headers, fresh)).toBeNull();
    expect(await fresh.promoSlotsUsed()).toBe(2);
  });

  it('answers a fresh 402 at the full price when the promo check fails at payment time, and charges nothing', async () => {
    const me = newWallet();
    const headers = await payFor(await quote(me.address), { key: me.key });
    useStoreWith({
      hasVideo: async () => {
        throw new Error('The database is not answering.');
      },
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await POST(post({ url: U }, { 'x-payer': me.address, ...headers }));
      expect(res.status).toBe(402);
      expect(asked(res)).toEqual(FULL);
      expect(await res.json()).toMatchObject({ price: { amount: '5' } });
      expect(logged).toHaveBeenCalledWith('[promo_check_failed]', 'The database is not answering.');
    } finally {
      logged.mockRestore();
    }
    expect(facilitator.calls.verify).toBe(0);
    expect(facilitator.calls.settle).toBe(0);
    expect(await orderOf(headers, fresh)).toBeNull();
  });

  it("keeps today's answers for a client that sends no x-payer", async () => {
    // The promo is on and both of its slots are free.
    const res402 = await quote();
    expect(res402.status).toBe(402);
    const required = decodePaymentRequiredHeader(res402.headers.get('PAYMENT-REQUIRED')!);
    expect(required.accepts.map((offer) => [offer.asset, offer.amount])).toEqual([
      [TOKENS.USDT.address, '5000000'],
      [TOKENS.USDC.address, '5000000'],
    ]);
    expect(required.resource.description).toBe(
      'Ad video package from a website URL. Costs 5 USDT or USDC on Celo. x402 clients with a default $1 per-payment cap must raise it.',
    );
    expect(await res402.clone().json()).toEqual({
      precheck: { thinSite: true, hint: THIN_HINT },
      termsUrl: `${BASE}/terms`,
      price: { amount: '5', assets: ['USDT', 'USDC'] },
    });

    const res = await POST(post({ url: U }, await payFor(res402)));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { orderId: string; statusUrl: string };
    expect(body).toEqual({ orderId: expect.stringMatching(/^ord_/), statusUrl: `${BASE}/v1/videos/${body.orderId}` });
    expect(await fresh.getOrder(body.orderId)).toMatchObject({ status: 'paid', amount: 5_000_000n, promoSlot: null });
    expect(await fresh.promoSlotsUsed()).toBe(0);
  });
});
