import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePaymentRequiredHeader, decodePaymentSignatureHeader } from '@x402/core/http';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { start } from 'workflow/api';
import { getAdapters } from '../src/adapters';
import { FakeLlm } from '../src/adapters/fake/llm';
import { setVideosDeps } from '../src/app/v1/videos/deps';
import { POST } from '../src/app/v1/videos/route';
import { ModelOutputInvalid } from '../src/ports';
import { TOKENS } from '../src/payments/x402';
import type { FetchedPage } from '../src/precheck/fetch-page';
import { orderWorkflow } from '../src/workflows/order';
import { FAKE_SETTLE_TX, FakeFacilitator } from './support/fake-facilitator';
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

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${BASE}/v1/videos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const json = async (res: Response | Promise<Response>) => (await res).json() as Promise<Record<string, unknown>>;
/** Asks for the price of `body`, then signs what the 402 asks for, from a new wallet. */
const pay = async (body: unknown = { url: U }, options: PayOptions = {}): Promise<PaymentHeaders> => payFor(await POST(post(body)), options);
/** The order a payment made, found the way the reconciliation finds it. */
const orderOf = async (headers: PaymentHeaders) => {
  const payment = decodePaymentSignatureHeader(headers['PAYMENT-SIGNATURE']);
  const { from, nonce } = (payment.payload as { authorization: { from: string; nonce: string } }).authorization;
  return store.findOrderByPayment(payment.accepted.asset, from, nonce);
};

beforeEach(() => {
  vi.clearAllMocks();
  facilitator.verification = 'valid';
  facilitator.settlement = 'success';
  facilitator.calls.verify = 0;
  facilitator.calls.settle = 0;
});

describe('POST /v1/videos without a payment', () => {
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
      expect(await res.json()).toEqual({ error: 'precheck_unavailable', reason: expect.any(String) });
      expect(await store.orderCost('precheck')).toBeCloseTo(before + 0.0007, 6);
    } finally {
      llm.classifySite = async () => ({ admissible: true, reason: 'The site is a normal business site.', usd: 0.0004 });
    }
    const calls = llm.calls.classifySite;
    expect((await POST(post({ url: site }))).status).toBe(402);
    expect(llm.calls.classifySite).toBe(calls + 1);
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

  it('never looks at the payment of an invalid body', async () => {
    const res = await POST(post({ url: U, audio: 'voice' }, await pay()));
    expect(res.status).toBe(400);
    expect(facilitator.calls.verify).toBe(0);
  });
});
