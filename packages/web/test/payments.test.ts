import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { start } from 'workflow/api';
import { FileStore } from '../src/adapters/fake/store';
import { markPaidAndStart } from '../src/payments/orders';
import { formatPrice, routeConfig, TOKENS } from '../src/payments/x402';
import { orderWorkflow } from '../src/workflows/order';

vi.mock('workflow/api', () => ({ start: vi.fn(async () => ({ runId: 'wrun_unit' })) }));

const PAYTO = `0x${'2'.repeat(40)}`;
const settings = { PAYTO_ADDRESS: PAYTO, PRICE_ATOMIC: 5_000_000n, ERC8021_CODE: undefined };

describe('routeConfig', () => {
  it('offers USDT first and USDC second, each at the price in its own atomic units', () => {
    const config = routeConfig(settings);
    expect(config.accepts).toEqual([
      { scheme: 'exact', network: 'eip155:42220', payTo: PAYTO, maxTimeoutSeconds: 300, price: { amount: '5000000', asset: TOKENS.USDT.address, extra: { name: 'Tether USD', version: '1' } } },
      { scheme: 'exact', network: 'eip155:42220', payTo: PAYTO, maxTimeoutSeconds: 300, price: { amount: '5000000', asset: TOKENS.USDC.address, extra: { name: 'USDC', version: '2' } } },
    ]);
    expect(config.mimeType).toBe('application/json');
  });

  it('says the price in the description, and that a $1 client cap must be raised', () => {
    expect(routeConfig({ ...settings, PRICE_ATOMIC: 50_000n }).description).toBe(
      'Ad video package from a website URL. Costs 0.05 USDT or USDC on Celo. x402 clients with a default $1 per-payment cap must raise it.',
    );
  });

  it('declares the ERC-8021 builder code only when there is one', () => {
    expect(routeConfig(settings).extensions).toBeUndefined();
    expect(routeConfig({ ...settings, ERC8021_CODE: 'bc_ad_video' }).extensions).toEqual({
      'builder-code': expect.objectContaining({ info: { a: 'bc_ad_video' } }),
    });
  });

  it('never quotes against the USDT fee-currency adapter, whose name is the same but has 18 decimals', () => {
    const assets = (routeConfig(settings).accepts as { price: { asset: string } }[]).map((option) => option.price.asset.toLowerCase());
    expect(assets).not.toContain('0x0e2a3e05bc9a16f5292a6170456a710cb89c6f72');
    expect(TOKENS.USDT.decimals).toBe(6);
    expect(TOKENS.USDC.decimals).toBe(6);
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
