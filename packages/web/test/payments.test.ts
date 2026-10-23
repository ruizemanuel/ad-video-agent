import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import { x402HTTPResourceServer, type HTTPAdapter } from '@x402/core/server';
import type { PaymentRequirements } from '@x402/core/types';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { start } from 'workflow/api';
import { FileStore } from '../src/adapters/fake/store';
import type { NewOrder } from '../src/ports';
import { markPaidAndStart, startRun } from '../src/payments/orders';
import { createResourceServer, formatPrice, PROMO_PRICE_ATOMIC, promoGate, routeConfig, TOKENS, type PromoGate } from '../src/payments/x402';
import { orderWorkflow } from '../src/workflows/order';
import { FakeFacilitator } from './support/fake-facilitator';

vi.mock('workflow/api', () => ({ start: vi.fn(async () => ({ runId: 'wrun_unit' })) }));

const PAYTO = `0x${'2'.repeat(40)}`;
const settings = { PAYTO_ADDRESS: PAYTO, PRICE_ATOMIC: 5_000_000n, ERC8021_CODE: undefined };
/** A promo that is never on: the price is the full one for every request. */
const noPromo: PromoGate = { eligible: async () => false };

/**
 * What the x402 server asks a request to POST /v1/videos without a payment to pay, read from the PAYMENT-REQUIRED header
 * of its 402: the offers, as x402 clients see them. `headers` are the request's, by lowercase name.
 */
async function offers(gate: PromoGate, headers: Record<string, string> = {}, over: Partial<typeof settings> = {}): Promise<PaymentRequirements[]> {
  const server = new x402HTTPResourceServer(createResourceServer({ X402_API_KEY: undefined }, new FakeFacilitator()), {
    '/v1/videos': routeConfig({ ...settings, ...over }, gate),
  });
  await server.initialize();
  const adapter: HTTPAdapter = {
    getHeader: (name) => headers[name.toLowerCase()],
    getMethod: () => 'POST',
    getPath: () => '/v1/videos',
    getUrl: () => 'https://ad-video-agent.example.com/v1/videos',
    getAcceptHeader: () => 'application/json',
    getUserAgent: () => 'payments-test',
  };
  const result = await server.processHTTPRequest({ adapter, path: '/v1/videos', method: 'POST' });
  if (result.type !== 'payment-error') throw new Error(`Expected a 402; got ${result.type}.`);
  expect(result.response.status).toBe(402);
  const header = result.response.headers['PAYMENT-REQUIRED'];
  if (header === undefined) throw new Error('The 402 has no PAYMENT-REQUIRED header.');
  return decodePaymentRequiredHeader(header).accepts;
}

const amounts = (accepts: PaymentRequirements[]) => accepts.map((offer) => [offer.asset, offer.amount]);
const atFullPrice = [
  [TOKENS.USDT.address, '5000000'],
  [TOKENS.USDC.address, '5000000'],
];

describe('routeConfig', () => {
  it('offers USDT first and USDC second, each at the price in its own atomic units', async () => {
    const accepts = await offers(noPromo);
    expect(accepts).toEqual([
      { scheme: 'exact', network: 'eip155:42220', payTo: PAYTO, maxTimeoutSeconds: 300, asset: TOKENS.USDT.address, amount: '5000000', extra: { name: 'Tether USD', version: '1' } },
      { scheme: 'exact', network: 'eip155:42220', payTo: PAYTO, maxTimeoutSeconds: 300, asset: TOKENS.USDC.address, amount: '5000000', extra: { name: 'USDC', version: '2' } },
    ]);
    expect(routeConfig(settings, noPromo).mimeType).toBe('application/json');
  });

  it('says the price in the description, and that a $1 client cap must be raised', () => {
    expect(routeConfig({ ...settings, PRICE_ATOMIC: 50_000n }, noPromo).description).toBe(
      'Ad video package from a website URL. Costs 0.05 USDT or USDC on Celo. x402 clients with a default $1 per-payment cap must raise it.',
    );
  });

  it('declares the ERC-8021 builder code only when there is one', () => {
    expect(routeConfig(settings, noPromo).extensions).toBeUndefined();
    expect(routeConfig({ ...settings, ERC8021_CODE: 'bc_ad_video' }, noPromo).extensions).toEqual({
      'builder-code': expect.objectContaining({ info: { a: 'bc_ad_video' } }),
    });
  });

  it('never quotes against the USDT fee-currency adapter, whose name is the same but has 18 decimals', async () => {
    const assets = (await offers(noPromo)).map((offer) => offer.asset.toLowerCase());
    expect(assets).not.toContain('0x0e2a3e05bc9a16f5292a6170456a710cb89c6f72');
    expect(TOKENS.USDT.decimals).toBe(6);
    expect(TOKENS.USDC.decimals).toBe(6);
  });
});

describe('the first-video price', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  let store: FileStore;
  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'promo-'));
    dirs.push(dir);
    store = new FileStore(dir);
  });

  const WALLET = '0xAbCdEf0123456789aBcDeF0123456789ABCDEF01';
  const TEAM = `0x${'7e'.repeat(20)}`;
  const promo = { PROMO_SLOTS: 3, TEAM_WALLETS: [TEAM] };
  let nonce = 0;
  const payment = (payer: string): NewOrder => ({
    request: { url: 'https://example.com', audio: 'music' },
    network: 'eip155:42220',
    asset: TOKENS.USDT.address,
    payer,
    amount: PROMO_PRICE_ATOMIC,
    nonce: `0x${(++nonce).toString(16).padStart(64, '0')}`,
    validAfter: 0n,
    validBefore: 1_790_000_000n,
  });

  it('is 0.01, in atomic units', () => {
    expect(PROMO_PRICE_ATOMIC).toBe(10_000n);
    expect(formatPrice(PROMO_PRICE_ATOMIC)).toBe('0.01');
  });

  it('offers the promo price for an eligible x-payer', async () => {
    const accepts = await offers(promoGate(promo, store), { 'x-payer': WALLET });
    expect(amounts(accepts)).toEqual([
      [TOKENS.USDT.address, '10000'],
      [TOKENS.USDC.address, '10000'],
    ]);
    // Only the amount changes: the same tokens, to the same wallet, on the same terms.
    expect(accepts.map(({ amount: _amount, ...rest }) => rest)).toEqual((await offers(noPromo)).map(({ amount: _amount, ...rest }) => rest));
    // In any case of its hex.
    expect(amounts(await offers(promoGate(promo, store), { 'x-payer': WALLET.toLowerCase() }))[0]).toEqual([TOKENS.USDT.address, '10000']);
  });

  it('offers the full price without the header, to a team wallet, or with promo off', async () => {
    const gate = promoGate(promo, store);
    expect(amounts(await offers(gate))).toEqual(atFullPrice);
    expect(amounts(await offers(gate, { 'x-payer': TEAM }))).toEqual(atFullPrice);
    expect(amounts(await offers(gate, { 'x-payer': `0x${TEAM.slice(2).toUpperCase()}` }))).toEqual(atFullPrice);
    expect(amounts(await offers(promoGate({ ...promo, PROMO_SLOTS: 0 }, store), { 'x-payer': WALLET }))).toEqual(atFullPrice);
    // The promo price is a fixed amount: it is offered whatever the full price is.
    expect(amounts(await offers(gate, { 'x-payer': WALLET }, { PRICE_ATOMIC: 2_000_000n }))[1]).toEqual([TOKENS.USDC.address, '10000']);
  });

  it('offers the full price to a wallet that has a video, and once every slot is held', async () => {
    const gate = promoGate(promo, store);
    const { order } = await store.createOrder({ ...payment(WALLET.toLowerCase()), amount: 5_000_000n });
    expect(amounts(await offers(gate, { 'x-payer': WALLET }))).toEqual(atFullPrice);
    // Refunded, the order never had its video: the wallet's first video is still to come.
    for (const status of ['paid', 'refunding', 'refunded'] as const) expect(await store.transition(order.id, status)).toBe(true);
    expect(amounts(await offers(gate, { 'x-payer': WALLET }))[0]).toEqual([TOKENS.USDT.address, '10000']);

    for (let k = 1; k <= 3; k++) expect(await store.createPromoOrder(payment(`0x${String(k).repeat(40)}`), 3)).toMatchObject({ created: true });
    expect(amounts(await offers(gate, { 'x-payer': WALLET }))).toEqual(atFullPrice);
  });

  it('ignores an x-payer that is not an address, and never fails the quote for it', async () => {
    const asked = vi.fn(async () => true);
    for (const hint of ['me', '0x1234', `${WALLET}0`, WALLET.slice(2), ` ${WALLET}`, `${WALLET},${TEAM}`]) {
      expect(amounts(await offers({ eligible: asked }, { 'x-payer': hint })), hint).toEqual(atFullPrice);
    }
    expect(asked).not.toHaveBeenCalled();
  });

  it('asks once per request, so both tokens are offered at the same price', async () => {
    const asked = vi.fn(async () => true);
    expect(amounts(await offers({ eligible: asked }, { 'x-payer': WALLET }))).toEqual([
      [TOKENS.USDT.address, '10000'],
      [TOKENS.USDC.address, '10000'],
    ]);
    expect(asked).toHaveBeenCalledTimes(1);
    expect(asked).toHaveBeenCalledWith(WALLET.toLowerCase());
  });

  it('falls back to the full price when the promo check fails, and logs only the error message', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const broken: PromoGate = {
        eligible: async () => {
          throw new Error('The database is not answering.');
        },
      };
      expect(amounts(await offers(broken, { 'x-payer': WALLET }))).toEqual(atFullPrice);
      expect(logged).toHaveBeenCalledWith('[promo_check_failed]', 'The database is not answering.');
    } finally {
      logged.mockRestore();
    }
  });
});

describe('formatPrice', () => {
  it('writes atomic units of a 6-decimal token as a plain amount', () => {
    expect(formatPrice(5_000_000n)).toBe('5');
    expect(formatPrice(50_000n)).toBe('0.05');
    expect(formatPrice(1_234_567n)).toBe('1.234567');
    expect(formatPrice(12_500_000n)).toBe('12.5');
  });
});

describe('markPaidAndStart', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  let store: FileStore;
  beforeEach(async () => {
    vi.clearAllMocks();
    const dir = await mkdtemp(join(tmpdir(), 'payments-'));
    dirs.push(dir);
    store = new FileStore(dir);
  });

  const payer = '0x1234567890AbcdEF1234567890aBcdef12345678';
  const nonce = `0x${'AB'.repeat(32)}`;
  const txHash = `0x${'ef'.repeat(32)}`;
  const seed = () =>
    store.createOrder({
      request: { url: 'https://example.com', audio: 'music' },
      network: 'eip155:42220',
      asset: TOKENS.USDT.address,
      payer,
      amount: 5_000_000n,
      nonce,
      validAfter: 0n,
      validBefore: 1_790_000_000n,
    });

  it('marks the order paid with its settlement, and starts its run once', async () => {
    const { order } = await seed();
    expect(await markPaidAndStart({ asset: TOKENS.USDT.address, payer, nonce, txHash }, { store })).toBe('started');
    expect(start).toHaveBeenCalledWith(orderWorkflow, [order.id]);
    expect(await store.getOrder(order.id)).toMatchObject({ status: 'paid', settleTx: txHash, runId: 'wrun_unit', steps: { payment: 'done' } });
    expect(await markPaidAndStart({ asset: TOKENS.USDT.address, payer, nonce, txHash }, { store })).toBe('already');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('finds the order whatever the case of the hex', async () => {
    const { order } = await seed();
    const found = { asset: TOKENS.USDT.address.toLowerCase(), payer: payer.toLowerCase(), nonce: nonce.toLowerCase(), txHash };
    expect(await markPaidAndStart(found, { store })).toBe('started');
    expect((await store.getOrder(order.id))!.status).toBe('paid');
  });

  it('starts nothing for a payment that made no order', async () => {
    expect(await markPaidAndStart({ asset: TOKENS.USDT.address, payer, nonce, txHash }, { store })).toBe('unknown');
    expect(start).not.toHaveBeenCalled();
  });

  it('starts nothing for an order that can no longer be paid', async () => {
    const { order } = await seed();
    await store.transition(order.id, 'unpaid');
    expect(await markPaidAndStart({ asset: TOKENS.USDT.address, payer, nonce, txHash }, { store })).toBe('already');
    expect(start).not.toHaveBeenCalled();
    expect((await store.getOrder(order.id))!.status).toBe('unpaid');
  });
});

describe('startRun', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  let store: FileStore;
  beforeEach(async () => {
    vi.clearAllMocks();
    const dir = await mkdtemp(join(tmpdir(), 'start-run-'));
    dirs.push(dir);
    store = new FileStore(dir);
  });

  const seed = async () => {
    const { order } = await store.createOrder({
      request: { url: 'https://example.com', audio: 'music' },
      network: 'eip155:42220',
      asset: TOKENS.USDT.address,
      payer: '0x1234567890AbcdEF1234567890aBcdef12345678',
      amount: 5_000_000n,
      nonce: `0x${'AB'.repeat(32)}`,
      validAfter: 0n,
      validBefore: 1_790_000_000n,
    });
    await store.transition(order.id, 'paid');
    return order;
  };

  it("keeps the id of the run it started on an order that has none", async () => {
    const order = await seed();
    await startRun(order.id, store);
    expect(start).toHaveBeenCalledWith(orderWorkflow, [order.id]);
    expect((await store.getOrder(order.id))?.runId).toBe('wrun_unit');
  });

  it("never writes over the id of a run that got there first (an overlapping reconciliation's duplicate)", async () => {
    const order = await seed();
    // While this call is starting its run, another one starts its own and keeps its id.
    vi.mocked(start).mockImplementationOnce(async () => {
      await store.setRunIdIfNone(order.id, 'wrun_real');
      return { runId: 'wrun_duplicate' } as Awaited<ReturnType<typeof start>>;
    });

    await startRun(order.id, store);

    expect(await store.getOrder(order.id)).toMatchObject({ status: 'paid', runId: 'wrun_real' });
  });
});
