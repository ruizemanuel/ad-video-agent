import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createAdapters } from '../src/adapters';
import { FakeBuy } from '../src/adapters/fake/buy';
import { FileBlob } from '../src/adapters/fake/blob';
import { FakeLlm } from '../src/adapters/fake/llm';
import { FakeMusic } from '../src/adapters/fake/music';
import { FakeRefunds } from '../src/adapters/fake/refunds';
import { FileStore } from '../src/adapters/fake/store';
import { VercelBlob } from '../src/adapters/real/blob';
import { CeloBuy } from '../src/adapters/real/buy';
import { GatewayLlm } from '../src/adapters/real/llm';
import { LyriaMusic } from '../src/adapters/real/music';
import { CeloRefunds } from '../src/adapters/real/refunds';
import { DrizzleStore } from '../src/adapters/real/store';
import { parseEnv } from '../src/env';

const dirs: string[] = [];
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'adapters-'));
  dirs.push(dir);
  return dir;
};
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const common = {
  PAYTO_ADDRESS: `0x${'1'.repeat(40)}`,
  LINK_SIGNING_SECRET: 'a'.repeat(32),
  CRON_SECRET: 'b'.repeat(32),
};

const order = {
  request: { url: 'https://example.com', audio: 'music' as const },
  network: 'eip155:42220',
  asset: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e',
  payer: '0x1234567890AbcdEF1234567890aBcdef12345678',
  amount: 5_000_000n,
  nonce: `0x${'1'.repeat(64)}`,
  validAfter: 0n,
  validBefore: 1_790_000_000n,
};

describe('createAdapters on the fake adapters', () => {
  it('gives a file-backed store and blob over FAKE_DIR, and the buy, model, music and refund doubles', async () => {
    const dir = await tempDir();
    const { store, blob, buy, llm, music, refunds } = await createAdapters(parseEnv({ ...common, AD_AGENT_ADAPTERS: 'fake', FAKE_DIR: dir }));
    expect(store).toBeInstanceOf(FileStore);
    expect(blob).toBeInstanceOf(FileBlob);
    expect(buy).toBeInstanceOf(FakeBuy);
    expect(llm).toBeInstanceOf(FakeLlm);
    expect(music).toBeInstanceOf(FakeMusic);
    expect(refunds).toBeInstanceOf(FakeRefunds);
  });

  it('shares what it keeps with the next adapters over the same directory, as a test and the flow it runs do', async () => {
    const settings = parseEnv({ ...common, AD_AGENT_ADAPTERS: 'fake', FAKE_DIR: await tempDir() });
    const first = await createAdapters(settings);
    const second = await createAdapters(settings);
    const { order: created } = await first.store.createOrder(order);
    await first.blob.put(`orders/${created.id}/capture.json`, '{}', 'application/json');
    expect(await second.store.getOrder(created.id)).toEqual(created);
    expect(new TextDecoder().decode(await second.blob.get(`orders/${created.id}/capture.json`))).toBe('{}');
  });

  it('says what is missing when there is no FAKE_DIR', async () => {
    await expect(createAdapters(parseEnv({ ...common, AD_AGENT_ADAPTERS: 'fake' }))).rejects.toThrow('FAKE_DIR');
  });
});

describe('createAdapters on the real adapters', () => {
  it('gives the Postgres store, the Vercel Blob adapter, buy on Celo, the models over the AI Gateway, Lyria over the Gemini API and the refunds on Celo, built from the settings and not yet used', async () => {
    const settings = parseEnv({
      ...common,
      DATABASE_URL: 'memory',
      BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_store123_secretpart',
      X402_API_KEY: 'x402_abc',
      SPEND_WALLET_PRIVATE_KEY: `0x${'2'.repeat(64)}`,
      REFUND_WALLET_PRIVATE_KEY: `0x${'3'.repeat(64)}`,
      GEMINI_API_KEY: 'gemini-key',
      PUBLIC_BASE_URL: 'https://ad-video-agent.vercel.app',
      GITHUB_REPO: 'ruizemanuel/ad-video-agent',
    });
    const { store, blob, buy, llm, music, refunds } = await createAdapters(settings);
    expect(store).toBeInstanceOf(DrizzleStore);
    expect(blob).toBeInstanceOf(VercelBlob);
    expect(buy).toBeInstanceOf(CeloBuy);
    expect(llm).toBeInstanceOf(GatewayLlm);
    expect(music).toBeInstanceOf(LyriaMusic);
    expect(refunds).toBeInstanceOf(CeloRefunds);
    expect(await store.getOrder('ord_doesnotexist')).toBeNull();
  });
});

describe('getAdapters', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('builds the adapters once and gives the same ones to everyone, so a double keeps what it records', async () => {
    vi.stubEnv('AD_AGENT_ADAPTERS', 'fake');
    vi.stubEnv('FAKE_DIR', await tempDir());
    for (const [name, value] of Object.entries(common)) vi.stubEnv(name, value);
    const { getAdapters } = await import('../src/adapters');
    const [first, second] = [await getAdapters(), await getAdapters()];
    expect(second).toBe(first);
    expect(await Promise.all([getAdapters(), getAdapters()])).toEqual([first, first]);
  });

  it('gives the cron routes the same adapters, buy included', async () => {
    vi.stubEnv('AD_AGENT_ADAPTERS', 'fake');
    vi.stubEnv('FAKE_DIR', await tempDir());
    for (const [name, value] of Object.entries(common)) vi.stubEnv(name, value);
    const { getAdapters } = await import('../src/adapters');
    const { cronDeps } = await import('../src/app/api/cron/deps');
    const { store, blob, buy } = await getAdapters();
    const deps = await cronDeps();
    expect(deps.store).toBe(store);
    expect(deps.blob).toBe(blob);
    expect(deps.buy).toBe(buy);
    // It answers, where the cron used to get a buy that always failed.
    vi.stubEnv('FAKE_SCENARIO', JSON.stringify({ settled: 'settled' }));
    const authorization = { from: order.payer, nonce: order.nonce, validAfter: '0', validBefore: '1790000000' };
    expect(await deps.buy.authorizationSettled({ asset: order.asset, authorization, to: common.PAYTO_ADDRESS, value: order.amount })).toBe('settled');
  });

  it('gives the videos route the same store and the same models, so a production quote can classify the site', async () => {
    vi.stubEnv('AD_AGENT_ADAPTERS', 'fake');
    vi.stubEnv('FAKE_DIR', await tempDir());
    for (const [name, value] of Object.entries(common)) vi.stubEnv(name, value);
    const { getAdapters } = await import('../src/adapters');
    const { videosDeps } = await import('../src/app/v1/videos/deps');
    const { store, llm } = await getAdapters();
    const deps = await videosDeps();
    expect(deps.store).toBe(store);
    expect(deps.llm).toBe(llm);
    // It answers, where the route used to get a classifier that always failed.
    expect(await deps.llm.classifySite({ url: 'https://example.com/', title: 'Example', text: 'A shop.' })).toMatchObject({ admissible: true });
  });

  it('rejects, instead of throwing, when the environment is wrong', async () => {
    vi.stubEnv('AD_AGENT_ADAPTERS', 'fake');
    vi.stubEnv('PAYTO_ADDRESS', 'not-an-address');
    const { getAdapters } = await import('../src/adapters');
    await expect(getAdapters()).rejects.toThrow('PAYTO_ADDRESS');
  });
});
