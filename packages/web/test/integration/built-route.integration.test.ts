// POST /v1/videos as the built service answers it: `next build`, then `next start`. The unit tests call the route's
// handler themselves; only here does a request go through Next's own route module, which gives the handler its own
// NextRequest wrapped in a Proxy. A route that made a new request from that one answered 500 to every body in
// production while its unit tests passed. The server runs on the fake adapters, and every body sent here is refused
// before the pre-check fetches a page or asks a model: nothing leaves this machine.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const WEB_DIR = fileURLToPath(new URL('../..', import.meta.url));
const NEXT_BIN = createRequire(import.meta.url).resolve('next/dist/bin/next');
/** `next build` compiles the app and its workflow and type-checks it: well under a minute on a laptop. */
const BUILD_TIMEOUT_MS = 300_000;

/** The runner's environment, with the NODE_ENV Next runs with in production: vitest sets it to `test`. */
function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' };
  for (const name of Object.keys(env)) if (name.startsWith('VITEST')) delete env[name];
  return env;
}

/** Runs `next <args>` in the web package and resolves with its output once it exits with 0. */
function next(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NEXT_BIN, ...args], { cwd: WEB_DIR, env });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(output) : reject(new Error(`next ${args.join(' ')} exited with ${code}:\n${output}`))));
  });
}

/** Starts `next start` on a free port and resolves with the server and its address once it is ready. */
function start(env: NodeJS.ProcessEnv): Promise<{ server: ChildProcess; base: string; output: () => string }> {
  return new Promise((resolve, reject) => {
    const server = spawn(process.execPath, [NEXT_BIN, 'start', '--port', '0'], { cwd: WEB_DIR, env });
    let output = '';
    let ready = false;
    const read = (chunk: Buffer) => {
      output += chunk.toString();
      const local = /Local:\s+(http:\/\/\S+)/.exec(output);
      if (!ready && local?.[1] !== undefined && /Ready in/.test(output)) {
        ready = true;
        resolve({ server, base: local[1], output: () => output });
      }
    };
    server.stdout.on('data', read);
    server.stderr.on('data', read);
    server.on('error', reject);
    server.on('exit', (code) => {
      if (!ready) reject(new Error(`next start exited with ${code} before it was ready:\n${output}`));
    });
  });
}

let fakeDir: string;
let server: ChildProcess | undefined;
let base: string;
let serverOutput: () => string;

beforeAll(async () => {
  fakeDir = await mkdtemp(join(tmpdir(), 'built-route-'));
  const env = baseEnv();
  await next(['build'], env);
  // Settings that make no real adapter: no database, no wallet, no model. PUBLIC_BASE_URL is left out, so the links
  // are made from the request's own address.
  ({ server, base, output: serverOutput } = await start({
    ...env,
    AD_AGENT_ADAPTERS: 'fake',
    FAKE_DIR: fakeDir,
    PAYTO_ADDRESS: `0x${'d'.repeat(40)}`,
    PRICE_ATOMIC: '50000',
    LINK_SIGNING_SECRET: 's'.repeat(64),
    CRON_SECRET: 'c'.repeat(64),
  }));
}, BUILD_TIMEOUT_MS);

afterAll(async () => {
  if (server !== undefined && server.exitCode === null) {
    const exited = new Promise((resolve) => server?.once('exit', resolve));
    server.kill();
    await exited;
  }
  await rm(fakeDir, { recursive: true, force: true });
});

const post = (body: string) =>
  fetch(`${base}/v1/videos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

describe('POST /v1/videos, built and served by next start', () => {
  it('answers 400 for an invalid body', async () => {
    const res = await post(JSON.stringify({ url: 'nope' }));
    expect(res.status, serverOutput()).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_request', reason: expect.stringContaining('url') });
  });

  it('answers 400 for a body that is not JSON', async () => {
    const res = await post('{"url": ');
    expect(res.status, serverOutput()).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('answers 422 for the cloud metadata address, which the pre-check refuses before fetching it', async () => {
    const res = await post(JSON.stringify({ url: 'http://169.254.169.254/' }));
    expect(res.status, serverOutput()).toBe(422);
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
    expect(await res.json()).toMatchObject({ error: 'invalid_url' });
  });
});
