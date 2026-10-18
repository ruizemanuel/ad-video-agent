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
