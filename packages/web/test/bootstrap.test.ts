import { spawnSync } from 'node:child_process';
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
    expect(script()).toMatch(/!\s*runuser -u worker -- timeout \d+ curl [^\n;]*http:\/\/169\.254\.169\.254/);
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
