import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../src/env';

const ADDRESS = `0x${'1'.repeat(40)}`;
const PRIVATE_KEY = `0x${'2'.repeat(64)}`;

// What the tests need to run on the doubles.
const base = {
  AD_AGENT_ADAPTERS: 'fake',
  PAYTO_ADDRESS: ADDRESS,
  LINK_SIGNING_SECRET: 'a'.repeat(32),
  CRON_SECRET: 'b'.repeat(32),
};

// What the deployed service needs: the real adapters, which are the default.
const real = {
  PAYTO_ADDRESS: ADDRESS,
  LINK_SIGNING_SECRET: 'a'.repeat(32),
  CRON_SECRET: 'b'.repeat(32),
  DATABASE_URL: 'postgres://user:pass@db.example.com/ads',
  BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_abc_def',
  X402_API_KEY: 'x402_abc',
  SPEND_WALLET_PRIVATE_KEY: PRIVATE_KEY,
  REFUND_WALLET_PRIVATE_KEY: `0x${'3'.repeat(64)}`,
  GEMINI_API_KEY: 'gemini-key',
  PUBLIC_BASE_URL: 'https://ad-video-agent.vercel.app',
  GITHUB_REPO: 'ruizemanuel/ad-video-agent',
};

describe('parseEnv', () => {
  it('fills in the defaults of the table', () => {
    expect(parseEnv(real)).toMatchObject({
      AD_AGENT_ADAPTERS: 'real',
      PRICE_ATOMIC: 5_000_000n,
      SPEND_CAP_PER_ORDER_USD: 2.5,
      BUY_DAILY_CAP_USD: 2,
      REFUND_DAILY_CAP_USD: 10,
      CELO_RPC_URL: 'https://forno.celo.org',
      DEV_MODE: false,
    });
    expect(parseEnv(real).ERC8021_CODE).toBeUndefined();
  });

  it('reads the values it is given', () => {
    const parsed = parseEnv({
      ...real,
      PRICE_ATOMIC: '50000',
      SPEND_CAP_PER_ORDER_USD: '1.25',
      BUY_DAILY_CAP_USD: '3',
      REFUND_DAILY_CAP_USD: '4',
      CELO_RPC_URL: 'https://rpc.example.com',
      ERC8021_CODE: 'celo_event',
      VM_CODE_REF: 'abc123',
      VERCEL_GIT_COMMIT_SHA: 'def456',
    });
    expect(parsed).toMatchObject({
      PRICE_ATOMIC: 50_000n,
      SPEND_CAP_PER_ORDER_USD: 1.25,
      BUY_DAILY_CAP_USD: 3,
      REFUND_DAILY_CAP_USD: 4,
      CELO_RPC_URL: 'https://rpc.example.com',
      ERC8021_CODE: 'celo_event',
      VM_CODE_REF: 'abc123',
      VERCEL_GIT_COMMIT_SHA: 'def456',
    });
  });

  it('counts an empty value as a missing one, like a copied .env.example', () => {
    const parsed = parseEnv({ ...real, ERC8021_CODE: '', PRICE_ATOMIC: '', CELO_RPC_URL: '', DEV_MODE: '', FORCE_FAIL_AT: '' });
    expect(parsed).toMatchObject({ PRICE_ATOMIC: 5_000_000n, CELO_RPC_URL: 'https://forno.celo.org', DEV_MODE: false });
    expect(parsed.ERC8021_CODE).toBeUndefined();
    expect(parsed.FORCE_FAIL_AT).toBeUndefined();
  });

  it.each(Object.keys(real))('needs %s', (name) => {
    const { [name]: _removed, ...without } = real as Record<string, string>;
    expect(() => parseEnv(without)).toThrow(name);
  });

  it('needs none of the service credentials on the fake adapters', () => {
    const parsed = parseEnv(base);
    expect(parsed.AD_AGENT_ADAPTERS).toBe('fake');
    expect(parsed.DATABASE_URL).toBeUndefined();
    expect(parsed.SPEND_WALLET_PRIVATE_KEY).toBeUndefined();
    expect(parsed.REFUND_WALLET_PRIVATE_KEY).toBeUndefined();
  });

  it('reads the folder the fake adapters keep their files in, and counts an empty one as missing', () => {
    expect(parseEnv({ ...base, FAKE_DIR: '/tmp/fake' }).FAKE_DIR).toBe('/tmp/fake');
    expect(parseEnv({ ...base, FAKE_DIR: '' }).FAKE_DIR).toBeUndefined();
    expect(parseEnv(base).FAKE_DIR).toBeUndefined();
  });

  it('refuses fake adapters in production', () => {
    expect(() => parseEnv({ ...base, VERCEL_ENV: 'production', AD_AGENT_ADAPTERS: 'fake' })).toThrow('AD_AGENT_ADAPTERS');
  });

  it('allows fake adapters in preview and development', () => {
    expect(parseEnv({ ...base, VERCEL_ENV: 'preview' }).AD_AGENT_ADAPTERS).toBe('fake');
    expect(parseEnv({ ...base, VERCEL_ENV: 'development' }).AD_AGENT_ADAPTERS).toBe('fake');
  });

  it('refuses a database that lives in memory in production', () => {
    expect(() => parseEnv({ ...real, VERCEL_ENV: 'production', DATABASE_URL: 'memory' })).toThrow('DATABASE_URL');
    expect(() => parseEnv({ ...real, VERCEL_ENV: 'production', DATABASE_URL: 'pglite:./data' })).toThrow('DATABASE_URL');
    expect(parseEnv({ ...real, VERCEL_ENV: 'production' }).DATABASE_URL).toBe(real.DATABASE_URL);
    expect(parseEnv({ ...real, DATABASE_URL: 'memory' }).DATABASE_URL).toBe('memory');
  });

  it('refuses DEV_MODE with a real price and FORCE_FAIL_AT without DEV_MODE', () => {
    expect(() => parseEnv({ ...real, PRICE_ATOMIC: '5000000', DEV_MODE: '1' })).toThrow('DEV_MODE');
    expect(() => parseEnv({ ...real, DEV_MODE: '1' })).toThrow('DEV_MODE');
    expect(() => parseEnv({ ...real, PRICE_ATOMIC: '1000000', DEV_MODE: '1' })).toThrow('DEV_MODE');
    expect(() => parseEnv({ ...real, FORCE_FAIL_AT: 'before-vm' })).toThrow('FORCE_FAIL_AT');
    expect(() => parseEnv({ ...real, DEV_MODE: '0', FORCE_FAIL_AT: 'before-vm' })).toThrow('FORCE_FAIL_AT');
  });

  it('allows DEV_MODE at the development price, with a forced failure', () => {
    const parsed = parseEnv({ ...real, PRICE_ATOMIC: '50000', DEV_MODE: '1', FORCE_FAIL_AT: 'before-vm' });
    expect(parsed).toMatchObject({ DEV_MODE: true, FORCE_FAIL_AT: 'before-vm', PRICE_ATOMIC: 50_000n });
    expect(parseEnv({ ...real, PRICE_ATOMIC: '999999', DEV_MODE: '1' }).DEV_MODE).toBe(true);
  });

  it('refuses a forced failure it does not know, so a typo cannot go unnoticed', () => {
    expect(() => parseEnv({ ...real, PRICE_ATOMIC: '50000', DEV_MODE: '1', FORCE_FAIL_AT: 'before-vn' })).toThrow('FORCE_FAIL_AT');
  });

  it.each([
    ['PRICE_ATOMIC', '5 USDT'],
    ['PRICE_ATOMIC', '0'],
    ['PRICE_ATOMIC', '-5'],
    ['PRICE_ATOMIC', '5.5'],
    ['SPEND_CAP_PER_ORDER_USD', '0'],
    ['SPEND_CAP_PER_ORDER_USD', 'free'],
    ['BUY_DAILY_CAP_USD', '-1'],
    ['REFUND_DAILY_CAP_USD', 'NaN'],
    ['PAYTO_ADDRESS', '0x1234'],
    ['SPEND_WALLET_PRIVATE_KEY', 'not-a-key'],
    ['REFUND_WALLET_PRIVATE_KEY', `0x${'2'.repeat(63)}`],
    ['PUBLIC_BASE_URL', 'ad-video-agent.vercel.app'],
    ['GITHUB_REPO', 'ruizemanuel'],
    ['LINK_SIGNING_SECRET', 'short'],
    ['CRON_SECRET', 'short'],
    ['CELO_RPC_URL', 'forno'],
    ['AD_AGENT_ADAPTERS', 'both'],
    ['DEV_MODE', 'yes'],
  ])('rejects %s = %s', (name, value) => {
    expect(() => parseEnv({ ...real, [name]: value })).toThrow(name);
  });

  it('names the variable that is wrong and never prints what it held', () => {
    const secret = 'sk-this-must-not-leak-into-a-log';
    let message = '';
    try {
      parseEnv({ ...real, SPEND_WALLET_PRIVATE_KEY: secret });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('SPEND_WALLET_PRIVATE_KEY');
    expect(message).not.toContain(secret);
  });
});

describe('env', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('checks process.env once and keeps the result', async () => {
    for (const [name, value] of Object.entries(base)) vi.stubEnv(name, value);
    const { env } = await import('../src/env');
    const first = env();
    vi.stubEnv('PRICE_ATOMIC', '1');
    expect(env()).toBe(first);
    expect(first.PRICE_ATOMIC).toBe(5_000_000n);
  });
});
