import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const TOKEN = 'tok_main-test-0123456789';
const ROOT = join(import.meta.dirname, '..');

type Seen = { method: string; url: string; authorization: string | undefined; body: string };
let server: Server | undefined;
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

/** A service that answers each call with `answer(call, n)`. */
async function serve(answer: (call: Seen, n: number) => { status: number; body?: unknown }) {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const call: Seen = { method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() };
      seen.push(call);
      const { status, body } = answer(call, seen.length - 1);
      res.writeHead(status, { 'content-type': 'application/json' }).end(body === undefined ? undefined : JSON.stringify(body));
    });
  });
  await new Promise<void>((ok) => server?.listen(0, '127.0.0.1', ok));
  return { base: `http://127.0.0.1:${(server?.address() as AddressInfo).port}`, seen };
}

/** Runs `node --import tsx src/main.ts` the way the VM does, from the package folder, and waits for it to end. */
function runMain(env: Record<string, string>) {
  return new Promise<{ code: number | null; output: string }>((done) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { cwd: ROOT, env: { ...process.env, VM_TOKEN: '', API_BASE: '', ...env } });
    let output = '';
    child.stdout.on('data', (c: Buffer) => (output += c));
    child.stderr.on('data', (c: Buffer) => (output += c));
    child.on('close', (code) => done({ code, output }));
  });
}

describe('main', () => {
  it('works from API_BASE with the token as the permit, answers shutdown and ends, printing nothing of the token', async () => {
    const { base, seen } = await serve((call) =>
      call.method === 'GET' ? { status: 200, body: { id: 'a1', kind: 'shutdown', input: {}, urls: {} } } : { status: 200, body: { ok: true } },
    );

    const { code, output } = await runMain({ API_BASE: `${base}/`, VM_TOKEN: TOKEN });

    expect(code).toBe(0);
    expect(seen.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /api/vm/tasks/next', 'POST /api/vm/tasks/a1/result']);
    for (const call of seen) expect(call.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(seen[1]?.body ?? '')).toEqual({ ok: true });
    expect(output).not.toContain(TOKEN);
  }, 30_000);

  it('has a handler for each task the service gives out: capture, keyframes and render', async () => {
    // Bad input to each, so that none starts a browser: the answer shows which handler took it.
    const tasks = [
      { id: 'a1', kind: 'capture', input: { url: 'file:///etc/passwd' }, urls: {} },
      { id: 'a2', kind: 'keyframes', input: {}, urls: {} },
      { id: 'a3', kind: 'render', input: {}, urls: {} },
      { id: 'a4', kind: 'shutdown', input: {}, urls: {} },
    ];
    const { base, seen } = await serve((call, n) => (call.method === 'GET' ? { status: 200, body: tasks[Math.floor(n / 2)] } : { status: 200, body: { ok: true } }));

    const { code } = await runMain({ API_BASE: base, VM_TOKEN: TOKEN });

    expect(code).toBe(0);
    const results = Object.fromEntries(seen.filter((c) => c.method === 'POST').map((c) => [c.url.split('/')[4], JSON.parse(c.body) as { ok: boolean; message?: string }]));
    expect(results.a1?.message).toMatch(/web address/);
    expect(results.a2).toMatchObject({ ok: false, message: expect.stringMatching(/keyframes task has no usable edit list/) });
    expect(results.a3).toMatchObject({ ok: false, message: expect.stringMatching(/render task has no usable edit list/) });
  }, 30_000);

  it('ends with an error, and says nothing of the token, when the service refuses the permit', async () => {
    const { base, seen } = await serve(() => ({ status: 401, body: { error: 'unauthorized' } }));

    const { code, output } = await runMain({ API_BASE: base, VM_TOKEN: TOKEN });

    expect(code).not.toBe(0);
    expect(seen).toHaveLength(1);
    expect(output).toContain('401');
    expect(output).not.toContain(TOKEN);
  }, 30_000);

  it.each([
    ['API_BASE', { VM_TOKEN: TOKEN, API_BASE: '' }],
    ['VM_TOKEN', { API_BASE: 'https://api.example', VM_TOKEN: '' }],
  ])('does not start without %s', async (name, env) => {
    const { code, output } = await runMain(env);

    expect(code).not.toBe(0);
    expect(output).toContain(name);
    expect(output).not.toContain(TOKEN);
  }, 30_000);
});
