// The buy adapter's chain reads and its VM poll, against a chain and a gateway that never leave the test. Paying is in
// vm-payment.test.ts, through payForVm.
import { inspect } from 'node:util';
import { generatePrivateKey } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { CeloBuy } from '../src/adapters/real/buy';
import { BUY_PAY_TO, json, USDC, USDT } from './support/fake-buy-gateway';
import { authorizationCanceledLog, authorizationUsedLog, FakeChain, transferLog } from './support/fake-chain';

const RPC_URL = 'https://celo-mainnet.example/v1/secret-rpc-key';
const PAYER: Address = '0x1234567890AbcdEF1234567890aBcdef12345678';
const OTHER: Address = '0x9999999999999999999999999999999999999999';
const NONCE: Hex = `0x${'5a'.repeat(32)}`;
const VALUE = 5_000_000n;

let chain: FakeChain;
let buy: CeloBuy;

beforeEach(() => {
  chain = new FakeChain();
  buy = new CeloBuy({ spendKey: generatePrivateKey(), rpcUrl: RPC_URL, fetch: async () => json(404, {}), transport: chain.transport });
});

/** What the reconciliation asks: did this authorization pay `to` at least `value` of USDT? */
const ask = (over: { asset?: string; to?: string; value?: bigint } = {}) =>
  buy.authorizationSettled({
    asset: over.asset ?? USDT,
    authorization: { from: PAYER, nonce: NONCE, validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 300) },
    to: over.to ?? BUY_PAY_TO,
    value: over.value ?? VALUE,
  });

describe('CeloBuy.authorizationSettled', () => {
  it('answers settled when the transaction that spent the nonce paid the value to the address', async () => {
    chain.settle({ token: USDT, from: PAYER, to: BUY_PAY_TO, value: VALUE, nonce: NONCE });
    expect(await ask()).toBe('settled');
  });

  it('compares the address whatever the case of its hex', async () => {
    chain.settle({ token: USDT, from: PAYER, to: BUY_PAY_TO, value: VALUE, nonce: NONCE });
    expect(await ask({ to: BUY_PAY_TO.toLowerCase() })).toBe('settled');
    expect(await ask({ to: BUY_PAY_TO.toUpperCase().replace('0X', '0x') })).toBe('settled');
  });

  it('answers settled for more than the value, and unsettled for less', async () => {
    chain.settle({ token: USDT, from: PAYER, to: BUY_PAY_TO, value: VALUE, nonce: NONCE });
    expect(await ask({ value: VALUE - 1n })).toBe('settled');
    expect(await ask({ value: VALUE + 1n })).toBe('unsettled');
  });

  it('answers unsettled when the nonce paid someone else (a payer sending it to themselves)', async () => {
    chain.settle({ token: USDT, from: PAYER, to: PAYER, value: 1n, nonce: NONCE });
    expect(await ask()).toBe('unsettled');
  });

  it('answers unsettled when the transfer next to the nonce is not from the payer', async () => {
    chain.mine([authorizationUsedLog(USDT, PAYER, NONCE), transferLog(USDT, OTHER, BUY_PAY_TO, VALUE)]);
    expect(await ask()).toBe('unsettled');
  });

  it('answers unsettled when the transfer next to the nonce is of another token', async () => {
    chain.mine([authorizationUsedLog(USDT, PAYER, NONCE), transferLog(USDC, PAYER, BUY_PAY_TO, VALUE)]);
    expect(await ask()).toBe('unsettled');
  });

  it('answers unsettled when the nonce was spent on another token than the one asked about', async () => {
    chain.settle({ token: USDT, from: PAYER, to: BUY_PAY_TO, value: VALUE, nonce: NONCE });
    expect(await ask({ asset: USDC })).toBe('unsettled');
  });

  it('counts only the transfer the authorization made, not another one in the same transaction', async () => {
    // One transaction pays the service on its own and spends the nonce on a transfer to the payer: this authorization
    // did not pay, and the payment it would have been can never happen.
    chain.mine([
      transferLog(USDT, PAYER, BUY_PAY_TO, VALUE),
      authorizationUsedLog(USDT, PAYER, NONCE),
      transferLog(USDT, PAYER, PAYER, VALUE),
    ]);
    expect(await ask()).toBe('unsettled');
  });

  it('answers unsettled for a cancelled nonce: it is spent and no money moved', async () => {
    chain.cancel({ token: USDT, from: PAYER, nonce: NONCE });
    expect(await ask()).toBe('unsettled');
  });

  it('answers unsettled while the nonce is not spent', async () => {
    expect(await ask()).toBe('unsettled');
  });

  it('answers unknown when the node does not answer, and lets nothing of its error out', async () => {
    chain.settle({ token: USDT, from: PAYER, to: BUY_PAY_TO, value: VALUE, nonce: NONCE });
    chain.down = true;
    expect(await ask()).toBe('unknown');
  });

  it('answers unknown when the receipt of the transaction cannot be read', async () => {
    chain.settle({ token: USDT, from: PAYER, to: BUY_PAY_TO, value: VALUE, nonce: NONCE });
    chain.receiptsDown = true;
    expect(await ask()).toBe('unknown');
  });

  it('answers unknown when the nonce is spent but nothing that spent it is in the blocks it looks at', async () => {
    // Spent a day before: neither a transfer nor a cancellation is in sight.
    chain.settle({ token: USDT, from: PAYER, to: BUY_PAY_TO, value: VALUE, nonce: NONCE }, chain.head.number - 86_400n);
    expect(await ask()).toBe('unknown');
  });

  it('finds a settlement of an authorization that is valid for a long time yet', async () => {
    // A client may sign far into the future; the transfer happened half an hour ago (blocks are 1 s apart).
    chain.settle({ token: USDT, from: PAYER, to: BUY_PAY_TO, value: VALUE, nonce: NONCE }, chain.head.number - 1_800n);
    const settled = await buy.authorizationSettled({
      asset: USDT,
      authorization: { from: PAYER, nonce: NONCE, validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 365 * 86_400) },
      to: BUY_PAY_TO,
      value: VALUE,
    });
    expect(settled).toBe('settled');
  });

  it('reads the chain through the transport it is given', async () => {
    await ask();
    expect(chain.methods).toContain('eth_call');
  });
});

describe('CeloBuy.pollVm', () => {
  const polled = (answer: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const client = new CeloBuy({
      spendKey: generatePrivateKey(),
      rpcUrl: RPC_URL,
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({ url, init });
        return answer(url, init);
      },
      transport: chain.transport,
    });
    return { client, requests };
  };

  it('asks buy, for free and with a timeout, how the VM is', async () => {
    const { client, requests } = polled(() => json(200, { vmStatus: 'RUNNING', scriptStatus: 'running', expiresAt: '2026-10-18T15:57:42.345Z', result: null }));
    expect(await client.pollVm('https://usebuy.ai/google/vm/abc')).toEqual({ gone: false, vmStatus: 'RUNNING', scriptStatus: 'running', expiresAt: '2026-10-18T15:57:42.345Z' });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://usebuy.ai/google/vm/abc');
    expect(requests[0]!.init?.method ?? 'GET').toBe('GET');
    expect(new Headers(requests[0]!.init?.headers).get('X-PAYMENT')).toBeNull();
    expect(requests[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('says the VM is gone when buy no longer knows it', async () => {
    const { client } = polled(() => json(404, { error: 'not found' }));
    expect(await client.pollVm('https://usebuy.ai/google/vm/abc')).toEqual({ gone: true });
  });

  it('fails on another answer without naming the URL, which is the VM\'s to follow', async () => {
    const { client } = polled(() => json(500, {}));
    const error = await client.pollVm('https://usebuy.ai/google/vm/secret-lease').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('500');
    expect((error as Error).message).not.toContain('secret-lease');
  });

  it('refuses a URL that is not buy\'s, without asking it', async () => {
    const { client, requests } = polled(() => json(200, {}));
    await expect(client.pollVm('https://elsewhere.example/google/vm/abc')).rejects.toThrow();
    expect(requests).toEqual([]);
  });
});

describe('CeloBuy', () => {
  it('keeps the spend key and the RPC URL out of anything that prints it', () => {
    const key = generatePrivateKey();
    const adapter = new CeloBuy({ spendKey: key, rpcUrl: RPC_URL });
    const shown = [inspect(adapter, { depth: Infinity, showHidden: true }), JSON.stringify(adapter), String(adapter)].join('\n');
    expect(shown).not.toContain(key.slice(2));
    expect(shown).not.toContain('secret-rpc-key');
  });
});
