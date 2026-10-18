// Paying buy for the order's VM: once, capped, with the payment written down before it goes out and an ambiguous
// outcome resolved from the chain instead of paid again. The real buy adapter runs here on @celo/buy-core, against a
// gateway and a chain that never leave the test.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeBuy } from '../src/adapters/fake/buy';
import { FileStore } from '../src/adapters/fake/store';
import { CeloBuy } from '../src/adapters/real/buy';
import { payForVm, resolveVmPayment, VM_MAX_ATOMIC, VM_URL, vmPaymentKey } from '../src/payments/vm-payment';
import type { BuyPort, OrderStore, PaymentRecord } from '../src/ports';
import { BUY_PAY_TO, fakeBuyGateway, json, servedVm, USDT, type FakeBuyGateway } from './support/fake-buy-gateway';
import { FakeChain } from './support/fake-chain';

const SPEND_KEY = generatePrivateKey();
const SPEND = privateKeyToAccount(SPEND_KEY).address;
const SCRIPT = '#!/bin/bash\necho "the order VM"\n';
const DAY = 24 * 60 * 60_000;

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

let store: FileStore;
let chain: FakeChain;
let gw: FakeBuyGateway;
let buy: CeloBuy;
let orderId: string;
let a: { orderId: string; script: string; attempt: number };
let deps: { store: OrderStore; buy: CeloBuy | FakeBuy; dailyCapUsd: number };

const newOrder = async (): Promise<string> => {
  const { order } = await store.createOrder({
    request: { url: 'https://example.com', audio: 'music' },
    network: 'eip155:42220',
    asset: USDT,
    payer: '0x1234567890AbcdEF1234567890aBcdef12345678',
    amount: 5_000_000n,
    nonce: `0x${Math.random().toString(16).slice(2).padStart(64, '0')}`,
    validAfter: 0n,
    validBefore: 1_790_000_000n,
  });
  return order.id;
};

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vm-payment-'));
  dirs.push(dir);
  store = new FileStore(dir);
  chain = new FakeChain();
  gw = fakeBuyGateway(chain);
  buy = new CeloBuy({ spendKey: SPEND_KEY, rpcUrl: 'https://celo-mainnet.example/v1/secret-rpc-key', fetch: gw.fetch, transport: chain.transport });
  orderId = await newOrder();
  a = { orderId, script: SCRIPT, attempt: 1 };
  deps = { store, buy, dailyCapUsd: 2 };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const payment = async (id = orderId): Promise<PaymentRecord | null> => store.getPayment(vmPaymentKey(id));

describe('the VM purchase', () => {
  it('is an e2-medium from buy, paid with a cap of 70000 atomic units', () => {
    expect(VM_URL).toBe('https://usebuy.ai/google/vm');
    expect(VM_MAX_ATOMIC).toBe(70_000n);
    expect(vmPaymentKey('ord_x')).toBe('ord_x:vm');
  });
});

describe('payForVm', () => {
  it('pays once, records the authorization, the cost and the poll URL as soon as it arrives', async () => {
    gw.paid = () => json(200, { poll: 'https://usebuy.ai/google/vm/abc' }, { 'Content-Location': 'https://usebuy.ai/google/vm/abc' });
    expect(await payForVm({ orderId, script: SCRIPT, attempt: 1 }, deps)).toEqual({ status: 'paid', pollUrl: 'https://usebuy.ai/google/vm/abc' });
    expect(await store.getPayment(`${orderId}:vm`)).toMatchObject({ status: 'paid', amount: 67011n, pollUrl: 'https://usebuy.ai/google/vm/abc' });
    expect(await store.orderCost(orderId)).toBeCloseTo(0.067011);
    expect(gw.paidCalls).toBe(1);
  });

  it('keeps everything the chain needs to tell later whether the payment landed', async () => {
    expect(await payForVm(a, deps)).toEqual({ status: 'paid', pollUrl: 'https://usebuy.ai/google/vm/abc' });
    const sent = gw.payments[0]!.payload.authorization;
    expect(await payment()).toEqual({
      key: `${orderId}:vm`,
      orderId,
      kind: 'vm',
      maxAtomic: 70_000n,
      status: 'paid',
      asset: USDT,
      amount: 67_011n,
      payTo: BUY_PAY_TO,
      // The spend wallet signed it.
      authorization: { from: SPEND, nonce: sent.nonce, validAfter: sent.validAfter, validBefore: sent.validBefore },
      // From buy's X-PAYMENT-RESPONSE.
      txHash: `0x${'6d'.repeat(32)}`,
      pollUrl: 'https://usebuy.ai/google/vm/abc',
      outcome: 'confirmed',
      reason: null,
    });
  });

  it('sends buy the script and the machine type, and pays in USDT though USDC is offered first', async () => {
    await payForVm(a, deps);
    // The free quote, then the paid request: the same body both times.
    expect(gw.bodies).toEqual([
      { script: SCRIPT, machineType: 'e2-medium' },
      { script: SCRIPT, machineType: 'e2-medium' },
    ]);
    // The gateway took the signature as USDT's (it answers 402 to anything else) for exactly the quote, to buy.
    expect(gw.payments).toHaveLength(1);
    expect(gw.payments[0]!.payload.authorization).toMatchObject({ from: SPEND, to: BUY_PAY_TO, value: '67011' });
  });

  it('refuses a quote above 70000 atomic without signing', async () => {
    gw.quote = 80000;
    expect((await payForVm(a, deps)).status).toBe('rejected');
    expect(gw.paidCalls).toBe(0);
  });

  it('says why it refused a quote above the cap, and counts nothing', async () => {
    gw.quote = 70_001;
    expect(await payForVm(a, deps)).toEqual({ status: 'rejected', reason: 'amount_exceeds_max' });
    expect(await payment()).toMatchObject({ status: 'rejected', reason: 'amount_exceeds_max', authorization: null });
    expect(await store.orderCost(orderId)).toBe(0);
  });

  it('pays a quote of exactly the cap', async () => {
    gw.quote = 70_000;
    expect((await payForVm(a, deps)).status).toBe('paid');
    expect(await payment()).toMatchObject({ amount: 70_000n });
  });

  it('treats a 5xx after paying as uncertain and keeps the authorization', async () => {
    gw.paid = () => json(500, {});
    expect((await payForVm(a, deps)).status).toBe('uncertain');
    expect(await payment()).toMatchObject({
      status: 'uncertain',
      outcome: 'ambiguous',
      asset: USDT,
      amount: 67_011n,
      payTo: BUY_PAY_TO,
      authorization: { from: SPEND, nonce: gw.payments[0]!.payload.authorization.nonce },
    });
    // The money may have moved: it counts.
    expect(await store.orderCost(orderId)).toBeCloseTo(0.067011);
  });

  it('treats a connection that drops after the payment went out as uncertain, and keeps the authorization', async () => {
    gw.paid = () => {
      throw new TypeError('fetch failed');
    };
    expect(await payForVm(a, deps)).toMatchObject({ status: 'uncertain' });
    expect(await payment()).toMatchObject({ status: 'uncertain', outcome: 'ambiguous', authorization: { nonce: gw.payments[0]!.payload.authorization.nonce } });
    expect(gw.paidCalls).toBe(1);
  });

  it('treats a refusal after paying as uncertain: buy may have settled before it refused', async () => {
    gw.paid = () => json(409, { error: 'no capacity' });
    expect((await payForVm(a, deps)).status).toBe('uncertain');
    expect(await payment()).toMatchObject({ status: 'uncertain', outcome: 'rejected' });
  });

  it('treats a payment buy did not take (a second 402) as uncertain, never as a reason to pay again', async () => {
    gw.paid = () => json(402, { x402Version: 1, accepts: [], error: 'settle_failed' });
    expect((await payForVm(a, deps)).status).toBe('uncertain');
    expect(gw.paidCalls).toBe(1);
    expect(await payment()).toMatchObject({ status: 'uncertain', outcome: 'rejected' });
  });

  it('never pays twice for the same order', async () => {
    await payForVm(a, deps);
    gw.reset();
    expect((await payForVm(a, deps)).status).toBe('uncertain');
    expect(gw.calls).toBe(0);
  });

  it('says the second try found the first one, and leaves its record as it was', async () => {
    await payForVm(a, deps);
    const first = await payment();
    expect(await payForVm(a, deps)).toEqual({ status: 'uncertain', reason: 'intent-exists' });
    expect(await payment()).toEqual(first);
    expect(await store.orderCost(orderId)).toBeCloseTo(0.067011);
  });

  it('pays once when two tries for the same order run at the same time', async () => {
    const results = await Promise.all([payForVm(a, deps), payForVm(a, deps)]);
    expect(results.map((r) => r.status).sort()).toEqual(['paid', 'uncertain']);
    expect(gw.paidCalls).toBe(1);
  });

  it('never pays on a retried step attempt', async () => expect((await payForVm({ ...a, attempt: 2 }, deps)).status).toBe('uncertain'));

  it('does nothing at all on a retried step attempt', async () => {
    expect(await payForVm({ ...a, attempt: 2 }, deps)).toEqual({ status: 'uncertain', reason: 'retry-attempt' });
    expect(gw.calls).toBe(0);
    expect(await payment()).toBeNull();
  });

  it('writes the authorization down and counts the cost before the paid request goes out', async () => {
    let atSend: { record: PaymentRecord | null; cost: number } | undefined;
    gw.paid = async (sent) => {
      atSend = { record: await payment(), cost: await store.orderCost(orderId) };
      return servedVm(sent);
    };
    await payForVm(a, deps);
    expect(atSend?.record).toMatchObject({
      status: 'intent',
      asset: USDT,
      amount: 67_011n,
      payTo: BUY_PAY_TO,
      authorization: { from: SPEND, nonce: gw.payments[0]!.payload.authorization.nonce },
    });
    expect(atSend?.cost).toBeCloseTo(0.067011);
  });

  it('stops before signing when the daily buy cap would be passed', async () => {
    await store.addCost(await newOrder(), 'buy:vm', 1.95, 'buy');
    expect(await payForVm(a, deps)).toEqual({ status: 'rejected', reason: 'daily-cap' });
    expect(gw.paidCalls).toBe(0);
    expect(await payment()).toMatchObject({ status: 'rejected', reason: 'daily-cap', authorization: null });
    expect(await store.orderCost(orderId)).toBe(0);
  });

  it('pays up to the daily cap exactly', async () => {
    // 1.83 + 0.07 is 1.9000000000000001 in floating point: the cap is compared in millionths of a dollar.
    await store.addCost(await newOrder(), 'buy:vm', 1.83, 'buy');
    expect((await payForVm(a, { ...deps, dailyCapUsd: 1.9 })).status).toBe('paid');
  });

  it('counts only what buy cost since the start of the UTC day', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 9, 17, 23, 59) });
    await store.addCost(await newOrder(), 'buy:vm', 1.95, 'buy');
    vi.setSystemTime(Date.UTC(2026, 9, 18, 0, 1));
    expect((await payForVm(a, deps)).status).toBe('paid');
  });

  it('refuses to sign when the spend wallet cannot cover the quote', async () => {
    chain.balance = 67_010n;
    expect(await payForVm(a, deps)).toEqual({ status: 'rejected', reason: 'insufficient_balance' });
    expect(gw.paidCalls).toBe(0);
  });

  it('pays nothing when buy does not ask for a payment', async () => {
    const down = new CeloBuy({ spendKey: SPEND_KEY, rpcUrl: 'https://celo-mainnet.example', fetch: async () => json(503, { error: 'unavailable' }), transport: chain.transport });
    expect(await payForVm(a, { ...deps, buy: down })).toEqual({ status: 'rejected', reason: 'buy answered 503 without asking for a payment' });
    expect(await payment()).toMatchObject({ status: 'rejected', authorization: null });
  });

  it('takes the poll URL from the body when buy sends no Content-Location', async () => {
    gw.paid = () => json(200, { poll: 'https://usebuy.ai/google/vm/xyz' });
    expect(await payForVm(a, deps)).toEqual({ status: 'paid', pollUrl: 'https://usebuy.ai/google/vm/xyz' });
    expect(await payment()).toMatchObject({ pollUrl: 'https://usebuy.ai/google/vm/xyz' });
  });

  it('keeps no poll URL that is not on buy\'s own origin', async () => {
    gw.paid = () => json(200, { poll: 'https://elsewhere.example/google/vm/xyz' });
    expect(await payForVm(a, deps)).toEqual({ status: 'paid', pollUrl: null });
  });

  /** The store, with the `n`th writes to a payment failing (counting from 1): the first one is the authorization's. */
  const failingWrites = (...failing: number[]) => {
    let writes = 0;
    return Object.assign(Object.create(store) as FileStore, {
      updatePayment: async (...args: Parameters<FileStore['updatePayment']>) => {
        writes += 1;
        if (failing.includes(writes)) throw new Error('the database is down');
        return store.updatePayment(...args);
      },
    });
  };

  it('keeps the poll URL of a payment buy served when recording it fails, and writes it with the next record', async () => {
    // The write after the 200 fails; the one that records the payment as uncertain goes through.
    const result = await payForVm(a, { ...deps, store: failingWrites(2) });
    expect(result).toEqual({ status: 'uncertain', reason: 'the database is down', pollUrl: 'https://usebuy.ai/google/vm/abc' });
    expect(await payment()).toMatchObject({
      status: 'uncertain',
      outcome: 'confirmed',
      pollUrl: 'https://usebuy.ai/google/vm/abc',
      txHash: `0x${'6d'.repeat(32)}`,
      authorization: { nonce: gw.payments[0]!.payload.authorization.nonce },
    });
  });

  it('still answers with the poll URL when nothing after the payment can be written, and logs no URL', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await payForVm(a, { ...deps, store: failingWrites(2, 3) });
      // The flow's step keeps what this returns, when the store cannot.
      expect(result).toEqual({ status: 'uncertain', reason: 'the database is down', pollUrl: 'https://usebuy.ai/google/vm/abc' });
      expect(logged).toHaveBeenCalledWith('[vm_payment_unrecorded]', orderId, 'uncertain', 'Error');
      expect(JSON.stringify(logged.mock.calls)).not.toContain('/google/vm/');
    } finally {
      logged.mockRestore();
    }
  });

  it('answers with its refusal even when the refusal cannot be written', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await store.addCost(await newOrder(), 'buy:vm', 1.95, 'buy');
      expect(await payForVm(a, { ...deps, store: failingWrites(1) })).toEqual({ status: 'rejected', reason: 'daily-cap' });
      expect(gw.paidCalls).toBe(0);
      expect(logged).toHaveBeenCalledWith('[vm_payment_unrecorded]', orderId, 'rejected', 'Error');
    } finally {
      logged.mockRestore();
    }
  });

  it('records and counts a payment its adapter reports as gone out without the check before it', async () => {
    // An adapter whose payment went out unseen (see CeloBuy's backstop): onPayment arrives with no beforePayment.
    const authorization = { from: SPEND, nonce: `0x${'cd'.repeat(32)}`, validAfter: '0', validBefore: '1790000000' };
    const unseen: Pick<BuyPort, 'rentVm'> = {
      rentVm: async ({ onPayment }) => {
        await onPayment({ asset: USDT, amount: 67_011n, payTo: BUY_PAY_TO, authorization, outcome: 'ambiguous', timestamp: new Date().toISOString() });
        return { outcome: 'ambiguous', reason: 'unseen' };
      },
    };
    expect(await payForVm(a, { store, buy: unseen, dailyCapUsd: 2 })).toEqual({ status: 'uncertain', reason: 'unseen' });
    expect(await payment()).toMatchObject({ status: 'uncertain', asset: USDT, amount: 67_011n, payTo: BUY_PAY_TO, authorization });
    expect(await store.orderCost(orderId)).toBeCloseTo(0.067011);
  });

  it('sends nothing when the authorization cannot be written down first', async () => {
    // The first write is the authorization; the one after it records the refusal.
    expect(await payForVm(a, { ...deps, store: failingWrites(1) })).toMatchObject({ status: 'rejected' });
    expect(gw.paidCalls).toBe(0);
    expect(await store.orderCost(orderId)).toBe(0);
  });
});

describe('resolveVmPayment', () => {
  it('resolves an uncertain payment from chain state', async () => {
    // buy settled the payment on chain, then failed to answer.
    gw.paid = () => json(500, {});
    expect((await payForVm(a, deps)).status).toBe('uncertain');
    expect(await resolveVmPayment(orderId, deps)).toBe('settled');
    expect(await payment()).toMatchObject({ status: 'settled' });
  });

  it('asks whether buy\'s wallet got the quoted amount from the spend wallet, with this authorization', async () => {
    gw.paid = () => json(500, {});
    await payForVm(a, deps);
    const chainOf = new FakeBuy();
    const record = (await payment())!;
    chainOf.consumed(record.authorization!.nonce, { to: BUY_PAY_TO, value: 67_011n });
    expect(await resolveVmPayment(orderId, { store, buy: chainOf })).toBe('settled');
    expect(chainOf.settlementQueries).toEqual([{ asset: USDT, authorization: record.authorization, to: BUY_PAY_TO, value: 67_011n }]);
  });

  it('answers unknown, and leaves the record as it is, while the authorization can still settle', async () => {
    gw.settles = false;
    gw.paid = () => json(500, {});
    await payForVm(a, deps);
    expect(await resolveVmPayment(orderId, deps)).toBe('unknown');
    expect(await payment()).toMatchObject({ status: 'uncertain' });
  });

  describe('an authorization that expired unspent', () => {
    /** An uncertain payment buy never settled, looked at `seconds` after its validBefore. */
    const expiredBy = async (seconds: number) => {
      gw.settles = false;
      gw.paid = () => json(500, {});
      await payForVm(a, deps);
      const validBefore = Number((await payment())!.authorization!.validBefore);
      vi.useFakeTimers({ toFake: ['Date'], now: (validBefore + seconds) * 1000 });
      chain.head.timestamp = BigInt(validBefore + seconds);
    };

    it('is unsettled a full minute after validBefore, when even a server clock running ahead of the chain is past it', async () => {
      await expiredBy(60);
      expect(await resolveVmPayment(orderId, deps)).toBe('unsettled');
      expect(await payment()).toMatchObject({ status: 'unsettled' });
    });

    it('is still unknown in the minute after validBefore, and the record stays as it is', async () => {
      await expiredBy(59);
      expect(await resolveVmPayment(orderId, deps)).toBe('unknown');
      expect(await payment()).toMatchObject({ status: 'uncertain' });
    });
  });

  it('answers unknown when the chain cannot be read', async () => {
    gw.paid = () => json(500, {});
    await payForVm(a, deps);
    chain.down = true;
    expect(await resolveVmPayment(orderId, deps)).toBe('unknown');
    expect(await payment()).toMatchObject({ status: 'uncertain' });
  });

  it('resolves a payment whose answer never came back, from what was written before it went out', async () => {
    // As if the process died while waiting for buy: the authorization is written, nothing after it.
    await store.insertPaymentIntent({ key: vmPaymentKey(orderId), orderId, kind: 'vm', maxAtomic: VM_MAX_ATOMIC });
    const authorization = { from: SPEND, nonce: `0x${'ab'.repeat(32)}`, validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 300) };
    await store.updatePayment(vmPaymentKey(orderId), { asset: USDT, amount: 67_011n, payTo: BUY_PAY_TO, authorization });
    chain.settle({ token: USDT, from: SPEND, to: BUY_PAY_TO, value: 67_011n, nonce: `0x${'ab'.repeat(32)}` });
    expect(await resolveVmPayment(orderId, deps)).toBe('settled');
    expect(await payment()).toMatchObject({ status: 'settled' });
  });

  it('trusts a payment buy served, without asking the chain', async () => {
    await payForVm(a, deps);
    const chainOf = new FakeBuy();
    expect(await resolveVmPayment(orderId, { store, buy: chainOf })).toBe('settled');
    expect(chainOf.settlementQueries).toEqual([]);
  });

  it('answers unsettled for a payment that never went out, without asking the chain', async () => {
    await store.addCost(await newOrder(), 'buy:vm', 1.95, 'buy');
    await payForVm(a, deps);
    const chainOf = new FakeBuy();
    expect(await resolveVmPayment(orderId, { store, buy: chainOf })).toBe('unsettled');
    expect(chainOf.settlementQueries).toEqual([]);
  });

  it('answers unsettled for an order that never tried to pay', async () => {
    expect(await resolveVmPayment(orderId, { store, buy: new FakeBuy() })).toBe('unsettled');
  });

  it('answers unknown for an intent with no authorization yet: it may still be on its way', async () => {
    await store.insertPaymentIntent({ key: vmPaymentKey(orderId), orderId, kind: 'vm', maxAtomic: VM_MAX_ATOMIC });
    const chainOf = new FakeBuy();
    expect(await resolveVmPayment(orderId, { store, buy: chainOf })).toBe('unknown');
    expect(chainOf.settlementQueries).toEqual([]);
  });
});

describe('payForVm on the fake buy', () => {
  const scenario = (s: Record<string, string>) => vi.stubEnv('FAKE_SCENARIO', JSON.stringify(s));

  beforeEach(() => {
    deps = { store, buy: new FakeBuy(), dailyCapUsd: 2 };
  });

  it('pays by default, with a poll URL, and the chain then says it settled', async () => {
    const result = await payForVm(a, deps);
    expect(result).toMatchObject({ status: 'paid', pollUrl: expect.stringMatching(/^https:\/\/usebuy\.ai\/google\/vm\//) });
    expect(await payment()).toMatchObject({ status: 'paid', asset: USDT, amount: 67_011n, payTo: BUY_PAY_TO });
    expect(await store.orderCost(orderId)).toBeCloseTo(0.067011);
    expect(await resolveVmPayment(orderId, deps)).toBe('settled');
  });

  it('answers ambiguously when FAKE_SCENARIO says so, and settles as it says', async () => {
    scenario({ buy: 'ambiguous', settled: 'settled' });
    expect((await payForVm(a, deps)).status).toBe('uncertain');
    expect(await payment()).toMatchObject({ status: 'uncertain', outcome: 'ambiguous' });
    expect(await resolveVmPayment(orderId, deps)).toBe('settled');
  });

  it('leaves an ambiguous payment unresolved when the scenario says it did not settle in time', async () => {
    scenario({ buy: 'ambiguous', settled: 'unsettled' });
    expect((await payForVm(a, deps)).status).toBe('uncertain');
    expect(await resolveVmPayment(orderId, deps)).not.toBe('settled');
  });

  it('refuses without paying when FAKE_SCENARIO says buy rejects', async () => {
    scenario({ buy: 'rejected' });
    expect(await payForVm(a, deps)).toMatchObject({ status: 'rejected' });
    expect(await payment()).toMatchObject({ status: 'rejected', authorization: null });
    expect(await store.orderCost(orderId)).toBe(0);
  });

  it('reads FAKE_SCENARIO when it is asked, not when it was made', async () => {
    const fake = deps.buy;
    scenario({ buy: 'rejected' });
    expect((await payForVm(a, { ...deps, buy: fake })).status).toBe('rejected');
    scenario({ buy: 'paid' });
    expect((await payForVm({ ...a, orderId: await newOrder() }, { ...deps, buy: fake })).status).toBe('paid');
  });

  it('keeps to the daily cap like the real one', async () => {
    await store.addCost(await newOrder(), 'buy:vm', 1.95, 'buy');
    expect(await payForVm(a, deps)).toEqual({ status: 'rejected', reason: 'daily-cap' });
    expect((deps.buy as FakeBuy).vmRentals).toHaveLength(1);
  });

  it('answers FAKE_SCENARIO.settled for an authorization a test said nothing about, after what a test did say', async () => {
    scenario({ settled: 'unsettled' });
    const fake = new FakeBuy();
    const ask = (nonce: string) => fake.authorizationSettled({ asset: USDT, authorization: { from: SPEND, nonce, validAfter: '0', validBefore: '1' }, to: BUY_PAY_TO, value: 1n });
    fake.settlement('0x01', 'settled');
    fake.consumed('0x02', { to: BUY_PAY_TO, value: 1n });
    expect([await ask('0x01'), await ask('0x02'), await ask('0x03')]).toEqual(['settled', 'settled', 'unsettled']);
  });

  it('follows a VM it rented', async () => {
    const result = await payForVm(a, deps);
    if (result.status !== 'paid' || result.pollUrl === null) throw new Error('expected a paid VM with a poll URL');
    expect(await deps.buy.pollVm(result.pollUrl)).toMatchObject({ gone: false, vmStatus: 'RUNNING' });
    expect(await deps.buy.pollVm('https://usebuy.ai/google/vm/never-rented')).toEqual({ gone: true });
  });

  it('says what is wrong with a FAKE_SCENARIO it cannot read', async () => {
    vi.stubEnv('FAKE_SCENARIO', '{"buy":"sometimes"}');
    await expect(new FakeBuy().rentVm({ body: { script: SCRIPT, machineType: 'e2-medium' }, maxAtomic: VM_MAX_ATOMIC, beforePayment: async () => {}, onPayment: async () => {} })).rejects.toThrow('FAKE_SCENARIO');
  });
});
