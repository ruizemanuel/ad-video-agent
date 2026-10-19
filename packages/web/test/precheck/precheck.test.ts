import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { FakeLlm } from '../../src/adapters/fake/llm';
import { FileStore } from '../../src/adapters/fake/store';
import { FetchFailed, type FetchedPage } from '../../src/precheck/fetch-page';
import { precheck, PrecheckCapReached, PRECHECK_MAX_AGE_MS, type PrecheckDeps } from '../../src/precheck/precheck';
import { UrlRejected } from '../../src/precheck/url-guard';
import { ModelOutputInvalid } from '../../src/ports';

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const U = 'https://tiendita.example/';
const thinHtml = fixture('thin.html');
const loginHtml = fixture('login.html');
const richHtml = fixture('rich.html');
const challengeHtml = fixture('challenge.html');

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

let store: FileStore;
let llm: FakeLlm;
let fetchPage: Mock<PrecheckDeps['fetchPage']>;
let deps: PrecheckDeps;

/** The page `fetchPage` will find: what the site answers, at the address it was asked for unless told otherwise. */
const serve = (html: string, extra: Partial<FetchedPage> = {}) => fetchPage.mockImplementation(async (url) => ({ finalUrl: url, status: 200, html, ...extra }));

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'precheck-'));
  dirs.push(dir);
  store = new FileStore(dir);
  llm = new FakeLlm();
  fetchPage = vi.fn<PrecheckDeps['fetchPage']>();
  serve(richHtml);
  // What the checks may cost in a day: PRECHECK_DAILY_CAP_USD's default.
  deps = { store, llm, fetchPage, dailyCapUsd: 2 };
});

describe('precheck', () => {
  it('returns inadmissible when the classifier says so and caches the result for 24 h', async () => {
    llm.classifySite = async () => ({ admissible: false, reason: 'scam', usd: 0.001 });
    expect(await precheck(U, deps)).toMatchObject({ ok: false, code: 'inadmissible' });
    await precheck(U, deps);
    expect(llm.calls.classifySite).toBe(1);
  });

  it('says why a site is inadmissible, in the classifier words', async () => {
    llm.classifySite = async () => ({ admissible: false, reason: 'The site sells counterfeit goods.', usd: 0.001 });
    expect(await precheck(U, deps)).toEqual({ ok: false, code: 'inadmissible', reason: 'The site sells counterfeit goods.' });
  });

  it('passes a good site, with its thinness and the demo links the capture will follow', async () => {
    expect(await precheck(U, deps)).toEqual({ ok: true, thin: false, demoLinks: ['https://tiendita.example/demo'] });
    serve(thinHtml);
    expect(await precheck('https://flaca.example/', deps)).toEqual({ ok: true, thin: true, demoLinks: [] });
  });

  it('reports the thinness as unknown for a site that builds itself in the browser', async () => {
    serve(fixture('spa-shell.html'));
    expect(await precheck(U, deps)).toEqual({ ok: true, thin: null, demoLinks: [] });
  });

  it('judges the page it ended on: the demo links are those of the final address', async () => {
    serve(richHtml, { finalUrl: 'https://www.tiendita.example/es/' });
    expect(await precheck(U, deps)).toMatchObject({ ok: true, demoLinks: ['https://www.tiendita.example/demo'] });
  });

  it('gives the classifier the address, the title and the first 4000 characters of the text', async () => {
    const seen: Parameters<typeof llm.classifySite>[0][] = [];
    llm.classifySite = async (input) => {
      seen.push(input);
      return { admissible: true, reason: 'ok', usd: 0.0004 };
    };
    serve(`<title>Una tienda</title><body><h1>Hola</h1><p>${'palabra '.repeat(2000)}</p></body>`, { finalUrl: 'https://tienda.example/inicio' });
    await precheck(U, deps);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://tienda.example/inicio');
    expect(seen[0]?.title).toBe('Una tienda');
    expect(seen[0]?.text).toHaveLength(4000);
    expect(seen[0]?.text.startsWith('Hola palabra palabra')).toBe(true);
  });

  it('bounds everything the classifier is sent, not only the text: a page can make its title or its address huge', async () => {
    const seen: Parameters<typeof llm.classifySite>[0][] = [];
    llm.classifySite = async (input) => {
      seen.push(input);
      return { admissible: true, reason: 'ok', usd: 0.0004 };
    };
    // A 100 KB title, a 100 KB text and an address (after a redirect) of 10 KB.
    const long = 'palabra '.repeat(12_500);
    serve(`<title>${long}</title><body><p>${long}</p></body>`, { finalUrl: `https://tienda.example/${'a'.repeat(10_000)}` });
    await precheck(U, deps);
    expect(seen).toHaveLength(1);
    const input = seen[0];
    expect(input?.title).toHaveLength(300);
    expect(input?.title.startsWith('palabra palabra')).toBe(true);
    expect(input?.text).toHaveLength(4000);
    expect(input?.url).toHaveLength(2048);
    expect(input?.url.startsWith('https://tienda.example/aaa')).toBe(true);
    expect(JSON.stringify(input).length).toBeLessThan(6500);
  });

  it('does not cut a title or an address that fits', async () => {
    const seen: Parameters<typeof llm.classifySite>[0][] = [];
    llm.classifySite = async (input) => {
      seen.push(input);
      return { admissible: true, reason: 'ok', usd: 0.0004 };
    };
    serve(`<title>${'t'.repeat(300)}</title><body>hola</body>`, { finalUrl: `https://tienda.example/${'a'.repeat(2048 - 'https://tienda.example/'.length)}` });
    await precheck(U, deps);
    expect(seen[0]?.title).toHaveLength(300);
    expect(seen[0]?.url).toHaveLength(2048);
  });

  it('records what the classifier cost as a card cost that belongs to no order', async () => {
    llm.classifySite = async () => ({ admissible: true, reason: 'ok', usd: 0.0004 });
    await precheck(U, deps);
    expect(await store.orderCost('precheck')).toBe(0.0004);
    // Once per classification, not once per answer: the cached one costs nothing.
    await precheck(U, deps);
    expect(await store.orderCost('precheck')).toBe(0.0004);
    // It is not money out of the buy wallet.
    expect(await store.buySpendSince(new Date(0))).toBe(0);
  });

  it('records the cost of a classification that said no, too', async () => {
    llm.classifySite = async () => ({ admissible: false, reason: 'scam', usd: 0.001 });
    await precheck(U, deps);
    expect(await store.orderCost('precheck')).toBe(0.001);
  });

  it('answers from the cache for 24 hours: no fetch and no classification', async () => {
    const getPrecheck = vi.spyOn(store, 'getPrecheck');
    const first = await precheck(U, deps);
    const second = await precheck(U, deps);
    expect(second).toEqual(first);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(llm.calls.classifySite).toBe(1);
    expect(PRECHECK_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
    expect(getPrecheck).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{64}$/), 24 * 60 * 60 * 1000);
  });

  it('reads the same address written differently as one site', async () => {
    await precheck('https://Tiendita.Example', deps);
    await precheck('https://tiendita.example/#precios', deps);
    await precheck('https://tiendita.example:443/', deps);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    // But a different page, or a different query, is a different site to the cache.
    await precheck('https://tiendita.example/otra', deps);
    await precheck('https://tiendita.example/?ref=a', deps);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('keeps the cache key a hash of the normal address, not the address', async () => {
    const put = vi.spyOn(store, 'putPrecheck');
    await precheck('https://Tiendita.Example/#x', deps);
    const [key] = put.mock.calls[0] ?? [];
    expect(key).toBe(createHash('sha256').update('https://tiendita.example/').digest('hex'));
  });

  describe('a site that cannot be used', () => {
    it('is blocked when the page is a challenge, and the classifier is not asked', async () => {
      serve(challengeHtml, { status: 403 });
      const result = await precheck(U, deps);
      expect(result).toMatchObject({ ok: false, code: 'blocked' });
      expect((result as { reason: string }).reason).toMatch(/human|automated|verification/i);
      expect(llm.calls.classifySite).toBe(0);
      expect(await store.orderCost('precheck')).toBe(0);
    });

    it('is blocked when the challenge answers 200, as some do', async () => {
      serve(challengeHtml, { status: 200 });
      expect(await precheck(U, deps)).toMatchObject({ ok: false, code: 'blocked' });
    });

    it('is blocked when an error comes with no page at all', async () => {
      serve('', { status: 503 });
      expect(await precheck(U, deps)).toMatchObject({ ok: false, code: 'blocked' });
    });

    it('asks for a login when the page is a login wall', async () => {
      serve(loginHtml);
      const result = await precheck(U, deps);
      expect(result).toMatchObject({ ok: false, code: 'login_wall' });
      expect((result as { reason: string }).reason).toMatch(/log ?in|sign ?in|account/i);
      expect(llm.calls.classifySite).toBe(0);
    });

    it('asks for a login when the site sent the visitor to a login page', async () => {
      serve(richHtml, { finalUrl: 'https://tiendita.example/users/sign-in' });
      expect(await precheck(U, deps)).toMatchObject({ ok: false, code: 'login_wall' });
    });

    it('is unreachable on an error status that is no challenge', async () => {
      serve(`<title>Not found</title><body>${'La página que buscás no existe. '.repeat(10)}</body>`, { status: 404 });
      const result = await precheck(U, deps);
      expect(result).toMatchObject({ ok: false, code: 'unreachable' });
      expect((result as { reason: string }).reason).toContain('404');
      expect(llm.calls.classifySite).toBe(0);
    });

    it('is unreachable on a redirect that goes nowhere', async () => {
      serve('', { status: 302 });
      expect(await precheck(U, deps)).toMatchObject({ ok: false, code: 'unreachable' });
    });

    it('is unreachable when the fetch fails: timeout, network, too many redirects, a name that does not exist', async () => {
      for (const error of [new FetchFailed('timeout', 'x'), new FetchFailed('network', 'x'), new FetchFailed('redirects', 'x'), new UrlRejected('unresolvable', 'x')]) {
        fetchPage.mockRejectedValueOnce(error);
        expect(await precheck(U, deps), error.message).toMatchObject({ ok: false, code: 'unreachable' });
      }
      expect(llm.calls.classifySite).toBe(0);
    });

    it('is an invalid address when the guard refuses it, and says why', async () => {
      fetchPage.mockRejectedValueOnce(new UrlRejected('private_address', 'That address points to a private or internal network, which is not accepted.'));
      expect(await precheck('http://10.0.0.5/', deps)).toEqual({
        ok: false,
        code: 'invalid_url',
        reason: 'That address points to a private or internal network, which is not accepted.',
      });
    });

    it('is an invalid address when it is not a web page, or not an address', async () => {
      fetchPage.mockRejectedValueOnce(new FetchFailed('not_html', 'The address is not a web page.'));
      expect(await precheck('https://tiendita.example/catalogo.pdf', deps)).toEqual({ ok: false, code: 'invalid_url', reason: 'The address is not a web page.' });
      fetchPage.mockClear();
      expect(await precheck('not a url', deps)).toMatchObject({ ok: false, code: 'invalid_url' });
      expect(await precheck('', deps)).toMatchObject({ ok: false, code: 'invalid_url' });
      expect(fetchPage).not.toHaveBeenCalled();
    });

    it('does not hide a failure it does not know', async () => {
      fetchPage.mockRejectedValueOnce(new RangeError('a bug'));
      await expect(precheck(U, deps)).rejects.toThrow('a bug');
    });

    it('does not answer for the classifier when it fails: nothing is cached and the error goes up', async () => {
      llm.classifySite = async () => {
        throw new Error('model unavailable');
      };
      await expect(precheck(U, deps)).rejects.toThrow('model unavailable');
      llm.classifySite = async () => ({ admissible: true, reason: 'ok', usd: 0.0004 });
      expect(await precheck(U, deps)).toMatchObject({ ok: true });
    });

    it('records what a classifier answer that did not fit cost, keeps nothing and lets it go up', async () => {
      const put = vi.spyOn(store, 'putPrecheck');
      llm.classifySite = async () => {
        throw new ModelOutputInvalid('The classify model did not answer with a valid classification.', 0.0007);
      };
      await expect(precheck(U, deps)).rejects.toBeInstanceOf(ModelOutputInvalid);
      expect(await store.orderCost('precheck')).toBe(0.0007);
      expect(put).not.toHaveBeenCalled();
    });

    it('is not remembered, because the next try may find the site up: only what the classifier judged is kept', async () => {
      const put = vi.spyOn(store, 'putPrecheck');
      serve(challengeHtml, { status: 403 });
      await precheck(U, deps);
      serve(loginHtml);
      await precheck(U, deps);
      fetchPage.mockRejectedValueOnce(new FetchFailed('timeout', 'x'));
      await precheck(U, deps);
      fetchPage.mockRejectedValueOnce(new UrlRejected('scheme', 'x'));
      await precheck('ftp://tiendita.example/', deps);
      expect(put).not.toHaveBeenCalled();

      serve(richHtml);
      const good = await precheck(U, deps);
      expect(put).toHaveBeenCalledExactlyOnceWith(expect.any(String), good);
      expect(fetchPage).toHaveBeenCalledTimes(5);
    });
  });
});

describe('the daily cap on what the checks cost', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks no model once what the checks cost today reaches the cap, keeps nothing, and asks again once it allows', async () => {
    await store.addCost('precheck', 'llm:classify', 2, 'card');
    await expect(precheck(U, deps)).rejects.toBeInstanceOf(PrecheckCapReached);
    expect(llm.calls.classifySite).toBe(0);

    expect(await precheck(U, { ...deps, dailyCapUsd: 3 })).toMatchObject({ ok: true });
    expect(llm.calls.classifySite).toBe(1);
  });

  it('still answers what it already judged, which costs nothing', async () => {
    expect(await precheck(U, deps)).toMatchObject({ ok: true });
    await store.addCost('precheck', 'llm:classify', 2, 'card');
    expect(await precheck(U, deps)).toMatchObject({ ok: true });
    expect(llm.calls.classifySite).toBe(1);
  });

  it('still refuses, for free, a page that needs no model to refuse', async () => {
    await store.addCost('precheck', 'llm:classify', 2, 'card');
    serve(loginHtml);
    expect(await precheck(U, deps)).toMatchObject({ ok: false, code: 'login_wall' });
  });

  it('counts only what the checks cost since the start of the day, UTC, and not what the orders cost', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-18T23:59:00Z') });
    await store.addCost('precheck', 'llm:classify', 2, 'card');
    await store.addCost('ord_someorder', 'llm:director', 5, 'card');
    vi.setSystemTime(new Date('2026-10-19T00:01:00Z'));
    await store.addCost('ord_someorder', 'llm:director', 5, 'card');
    expect(await precheck(U, deps)).toMatchObject({ ok: true });
  });

  it('says when to try again: at the start of the next day, UTC', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-18T23:00:00Z') });
    await store.addCost('precheck', 'llm:classify', 2, 'card');
    const error = await precheck(U, deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PrecheckCapReached);
    expect((error as PrecheckCapReached).retryAfterSeconds).toBe(3600);
  });
});
