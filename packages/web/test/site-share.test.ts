import { describe, expect, it } from 'vitest';
import { postUrlOf, xIntentUrl } from '../src/site/share';

const INTENT = 'https://x.com/intent/post?text=';
const SITE = 'https://cobrame.example/';
const MAX = 280;

/** The text X would open with, as the link carries it. */
const textOf = (link: string): string => new URL(link).searchParams.get('text') ?? '';

describe('xIntentUrl', () => {
  it('encodes, falls back to the host and stays within 280 chars', () => {
    // The text is the first line, a space and the site, encoded as one piece of a query.
    const line = 'Get paid & “on time”? 100% — yes #1';
    const link = xIntentUrl(line, SITE);
    expect(link).toBe(`${INTENT}${encodeURIComponent(`${line} ${SITE}`)}`);
    expect(textOf(link)).toBe(`${line} ${SITE}`);

    // No first line (an order with no claims, or one that is blank): the host of the site stands in for it.
    expect(textOf(xIntentUrl('', 'https://cobrame.example/pricing?plan=pro'))).toBe('cobrame.example https://cobrame.example/pricing?plan=pro');
    expect(textOf(xIntentUrl('  \n ', SITE))).toBe(`cobrame.example ${SITE}`);

    // A line that fits to the character is left as it is; one more character is cut, with an ellipsis, and the
    // site, last, is never touched.
    const room = MAX - SITE.length - 1;
    expect(textOf(xIntentUrl('a'.repeat(room), SITE))).toBe(`${'a'.repeat(room)} ${SITE}`);
    const cut = textOf(xIntentUrl('a'.repeat(room + 1), SITE));
    expect(cut).toBe(`${'a'.repeat(room - 1)}… ${SITE}`);
    expect(cut).toHaveLength(MAX);
    const long = textOf(xIntentUrl('word '.repeat(200), SITE));
    expect(long.length).toBeLessThanOrEqual(MAX);
    expect(long.endsWith(` ${SITE}`)).toBe(true);
    expect(long).toContain('… ');
  });

  it('folds a line that breaks into one line', () => {
    expect(textOf(xIntentUrl('Get paid\n  on time.', SITE))).toBe(`Get paid on time. ${SITE}`);
  });

  it('never cuts a character in two, and counts the characters as a string does', () => {
    const emoji = '😀'.repeat(300);
    const text = textOf(xIntentUrl(emoji, SITE));
    expect(text.length).toBeLessThanOrEqual(MAX);
    expect(text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    expect(text.endsWith(` ${SITE}`)).toBe(true);
  });

  it('never throws on half of a character, which it writes as the replacement character', () => {
    // A lone half of a surrogate pair (a high one, then a low one), which no link can carry as it is.
    for (const half of ['\ud83d', '\ude00']) {
      const line = `Get paid ${half} on time`;
      expect(() => xIntentUrl(line, SITE), JSON.stringify(half)).not.toThrow();
      expect(textOf(xIntentUrl(line, SITE))).toBe(`Get paid � on time ${SITE}`);
    }
    // A whole emoji stays as it is beside one cut in half.
    expect(textOf(xIntentUrl('😀 ok \ud83d', SITE))).toBe(`😀 ok � ${SITE}`);
    // Nor does the site's address make it throw.
    expect(textOf(xIntentUrl('Get paid', 'https://cobrame.example/\ud800'))).toBe('Get paid https://cobrame.example/�');
  });

  it('keeps a site address that leaves no room for a line, whole and alone', () => {
    const site = `https://cobrame.example/${'p'.repeat(300)}`;
    expect(textOf(xIntentUrl('Get paid on time', site))).toBe(site);
  });
});

describe('postUrlOf', () => {
  it('takes the link as typed, with https when it is left out', () => {
    expect(postUrlOf('https://x.com/cobrame/status/123')).toBe('https://x.com/cobrame/status/123');
    expect(postUrlOf('  x.com/cobrame/status/123 ')).toBe('https://x.com/cobrame/status/123');
  });

  it('refuses what the service would: not https, not a link, spaces in it, too long, or a login in it', () => {
    for (const typed of ['', '   ', 'http://x.com/a/status/1', 'ftp://x.com/a', 'not a link', 'https://', 'https://user:pass@x.com/a']) {
      expect(postUrlOf(typed), typed).toBeNull();
    }
    expect(postUrlOf(`https://x.com/${'a'.repeat(2048)}`)).toBeNull();
    expect(postUrlOf(`https://x.com/${'a'.repeat(2048 - 'https://x.com/'.length)}`)).not.toBeNull();
  });
});
