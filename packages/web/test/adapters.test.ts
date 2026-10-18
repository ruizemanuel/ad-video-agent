import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createAdapters } from '../src/adapters';
import { FileBlob } from '../src/adapters/fake/blob';
import { FileStore } from '../src/adapters/fake/store';
import { VercelBlob } from '../src/adapters/real/blob';
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
  it('gives a file-backed store and blob over FAKE_DIR', async () => {
    const dir = await tempDir();
    const { store, blob } = await createAdapters(parseEnv({ ...common, AD_AGENT_ADAPTERS: 'fake', FAKE_DIR: dir }));
    expect(store).toBeInstanceOf(FileStore);
    expect(blob).toBeInstanceOf(FileBlob);
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
  it('gives the Postgres store and the Vercel Blob adapter, built from the settings and not yet used', async () => {
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
    const { store, blob } = await createAdapters(settings);
    expect(store).toBeInstanceOf(DrizzleStore);
    expect(blob).toBeInstanceOf(VercelBlob);
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

  it('rejects, instead of throwing, when the environment is wrong', async () => {
    vi.stubEnv('AD_AGENT_ADAPTERS', 'fake');
    vi.stubEnv('PAYTO_ADDRESS', 'not-an-address');
    const { getAdapters } = await import('../src/adapters');
    await expect(getAdapters()).rejects.toThrow('PAYTO_ADDRESS');
  });
});
