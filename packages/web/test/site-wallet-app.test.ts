// Taking an order to a phone's wallet app: a phone's browser holds no wallet, so the form offers to open itself, filled in
// with what the person typed, in MetaMask's own browser. The fields travel in the link's query, and the form reads them
// back when it opens.
import { describe, expect, it } from 'vitest';
import { EMPTY_FIELDS, fieldsFromQuery, isMiniPay, isPhone, metaMaskLink, type Fields } from '../src/site/wallet-app';

const FIELDS: Fields = {
  url: 'cobrame.app',
  brief: 'Para freelancers, en un tono cercano & en español',
  pages: ['cobrame.app/app', '', 'https://cobrame.app/precios?plan=pro'],
  audio: 'none',
};

/** The query of the page a link opens, as the page reads it from its own address. */
const queryOf = (link: string): string => new URL(link.replace('https://link.metamask.io/dapp/', 'https://')).search;

describe('the link that opens the form in MetaMask', () => {
  it('opens the home on this host at the form, in MetaMask’s browser', () => {
    expect(metaMaskLink('advideoagent.com', { ...EMPTY_FIELDS, url: 'cobrame.app' })).toBe('https://link.metamask.io/dapp/advideoagent.com/?url=cobrame.app#order');
  });

  it('carries no query when the form is empty', () => {
    expect(metaMaskLink('advideoagent.com', EMPTY_FIELDS)).toBe('https://link.metamask.io/dapp/advideoagent.com/#order');
  });

  it('carries every field the person filled in, and the form reads them back', () => {
    const link = metaMaskLink('advideoagent.com', FIELDS);
    // The pages keep their order; an empty one between them is left out.
    expect(fieldsFromQuery(queryOf(link))).toEqual({ ...FIELDS, pages: ['cobrame.app/app', 'https://cobrame.app/precios?plan=pro', ''] });
  });

  it('leaves music out, as the form starts with it', () => {
    expect(metaMaskLink('advideoagent.com', { ...EMPTY_FIELDS, url: 'cobrame.app', audio: 'music' })).not.toContain('audio');
  });
});

describe('the form’s fields read from the address it opens at', () => {
  it('starts empty with no query', () => {
    expect(fieldsFromQuery('')).toEqual(EMPTY_FIELDS);
  });

  it('keeps to what the form can hold', () => {
    const query = new URLSearchParams([
      ['url', 'cobrame.app'],
      ['brief', 'x'.repeat(250)],
      ...['a.app', 'b.app', 'c.app', 'd.app'].map((page) => ['page', page]),
      ['audio', 'loud'],
    ]);
    expect(fieldsFromQuery(`?${query.toString()}`)).toEqual({ url: 'cobrame.app', brief: 'x'.repeat(200), pages: ['a.app', 'b.app', 'c.app'], audio: 'music' });
  });
});

describe('whether the page runs on a phone', () => {
  const desktop = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36', maxTouchPoints: 0 };

  it('knows an iPhone and an Android phone', () => {
    expect(isPhone({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1', maxTouchPoints: 5 })).toBe(true);
    expect(isPhone({ userAgent: 'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36', maxTouchPoints: 5 })).toBe(true);
  });

  it('knows an iPad, which says it is a Mac', () => {
    expect(isPhone({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15', maxTouchPoints: 5 })).toBe(true);
  });

  it('takes the browser’s word when it says it is a phone', () => {
    expect(isPhone({ ...desktop, userAgentData: { mobile: true } })).toBe(true);
  });

  it('knows a computer', () => {
    expect(isPhone(desktop)).toBe(false);
    expect(isPhone({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15', maxTouchPoints: 0 })).toBe(false);
  });
});

describe('isMiniPay', () => {
  it('knows MiniPay by the flag its wallet carries', () => {
    expect(isMiniPay({ isMiniPay: true, request: () => undefined })).toBe(true);
  });

  it('takes nothing else for it: another wallet, a flag that is not true, no wallet at all', () => {
    expect(isMiniPay({ isMetaMask: true, request: () => undefined })).toBe(false);
    expect(isMiniPay({ isMiniPay: 'true' })).toBe(false);
    expect(isMiniPay(undefined)).toBe(false);
    expect(isMiniPay(null)).toBe(false);
  });
});
