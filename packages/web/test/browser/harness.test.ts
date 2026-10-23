// The test bed of the page's browser tests: the app under `next dev` on the fake adapters, Chrome Headless Shell with the
// stub wallet, a network that ends at this machine, and orders seeded in the fake store. Each later page test stands on
// what this file checks.
import type { Page } from 'puppeteer-core';
import { decodeFunctionResult, encodeFunctionData, erc20Abi, multicall3Abi, recoverTypedDataAddress, type Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StatusJson } from '../../src/payments/orders';
import { TOKENS } from '../../src/payments/tokens';
import { launchPage, startApp, type App } from './support/app';
import { seedOrder } from './support/seed';
import { MULTICALL3, type Eip1193Provider } from './support/wallet';

const CELO = '0xa4ec';
/** The test app's PAYTO_ADDRESS. */
const PAYTO = `0x${'d'.repeat(40)}`;

type RpcOutcome = { result: unknown } | { error: { code: unknown; message: string } };

/** Asks the wallet in the page, as the page would, and says what came back: its answer, or its error's code and message. */
const ask = (page: Page, method: string, params: unknown[] = []): Promise<RpcOutcome> =>
  page.evaluate(
    async (m, p) => {
      try {
        return { result: await (window as unknown as { ethereum: Eip1193Provider }).ethereum.request({ method: m, params: p }) };
      } catch (error) {
        return { error: { code: (error as { code?: unknown }).code, message: (error as Error).message } };
      }
    },
    method,
    params,
  );

/** What a JSON-RPC POST to Celo's public node answers, sent from the page. */
const askForno = (page: Page, body: unknown): Promise<unknown> =>
  page.evaluate(async (text) => {
    const res = await fetch('https://forno.celo.org', { method: 'POST', headers: { 'content-type': 'application/json' }, body: text });
    return res.json();
  }, JSON.stringify(body));

const balanceCall = (token: string, owner: string) => ({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [owner as Hex] }) });
const balanceOf = (result: unknown): bigint => decodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', data: result as Hex });

const AUTHORIZATION_TYPES = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/** The authorization an x402 payment of 0.01 USDT asks the wallet to sign, as JSON as viem sends it: numbers as text. */
const transferAuthorization = (from: string) => ({
  domain: { name: 'Tether USD', version: '1', chainId: 42220, verifyingContract: TOKENS.USDT.address },
  types: AUTHORIZATION_TYPES,
  primaryType: 'TransferWithAuthorization' as const,
  message: { from, to: PAYTO, value: '10000', validAfter: '0', validBefore: '1790000000', nonce: `0x${'ab'.repeat(32)}` },
});

const getStatus = async (base: string, id: string): Promise<StatusJson> => {
  const res = await fetch(`${base}/v1/videos/${id}`);
  expect(res.status).toBe(200);
  return (await res.json()) as StatusJson;
};

describe('the app in fake mode, and Chrome with the stub wallet', () => {
  let app: App;
  beforeAll(async () => {
    app = await startApp();
  });
  afterAll(async () => {
    await app?.stop();
  });

  const quote = (url: string) =>
    fetch(`${app.url}/v1/videos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, audio: 'music' }) });

  it('serves /terms and quotes a site in fake mode', async () => {
    const rich = await quote('https://tiendita.example/');
    expect(rich.status).toBe(402);
    expect(await rich.json()).toMatchObject({ precheck: { thinSite: false }, price: { amount: '0.05', assets: ['USDT', 'USDC'] } });
    const thin = await quote('https://thin.tiendita.example/');
    expect(thin.status).toBe(402);
    expect(await thin.json()).toMatchObject({ precheck: { thinSite: true } });

    const { browser, page, blockedRequests } = await launchPage(app);
    try {
      expect((await page.goto(`${app.url}/terms`))?.status()).toBe(200);
      expect(await page.$eval('h1', (heading) => heading.textContent)).toBe('Terms of service');
      expect(await ask(page, 'eth_chainId')).toEqual({ result: CELO });
      expect(blockedRequests()).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it('refuses a login wall in fake mode, as the real pre-check does', async () => {
    const res = await quote('https://tiendita.example/login');
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'login_wall' });
  });

  it('announces the stub wallet by EIP-6963 and as window.ethereum', async () => {
    const { browser, page } = await launchPage(app);
    try {
      await page.goto(`${app.url}/terms`);
      const announced = await page.evaluate(() => {
        const found: { rdns: string; isWindowEthereum: boolean }[] = [];
        window.addEventListener('eip6963:announceProvider', (event) => {
          const { info, provider } = (event as CustomEvent<{ info: { rdns: string }; provider: unknown }>).detail;
          found.push({ rdns: info.rdns, isWindowEthereum: provider === (window as unknown as { ethereum: unknown }).ethereum });
        });
        window.dispatchEvent(new Event('eip6963:requestProvider'));
        return found;
      });
      expect(announced).toEqual([{ rdns: 'test.stub-wallet', isWindowEthereum: true }]);
    } finally {
      await browser.close();
    }
  });

  it('connects, and signs typed data with its own key, counting the requests to sign', async () => {
    const { browser, page, wallet } = await launchPage(app);
    try {
      await page.goto(`${app.url}/terms`);
      expect(await ask(page, 'eth_accounts')).toEqual({ result: [] });
      expect(await ask(page, 'eth_requestAccounts')).toEqual({ result: [wallet.address] });
      expect(await ask(page, 'eth_accounts')).toEqual({ result: [wallet.address] });
      expect(wallet.signatureRequests()).toBe(0);

      const typed = transferAuthorization(wallet.address);
      const signed = await ask(page, 'eth_signTypedData_v4', [wallet.address, JSON.stringify(typed)]);
      if (!('result' in signed)) throw new Error(`The stub wallet did not sign: ${signed.error.message}`);
      const { from, to, nonce } = typed.message;
      const message = { from: from as Hex, to: to as Hex, nonce: nonce as Hex, value: 10_000n, validAfter: 0n, validBefore: 1_790_000_000n };
      const signer = await recoverTypedDataAddress({
        domain: typed.domain,
        types: { TransferWithAuthorization: AUTHORIZATION_TYPES.TransferWithAuthorization },
        primaryType: 'TransferWithAuthorization',
        message,
        signature: signed.result as Hex,
      });
      expect(signer).toBe(wallet.address);
      expect(wallet.signatureRequests()).toBe(1);
    } finally {
      await browser.close();
    }
  });

  it('answers a refused signature with the EIP-1193 user-rejected error, and still counts the request', async () => {
    const { browser, page, wallet } = await launchPage(app, { rejectSignature: true });
    try {
      await page.goto(`${app.url}/terms`);
      await ask(page, 'eth_requestAccounts');
      const refused = await ask(page, 'eth_signTypedData_v4', [wallet.address, JSON.stringify(transferAuthorization(wallet.address))]);
      expect(refused).toEqual({ error: { code: 4001, message: 'User rejected the request.' } });
      expect(wallet.signatureRequests()).toBe(1);
    } finally {
      await browser.close();
    }
  });

  it('asks to add a chain it does not know before switching to it, and says when the chain changes', async () => {
    const { browser, page } = await launchPage(app, { chainId: 1 });
    try {
      await page.goto(`${app.url}/terms`);
      await page.evaluate(() => {
        const changes: unknown[] = [];
        (window as unknown as { chainChanges: unknown[] }).chainChanges = changes;
        (window as unknown as { ethereum: Eip1193Provider }).ethereum.on('chainChanged', (chainId) => changes.push(chainId));
      });
      const changes = () => page.evaluate(() => (window as unknown as { chainChanges: unknown[] }).chainChanges);
      expect(await ask(page, 'eth_chainId')).toEqual({ result: '0x1' });

      const refused = await ask(page, 'wallet_switchEthereumChain', [{ chainId: CELO }]);
      expect(refused).toMatchObject({ error: { code: 4902 } });
      expect(await ask(page, 'eth_chainId')).toEqual({ result: '0x1' });

      const celo = { chainId: CELO, chainName: 'Celo', nativeCurrency: { name: 'Celo', symbol: 'CELO', decimals: 18 }, rpcUrls: ['https://forno.celo.org'] };
      expect(await ask(page, 'wallet_addEthereumChain', [celo])).toEqual({ result: null });
      expect(await ask(page, 'eth_chainId')).toEqual({ result: CELO });
      expect(await changes()).toEqual([CELO]);

      expect(await ask(page, 'wallet_switchEthereumChain', [{ chainId: '0x1' }])).toEqual({ result: null });
      expect(await ask(page, 'wallet_switchEthereumChain', [{ chainId: CELO }])).toEqual({ result: null });
      expect(await changes()).toEqual([CELO, '0x1', CELO]);
    } finally {
      await browser.close();
    }
  });

  it('reads the balances it was given, through the wallet, through Celo’s node and through a multicall', async () => {
    const { browser, page, wallet } = await launchPage(app, { balances: { USDT: 2_500_000n } });
    try {
      await page.goto(`${app.url}/terms`);
      const usdt = balanceCall(TOKENS.USDT.address, wallet.address);
      const usdc = balanceCall(TOKENS.USDC.address, wallet.address);

      const fromWallet = await ask(page, 'eth_call', [usdt, 'latest']);
      expect(balanceOf((fromWallet as { result: unknown }).result)).toBe(2_500_000n);

      const fromForno = (await askForno(page, [
        { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
        { jsonrpc: '2.0', id: 2, method: 'eth_call', params: [usdt, 'latest'] },
        { jsonrpc: '2.0', id: 3, method: 'eth_call', params: [usdc, 'latest'] },
      ])) as { id: number; result: unknown }[];
      expect(fromForno.map((answer) => answer.id)).toEqual([1, 2, 3]);
      expect(fromForno[0]?.result).toBe(CELO);
      expect(balanceOf(fromForno[1]?.result)).toBe(2_500_000n);
      expect(balanceOf(fromForno[2]?.result)).toBe(0n);

      const calls = [usdt, usdc].map(({ to, data }) => ({ target: to as Hex, allowFailure: true, callData: data }));
      const multicall = { to: MULTICALL3, data: encodeFunctionData({ abi: multicall3Abi, functionName: 'aggregate3', args: [calls] }) };
      const single = (await askForno(page, { jsonrpc: '2.0', id: 7, method: 'eth_call', params: [multicall, 'latest'] })) as { id: number; result: Hex };
      expect(single.id).toBe(7);
      const results = decodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', data: single.result });
      expect(results.map(({ success, returnData }) => (success ? balanceOf(returnData) : null))).toEqual([2_500_000n, 0n]);
    } finally {
      await browser.close();
    }
  });

  it('lets nothing leave the machine: every other request is cut off, and listed', async () => {
    const { browser, page, blockedRequests } = await launchPage(app);
    try {
      await page.goto(`${app.url}/terms`);
      const outcome = await page.evaluate(() =>
        fetch('https://example.com/tracker.js').then(
          () => 'reached',
          () => 'blocked',
        ),
      );
      expect(outcome).toBe('blocked');
      expect(blockedRequests()).toEqual(['https://example.com/tracker.js']);
    } finally {
      await browser.close();
    }
  });

  it('plays the video of a seeded delivered order, and gives its other files, through their download links', async () => {
    const id = await seedOrder(app.fakeDir, 'delivered');
    const status = await getStatus(app.url, id);
    expect(status).toMatchObject({ id, status: 'delivered', music: { model: 'Google Lyria 3.5', bpm: 120 } });
    expect(status.claims).toHaveLength(2);
    const files = new Map(status.files?.map((file) => [file.name, file.url]));
    expect([...files.keys()]).toEqual(['hook-a-9x16.mp4', 'hook-a-9x16-muted.mp4', 'claims.md', 'music.md']);

    const { browser, page, blockedRequests } = await launchPage(app);
    try {
      await page.goto(`${app.url}/terms`);
      const video = await page.evaluate(
        (src) =>
          new Promise<{ width: number; height: number; duration: number }>((resolve, reject) => {
            const element = document.createElement('video');
            // After loadedmetadata, once its first frame is decoded: Chrome Headless Shell plays H.264.
            element.addEventListener('loadeddata', () => resolve({ width: element.videoWidth, height: element.videoHeight, duration: element.duration }));
            element.addEventListener('error', () => reject(new Error(`The video did not load (media error ${element.error?.code}).`)));
            element.src = src;
          }),
        files.get('hook-a-9x16-muted.mp4') ?? '',
      );
      expect(video.height / video.width).toBeCloseTo(16 / 9, 2);
      expect(video.duration).toBeGreaterThanOrEqual(1);
      expect(video.duration).toBeLessThanOrEqual(2);

      const claims = await page.evaluate((src) => fetch(src).then((res) => res.text()), files.get('claims.md') ?? '');
      expect(claims).toContain('# Claims');
      expect(blockedRequests()).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it('seeds an order in each other state as the status shows it, with what the test patches in', async () => {
    const running = await getStatus(app.url, await seedOrder(app.fakeDir, 'running'));
    expect(running.status).toBe('running');
    expect(running.steps.filter((step) => step.state !== 'pending')).toEqual([
      { name: 'payment', state: 'done' },
      { name: 'capture', state: 'running' },
    ]);

    const refunded = await getStatus(app.url, await seedOrder(app.fakeDir, 'refunded'));
    expect(refunded).toMatchObject({ status: 'refunded', refund: { status: 'confirmed', txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) } });

    const unpaid = await getStatus(app.url, await seedOrder(app.fakeDir, 'unpaid', { warnings: ['A warning the test put in.'] }));
    expect(unpaid).toMatchObject({ status: 'unpaid', warnings: ['A warning the test put in.'] });

    const expired = await getStatus(app.url, await seedOrder(app.fakeDir, 'expired'));
    expect(expired.status).toBe('expired');
    expect(expired.files).toBeUndefined();
  });
});

describe('another app, with other settings', () => {
  it('starts once the first one has stopped, with the first-video promo on', async () => {
    const app = await startApp({ PROMO_SLOTS: '3' });
    try {
      const res = await fetch(`${app.url}/v1/offer`);
      expect(await res.json()).toEqual({ price: '0.05', assets: ['USDT', 'USDC'], promo: { price: '0.01', left: 3 } });
    } finally {
      await app.stop();
    }
    await expect(fetch(`${app.url}/v1/offer`)).rejects.toThrow();
  });
});
