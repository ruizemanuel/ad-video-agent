import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildBootstrap } from '../src/vm/bootstrap';

const TOKEN = `tok_${'a'.repeat(43)}`;
const INPUT = { apiBase: 'https://x.vercel.app', vmToken: TOKEN, repo: 'ruizemanuel/r', ref: 'abc123' };
const script = (over: Partial<typeof INPUT> = {}) => buildBootstrap({ ...INPUT, ...over });

describe('buildBootstrap', () => {
  it('fits in 4 KiB, parses with bash -n and carries only the order token', () => {
    const s = script();
    expect(Buffer.byteLength(s)).toBeLessThanOrEqual(4096);
    expect(spawnSync('bash', ['-n'], { input: s }).status).toBe(0);
    expect(s).not.toMatch(/PRIVATE_KEY|BLOB_READ_WRITE|X402_API_KEY|GEMINI|CRON_SECRET|LINK_SIGNING/);
    expect(s.split(TOKEN).length - 1).toBe(1);
  });

  it('blocks the metadata server and private ranges for the worker user and never runs it as root', () => {
    const s = script();
    expect(s).toContain('-d 169.254.169.254 -p tcp --dport 80 -j REJECT');
    for (const range of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']) expect(s).toContain(range);
    expect(s).toMatch(/runuser -u worker/);
    // Every rule is for the worker alone: root keeps the network it needs to install things.
    for (const rule of s.split('\n').filter((line) => /iptables .*REJECT/.test(line))) expect(rule).toContain('--uid-owner worker');
  });

  it('tries the metadata server as the worker once the rules are in, and stops if it answers', () => {
    expect(script()).toMatch(/!\s*R timeout \d+ curl [^\n;]*http:\/\/169\.254\.169\.254/);
  });

  // The order of the steps is what keeps the code of other people's sites away from root's network and files.
  it('runs the fetch, the install and the worker through R, the runuser wrapper, and only after the firewall step', () => {
    const s = script();
    const at = (step: string) => s.indexOf(`\ns ${step} `);
    expect(at('fw')).toBeGreaterThan(at('node'));
    for (const step of ['fetch', 'install', 'run']) {
      expect(s, step).toMatch(new RegExp(`^s ${step} R `, 'm'));
      expect(at(step), step).toBeGreaterThan(at('fw'));
    }
    // Installing the system and Node is root's job, and comes before the worker exists.
    for (const step of ['apt', 'node']) {
      expect(s, step).not.toMatch(new RegExp(`^s ${step} R `, 'm'));
      expect(at(step), step).toBeLessThan(at('fw'));
    }
    // R is the one place that becomes another user.
    expect(s.match(/runuser/g)).toHaveLength(1);
    expect(s).toMatch(/^R\(\)\{ runuser -u worker -- /m);
  });

  it('gives the worker a clean environment: nothing of root, and the token only on the run line', () => {
    const s = script();
    expect(s).toMatch(/^R\(\)\{ runuser -u worker -- env -i HOME=\$W PATH=\S+ COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "\$@";\}$/m);
    for (const name of ['VM_TOKEN', 'API_BASE']) {
      const lines = s.split('\n').filter((line) => line.includes(name));
      expect(lines, name).toHaveLength(1);
      expect(lines[0], name).toMatch(/^s run R timeout 3300 env /);
    }
  });

  // Root runs the script and keeps running commands after the worker has run code: none may come from a place the
  // worker can write to. The Node tarball's files belong to uid 1001, which the worker may well be.
  it("extracts Node without keeping the archive's owner, so the worker cannot end up owning root's Node", () => {
    const line = script()
      .split('\n')
      .find((l) => l.includes('tar -xJ'));
    expect(line).toContain('--no-same-owner');
    expect(line).toContain('-C /opt/node');
  });

  it("keeps Node's folder out of the PATH of root, and puts it only where it is handed on", () => {
    const lines = script().split('\n');
    const exported = lines.find((l) => /^export .*\bPATH=/.test(l)) ?? '';
    expect(exported).toMatch(/PATH=\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin(\s|$)/);
    expect(exported).not.toContain('/opt/node');
    // Root's corepack needs node once, for itself; the worker gets it in its own PATH.
    const mentions = lines.filter((l) => l.includes('/opt/node/bin'));
    expect(mentions).toHaveLength(2);
    expect(mentions.find((l) => l.startsWith('s node '))).toContain('PATH=/opt/node/bin:$PATH corepack enable');
    expect(mentions.find((l) => l.startsWith('R(){'))).toBeDefined();
  });

  it('fetches the code at the exact ref from codeload and installs only the worker', () => {
    const s = script();
    expect(s).toContain('https://codeload.github.com/ruizemanuel/r/tar.gz/abc123');
    expect(s).toContain('--frozen-lockfile --filter @app/vm...');
    expect(s).toContain('node --import tsx packages/vm/src/main.ts');
  });

  it('installs Node v24.22.0 from the official tarball', () => {
    expect(script()).toContain('https://nodejs.org/dist/v24.22.0/node-v24.22.0-linux-x64.tar.xz');
  });

  it('runs the worker with the API address and the token, for no longer than 55 minutes', () => {
    expect(script()).toContain(`timeout 3300 env API_BASE=https://x.vercel.app VM_TOKEN=$K node`);
  });

  it('gives every command that can wait on the network a timeout', () => {
    const s = script();
    for (const command of ['curl ', 'apt-get ', 'pnpm install', 'node --import']) {
      const at = [...s.matchAll(new RegExp(command.replace(/[-.]/g, '\\$&'), 'g'))].map((match) => match.index);
      expect(at.length, command).toBeGreaterThan(0);
      for (const i of at) {
        // The words of the same command, back to whatever separates it from the one before.
        const before = s.slice(0, i);
        const start = Math.max(...['&&', '|', ';', '"', "'", '\n'].map((separator) => before.lastIndexOf(separator)));
        expect(before.slice(start + 1), `${command} at ${i}`).toMatch(/timeout \d+ /);
      }
    }
  });

  it('ends with one JSON line that names the step that failed', () => {
    const last = script().trimEnd().split('\n').at(-1) ?? '';
    expect(last).toMatch(/^echo "\{\\"failed\\":/);
  });

  // `s` is the function that keeps the failure; it is run here as the script has it.
  describe('the step runner', () => {
    const runSteps = (token: string, lines: string[]): { failed: string; msg: string } => {
      const fn = /^s\(\)\{\n[\s\S]*?\n\}$/m.exec(script({ vmToken: token }))?.[0] ?? '';
      expect(fn).not.toBe('');
      const dir = mkdtempSync(join(tmpdir(), 'bootstrap-'));
      try {
        // Relative paths, so it is the same on Windows and on Linux. Each step prints its line and fails.
        const driver = [
          `L=./log;T=./t;K='${token}';F=;M=`,
          ': >$T',
          fn,
          ...lines.map((_line, i) => `s step${i} bash -c 'echo "$LINE${i}"; exit 3'`),
          'echo "$F|$M"',
        ].join('\n');
        const env = { ...process.env, ...Object.fromEntries(lines.map((line, i) => [`LINE${i}`, line])) };
        const out = spawnSync('bash', [], { input: driver, cwd: dir, env, encoding: 'utf8' });
        const [failed = '', ...msg] = out.stdout.trim().split('|');
        return { failed, msg: msg.join('|') };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    it('keeps the name of the first step that failed and its last line, without anything JSON would not take', () => {
      const { failed, msg } = runSteps(`Q9-${'k'.repeat(40)}`, ['E: could not "get" a lock\\ (rc=100)', 'a later failure']);
      expect(failed).toBe('step0');
      expect(msg).toBe('E: could not get a lock rc=100');
    });

    // The message is cut at 120 characters: a token that straddles the cut must not leave a piece of itself behind.
    it.each([
      ['before the cut', 20],
      ['across the cut', 100],
      ['ending right at the cut', 120 - 43],
      ['after the cut', 150],
    ])('takes the token out of the message when it is %s', (_label, before) => {
      const token = `Q9-${'k'.repeat(40)}`;
      const { msg } = runSteps(token, [`${'.'.repeat(before)}${token}${'.'.repeat(60)}`]);
      expect(msg).not.toContain('Q9-');
      expect(msg).not.toContain('kkkk');
      expect(msg.length).toBeLessThanOrEqual(120);
    });
  });

  it('strips trailing slashes from the API address', () => {
    expect(script({ apiBase: 'https://x.vercel.app/' })).toContain('API_BASE=https://x.vercel.app ');
  });

  it('takes a repo whose name starts with a dot', () => {
    expect(script({ repo: 'ruizemanuel/.github' })).toContain('https://codeload.github.com/ruizemanuel/.github/tar.gz/abc123');
  });

  it('refuses to build a script buy would not take: over 4 KiB', () => {
    expect(() => script({ apiBase: `https://x.vercel.app/${'a'.repeat(4000)}` })).toThrow(/4096/);
  });

  // The values land in a script that root runs: nothing that is not a plain name may get through.
  it.each([
    ['an API address that is not https', { apiBase: 'http://x.vercel.app' }],
    ['an API address with a quote', { apiBase: "https://x.vercel.app';id;'" }],
    ['an API address with a space', { apiBase: 'https://x.vercel.app a' }],
    ['an API address with a query', { apiBase: 'https://x.vercel.app?a=b' }],
    ['a token with a quote', { vmToken: "a';id;'" }],
    ['a token with a dollar sign', { vmToken: 'a$(id)' }],
    ['an empty token', { vmToken: '' }],
    ['a repo that is not owner/name', { repo: 'ruizemanuel' }],
    ['a repo with a semicolon', { repo: 'ruizemanuel/r;id' }],
    ['a repo that climbs out of its folder', { repo: '../../etc' }],
    ['a repo named ..', { repo: 'ruizemanuel/..' }],
    ['a ref with a semicolon', { ref: 'abc;id' }],
    ['a ref with a space', { ref: 'abc 123' }],
    ['an empty ref', { ref: '' }],
  ])('refuses %s', (_label, over) => {
    expect(() => script(over)).toThrow(RangeError);
  });
});
