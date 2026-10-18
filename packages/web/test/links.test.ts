import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signFileLink, verifyFileLink } from '../src/links';

const SECRET = 'a'.repeat(32);
const BASE = 'https://ad-video-agent.vercel.app';
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const NOW_SECONDS = NOW / 1000;
const THIRTY_DAYS = 30 * 24 * 3600;

const link = { orderId: 'ord_abcdefghijklmnopqrstuvwx', name: 'hook-a-9x16.mp4', exp: NOW_SECONDS + THIRTY_DAYS };

// What the route does with the URL it receives.
const parse = (url: string) => {
  const parsed = new URL(url);
  const [, , , orderId = '', name = ''] = parsed.pathname.split('/');
  return {
    orderId: decodeURIComponent(orderId),
    name: decodeURIComponent(name),
    exp: Number(parsed.searchParams.get('exp')),
    sig: parsed.searchParams.get('sig') ?? '',
  };
};

describe('signFileLink', () => {
  it('builds /v1/files/<orderId>/<name>?exp=<unix>&sig=<hex> under the base', () => {
    const url = new URL(signFileLink(link, SECRET, BASE));
    expect(url.origin).toBe(BASE);
    expect(url.pathname).toBe(`/v1/files/${link.orderId}/${link.name}`);
    expect(url.searchParams.get('exp')).toBe(String(link.exp));
    expect(url.searchParams.get('sig')).toMatch(/^[0-9a-f]{64}$/);
    expect([...url.searchParams.keys()]).toEqual(['exp', 'sig']);
  });

  it('signs "<orderId>/<name>/<exp>" with HMAC-SHA256 and the secret', () => {
    const expected = createHmac('sha256', SECRET).update(`${link.orderId}/${link.name}/${link.exp}`).digest('hex');
    expect(parse(signFileLink(link, SECRET, BASE)).sig).toBe(expected);
  });

  it('does not double the slash when the base ends with one', () => {
    expect(signFileLink(link, SECRET, `${BASE}/`).startsWith(`${BASE}/v1/files/`)).toBe(true);
  });

  it('writes a name that needs it as a safe URL segment, and reads it back', () => {
    const odd = { ...link, name: 'my ad (final).mp4' };
    const url = signFileLink(odd, SECRET, BASE);
    expect(url).toContain('/my%20ad%20(final).mp4?');
    expect(verifyFileLink(parse(url), SECRET, NOW)).toBe('ok');
  });

  it.each([
    ['an order id with a slash', { ...link, orderId: 'ord_a/b' }],
    ['a name with a slash', { ...link, name: '../claims.md' }],
    ['an empty name', { ...link, name: '' }],
    ['a fractional expiry', { ...link, exp: NOW_SECONDS + 0.5 }],
    ['a negative expiry', { ...link, exp: -1 }],
    ['an expiry that is not a number', { ...link, exp: Number.NaN }],
  ])('refuses %s, which could not be told apart when verified', (_label, bad) => {
    expect(() => signFileLink(bad, SECRET, BASE)).toThrow();
  });
});

describe('verifyFileLink', () => {
  it('verifies its own signature', () => {
    expect(verifyFileLink(parse(signFileLink(link, SECRET, BASE)), SECRET, NOW)).toBe('ok');
  });

  it('rejects a tampered name', () => {
    expect(verifyFileLink({ ...parse(signFileLink(link, SECRET, BASE)), name: 'other.mp4' }, SECRET, NOW)).toBe('bad-signature');
  });

  it('rejects a tampered order id', () => {
    expect(verifyFileLink({ ...parse(signFileLink(link, SECRET, BASE)), orderId: 'ord_zzzzzzzzzzzzzzzzzzzzzzzz' }, SECRET, NOW)).toBe('bad-signature');
  });

  it('rejects an expiry that was pushed back', () => {
    const signed = parse(signFileLink(link, SECRET, BASE));
    expect(verifyFileLink({ ...signed, exp: signed.exp + THIRTY_DAYS }, SECRET, NOW)).toBe('bad-signature');
  });

  it('rejects a signature made with another secret', () => {
    expect(verifyFileLink(parse(signFileLink(link, 'b'.repeat(32), BASE)), SECRET, NOW)).toBe('bad-signature');
  });

  it.each([
    ['empty', ''],
    ['too short', 'abcd'],
    ['too long', 'a'.repeat(66)],
    ['not hex', 'z'.repeat(64)],
  ])('rejects a signature that is %s', (_label, sig) => {
    expect(verifyFileLink({ ...link, sig }, SECRET, NOW)).toBe('bad-signature');
  });

  it('rejects the signature in capitals: there is one way to write a link', () => {
    const signed = parse(signFileLink(link, SECRET, BASE));
    expect(verifyFileLink({ ...signed, sig: signed.sig.toUpperCase() }, SECRET, NOW)).toBe('bad-signature');
  });

  it('reports expiry', () => {
    const expired = { ...link, exp: NOW_SECONDS - 1 };
    expect(verifyFileLink(parse(signFileLink(expired, SECRET, BASE)), SECRET, NOW)).toBe('expired');
  });

  it('works until the second of the expiry, and not at it', () => {
    const at = parse(signFileLink({ ...link, exp: NOW_SECONDS }, SECRET, BASE));
    expect(verifyFileLink(at, SECRET, NOW - 1)).toBe('ok');
    expect(verifyFileLink(at, SECRET, NOW)).toBe('expired');
  });

  it('calls a forged link bad even when it is also expired: the signature is checked first', () => {
    const forged = { orderId: link.orderId, name: link.name, exp: NOW_SECONDS - 1, sig: '0'.repeat(64) };
    expect(verifyFileLink(forged, SECRET, NOW)).toBe('bad-signature');
  });
});
