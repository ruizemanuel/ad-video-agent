// The app and the browser of the page's tests. `startApp` serves this package with `next dev` on the fake adapters, the
// fake facilitator and the fake page fetcher (AD_AGENT_ADAPTERS=fake, a FAKE_DIR of its own): no site is fetched, no
// model asked, no payment sent. `launchPage` opens a page in Chrome Headless Shell, the VM's, with the stub wallet in it
// and a network that ends at this machine: the app's own requests go through; Celo's node and the fake blob store are
// answered from here; anything else is cut off, and listed.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { connect, createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ensureBrowser } from '@remotion/renderer';
import puppeteer, { type Browser, type HTTPRequest, type Page } from 'puppeteer-core';
import { inPageWallet, stubWallet, walletInfo, type RpcAnswer, type StubWallet, type WalletOptions } from './wallet';

const WEB_DIR = fileURLToPath(new URL('../../..', import.meta.url));
const NEXT_BIN = createRequire(import.meta.url).resolve('next/dist/bin/next');
/** The first request compiles the page it asks for, and the first start of a checkout builds Next's caches. */
const START_TIMEOUT_MS = 240_000;
const STOP_TIMEOUT_MS = 30_000;

export type App = {
  /** Where the app answers, with no trailing slash: also its PUBLIC_BASE_URL. */
  url: string;
  /** The folder its fake store and fake blob store keep their files in (see seed.ts). */
  fakeDir: string;
  /** Stops the app and every process it started, and deletes its folder. */
  stop(): Promise<void>;
};

// What the app gets of the test's environment: only what a program needs to run at all. Nothing else of it (a key set in
// the shell, VERCEL_ENV...) reaches the app; its settings are the ones below.
const PASSED = new Set([
  'PATH',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'LOCALAPPDATA',
  'APPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
]);

/** The settings of the app in tests: a development price, the promo off, and made-up values for what env() requires. */
const TEST_SETTINGS: Record<string, string> = {
  PAYTO_ADDRESS: `0x${'d'.repeat(40)}`,
  PRICE_ATOMIC: '50000',
  PROMO_SLOTS: '0',
  LINK_SIGNING_SECRET: 's'.repeat(64),
  CRON_SECRET: 'c'.repeat(64),
  // Not required on the fake adapters, but a paid order's flow needs them to queue its VM's tasks instead of refunding it.
  GITHUB_REPO: 'ruizemanuel/ad-video-agent',
  VM_CODE_REF: '0'.repeat(40),
};

/**
 * Next loads the `.env*` files of the folder it serves, and the repository keeps real keys in such files: the app does
 * not start if this package has one. The names are listed, never opened.
 */
function refuseEnvFiles(): void {
  const found = readdirSync(WEB_DIR).filter((name) => name.startsWith('.env'));
  if (found.length > 0) throw new Error(`packages/web holds ${found.join(', ')}: the test app would load it. Move it away to run the browser tests.`);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  return port;
}

/** Whether something accepts connections on the port. */
const listening = (port: number): Promise<boolean> =>
  new Promise((done) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Ends the process and every process it started (Next runs the server in a child of its own). */
async function killTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const exited = new Promise((done) => child.once('exit', done));
  if (process.platform === 'win32') await promisify(execFile)('taskkill', ['/pid', String(child.pid), '/T', '/F']).catch(() => undefined);
  else process.kill(-child.pid, 'SIGKILL');
  await exited;
}

/**
 * Starts the app with `next dev` on a free port, on the fake adapters, and resolves once /terms answers 200. `settings`
 * add to or replace the test settings (PROMO_SLOTS, TEAM_WALLETS...); the fake adapters, the FAKE_DIR and the
 * PUBLIC_BASE_URL are always the app's own. One app at a time: Next refuses a second `next dev` in this folder.
 */
export async function startApp(settings: Record<string, string> = {}): Promise<App> {
  refuseEnvFiles();
  const fakeDir = await mkdtemp(join(tmpdir(), 'web-browser-'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'development' };
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && PASSED.has(name.toUpperCase())) env[name] = value;
  Object.assign(env, TEST_SETTINGS, settings, { AD_AGENT_ADAPTERS: 'fake', FAKE_DIR: fakeDir, PUBLIC_BASE_URL: url, NEXT_TELEMETRY_DISABLED: '1' });

  const child = spawn(process.execPath, [NEXT_BIN, 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: WEB_DIR,
    env,
    // Its own process group, so the whole tree can be ended at once (Windows has taskkill /T instead).
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  let output = '';
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-20_000);
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);

  const stop = async (): Promise<void> => {
    await killTree(child);
    for (const deadline = Date.now() + STOP_TIMEOUT_MS; await listening(port); await sleep(200)) {
      if (Date.now() > deadline) throw new Error(`The app still listens on ${port} after it was stopped.`);
    }
    await rm(fakeDir, { recursive: true, force: true, maxRetries: 5 });
  };

  try {
    for (const deadline = Date.now() + START_TIMEOUT_MS; ; await sleep(500)) {
      if (child.exitCode !== null) throw new Error(`next dev exited with ${child.exitCode} before it served /terms.`);
      if (Date.now() > deadline) throw new Error(`next dev did not serve /terms within ${START_TIMEOUT_MS / 1000} s.`);
      const status = await fetch(`${url}/terms`, { signal: AbortSignal.timeout(Math.max(deadline - Date.now(), 1)) }).then(
        async (res) => {
          await res.body?.cancel();
          return res.status;
        },
        () => null,
      );
      if (status === 200) break;
    }
  } catch (error) {
    await stop().catch(() => undefined);
    throw new Error(`${(error as Error).message}\n${output}`);
  }
  return { url, fakeDir, stop };
}

// ---------------------------------------------------------------- the browser

/** The function the wallet in the page reaches the test's process through. */
const WALLET_BINDING = '__stubWalletRequest';
/** Celo's public node, which the page reads the chain from. */
const CELO_NODE = 'https://forno.celo.org';
/** Where the fake blob store's presigned links point (see FileBlob.presignGet): no browser can reach it. */
const FAKE_BLOB_HOST = 'fake-blob.invalid';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, range' };
const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.wav': 'audio/wav',
};

/**
 * An answer given in the app's place: a status, a JSON or text body, and headers; or none at all (`unanswered`), as a
 * connection that drops before the answer comes back: the page's request fails.
 */
export type AppAnswer = { status: number; contentType: string; body: string; headers?: Record<string, string> } | { unanswered: true };

export type LaunchedPage = {
  browser: Browser;
  page: Page;
  wallet: StubWallet;
  /** Every request the page made that was cut off, by URL, in order. */
  blockedRequests(): string[];
  /**
   * From now on, the page's requests to the app that `answer` takes (it gives null for the rest) are answered by it in
   * the app's place, and never reach the app: for an answer the app cannot be brought to give on cue, such as the loser
   * of a race. The rest go through as before.
   */
  answerForApp(answer: (request: HTTPRequest) => Promise<AppAnswer | null> | AppAnswer | null): void;
};

/** Answers a JSON-RPC POST to Celo's node with the wallet's reads, a batch included. */
async function answerNode(request: HTTPRequest, read: (method: string, params: unknown) => RpcAnswer): Promise<void> {
  if (request.method() === 'OPTIONS') return request.respond({ status: 204, headers: CORS });
  const body = JSON.parse((await request.fetchPostData()) ?? 'null') as unknown;
  const answerOne = (call: unknown) => {
    const { id = null, method = '', params = [] } = (call ?? {}) as { id?: unknown; method?: string; params?: unknown };
    const answer = read(method, params);
    return { jsonrpc: '2.0', id, ...('error' in answer ? { error: answer.error } : { result: answer.result }) };
  };
  const reply = Array.isArray(body) ? body.map(answerOne) : answerOne(body);
  return request.respond({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(reply) });
}

/** Serves a presigned read of the fake blob store from the file under `<fakeDir>/blob`, a byte range when asked for one. */
async function serveBlob(request: HTTPRequest, fakeDir: string): Promise<void> {
  if (request.method() === 'OPTIONS') return request.respond({ status: 204, headers: CORS });
  const segments = new URL(request.url()).pathname.slice(1).split('/').map(decodeURIComponent);
  if (request.method() !== 'GET' || segments.some((segment) => segment === '' || segment === '.' || segment === '..' || /[\\/:]/.test(segment))) {
    return request.respond({ status: 400, headers: CORS, contentType: 'text/plain', body: 'Not a read of a blob.' });
  }
  const file = join(fakeDir, 'blob', ...segments);
  let body: Buffer;
  try {
    body = await readFile(file);
  } catch {
    return request.respond({ status: 404, headers: CORS, contentType: 'text/plain', body: 'No such blob.' });
  }
  const headers = { ...CORS, 'accept-ranges': 'bytes' };
  const contentType = TYPES[extname(file)] ?? 'application/octet-stream';
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range ?? '');
  if (range === null) return request.respond({ status: 200, headers, contentType, body });
  const start = Number(range[1]);
  const end = Math.min(range[2] === '' ? body.length - 1 : Number(range[2]), body.length - 1);
  if (start > end) return request.respond({ status: 416, headers: { ...headers, 'content-range': `bytes */${body.length}` }, contentType, body: '' });
  return request.respond({ status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${body.length}` }, contentType, body: body.subarray(start, end + 1) });
}

/**
 * Opens a page of `app` in Chrome Headless Shell (downloaded on the first run, as the VM's is), 1280 px wide, with a
 * stub wallet (see wallet.ts) put in it before any script of the page runs. The page reaches nothing past this machine:
 * - the app's own address goes through (save what the test answers itself, see `answerForApp`);
 * - Celo's node (https://forno.celo.org) is answered with the wallet's own reads;
 * - the fake blob store's links (https://fake-blob.invalid/...), where the app's download links redirect, are answered
 *   with the file under `<fakeDir>/blob`;
 * - anything else is cut off and listed in `blockedRequests()`. Chrome also resolves no name, so what the interception
 *   does not see (a preconnect, a DNS prefetch) cannot leave either.
 */
export async function launchPage(app: Pick<App, 'url' | 'fakeDir'>, options: WalletOptions = {}): Promise<LaunchedPage> {
  const status = await ensureBrowser();
  if (!('path' in status)) throw new Error(`chrome-headless-shell is not available (${status.type}).`);
  const appUrl = new URL(app.url);
  const browser = await puppeteer.launch({
    executablePath: status.path,
    headless: 'shell',
    defaultViewport: { width: 1280, height: 900 },
    args: [`--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${appUrl.hostname}`],
  });
  try {
    const page = await browser.newPage();
    const { wallet, answer, read } = stubWallet(options);
    await page.exposeFunction(WALLET_BINDING, answer);
    await page.evaluateOnNewDocument(inPageWallet, WALLET_BINDING, walletInfo());

    const blocked: string[] = [];
    let inAppsPlace: Parameters<LaunchedPage['answerForApp']>[0] | undefined;
    const route = async (request: HTTPRequest): Promise<void> => {
      const url = new URL(request.url());
      if (url.origin === appUrl.origin && inAppsPlace !== undefined) {
        const answer = await inAppsPlace(request);
        if (answer !== null) return 'unanswered' in answer ? request.abort('failed') : request.respond(answer);
      }
      if (url.origin === appUrl.origin || url.protocol === 'data:' || url.protocol === 'blob:') return request.continue();
      if (url.origin === CELO_NODE) return answerNode(request, read);
      if (url.hostname === FAKE_BLOB_HOST) return serveBlob(request, app.fakeDir);
      blocked.push(request.url());
      return request.abort('blockedbyclient');
    };
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      route(request).catch(async (error: unknown) => {
        // Left unanswered, the request would hang the page: it fails instead, and the test's output says why.
        console.error('[launchPage] a request could not be answered:', request.url(), error);
        await request.abort('failed').catch(() => undefined);
      });
    });
    return {
      browser,
      page,
      wallet,
      blockedRequests: () => [...blocked],
      answerForApp: (answer) => {
        inAppsPlace = answer;
      },
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}
