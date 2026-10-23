import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { resetAdaptersForTests } from '../src/adapters';
import { FileStore } from '../src/adapters/fake/store';
import type { NewOrder } from '../src/ports';
import { TOKENS } from '../src/payments/x402';

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  resetAdaptersForTests();
});

/**
 * The route with the settings the service would read from its environment, on the fake adapters over a folder of its
 * own: env() and the adapters keep what they first read, so each test starts afresh. `store` reads that same folder.
 */
async function route(settings: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'offer-route-'));
  dirs.push(dir);
  const stubs = {
    AD_AGENT_ADAPTERS: 'fake',
    FAKE_DIR: dir,
    PAYTO_ADDRESS: `0x${'1'.repeat(40)}`,
    LINK_SIGNING_SECRET: 's'.repeat(40),
    CRON_SECRET: 'c'.repeat(40),
    ...settings,
  };
  for (const [name, value] of Object.entries(stubs)) vi.stubEnv(name, value);
  const { GET } = await import('../src/app/v1/offer/route');
  return { offer: () => GET(), store: new FileStore(dir) };
}

let nonce = 0;
/** A payment at the first-video price from `payer`, as the store keeps it. */
const promoPayment = (payer: string): NewOrder => ({
  request: { url: 'https://example.com', audio: 'music' },
  network: 'eip155:42220',
  asset: TOKENS.USDT.address,
  payer,
  amount: 10_000n,
  nonce: `0x${(++nonce).toString(16).padStart(64, '0')}`,
  validAfter: 0n,
  validBefore: 1_790_000_000n,
});

describe('GET /v1/offer', () => {
  it('says the price and how many promo slots are left', async () => {
    const { offer, store } = await route({ PROMO_SLOTS: '3', PRICE_ATOMIC: '2000000' });
    const res = await offer();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ price: '2', assets: ['USDT', 'USDC'], promo: { price: '0.01', left: 3 } });

    const made = await store.createPromoOrder(promoPayment(`0x${'a'.repeat(40)}`), 3);
    if (!('order' in made)) throw new Error(`The promo order was refused: ${made.refused}.`);
    expect(await store.transition(made.order.id, 'paid')).toBe(true);
    expect(await (await offer()).json()).toEqual({ price: '2', assets: ['USDT', 'USDC'], promo: { price: '0.01', left: 2 } });
  });

  it('says none are left, and never fewer than none, once more slots are held than PROMO_SLOTS', async () => {
    // Slots held while PROMO_SLOTS was higher.
    const { offer, store } = await route({ PROMO_SLOTS: '1' });
    expect(await store.createPromoOrder(promoPayment(`0x${'a'.repeat(40)}`), 3)).toMatchObject({ created: true });
    expect(await store.createPromoOrder(promoPayment(`0x${'b'.repeat(40)}`), 3)).toMatchObject({ created: true });
    expect(await (await offer()).json()).toEqual({ price: '5', assets: ['USDT', 'USDC'], promo: { price: '0.01', left: 0 } });
  });

  it('says promo null when PROMO_SLOTS is 0', async () => {
    const { offer } = await route();
    const res = await offer();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ price: '5', assets: ['USDT', 'USDC'], promo: null });
  });

  it('answers GET only', async () => {
    await route();
    const handlers = await import('../src/app/v1/offer/route');
    expect(Object.keys(handlers)).toEqual(['GET']);
  });
});
