import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fakeFetchPage } from '../src/adapters/fake/fetch-page';
import { UrlRejected } from '../src/precheck/url-guard';

const page = (name: string): string => readFileSync(new URL(`../src/adapters/fake/pages/${name}`, import.meta.url), 'utf8');

describe('the fake page fetcher', () => {
  it('serves the rich page for any address, the thin one for an address that says "thin" and the login wall for one that says "login"', async () => {
    expect(await fakeFetchPage('https://tiendita.example/')).toEqual({ finalUrl: 'https://tiendita.example/', status: 200, html: page('rich.html') });
    expect(await fakeFetchPage('https://thin.tiendita.example/precios')).toEqual({
      finalUrl: 'https://thin.tiendita.example/precios',
      status: 200,
      html: page('thin.html'),
    });
    expect((await fakeFetchPage('https://tiendita.example/login')).html).toBe(page('login.html'));
  });

  it('refuses, as the real one does before it fetches, an address that is not a public web page', async () => {
    for (const [url, code] of [
      ['http://169.254.169.254/latest/meta-data/', 'private_address'],
      ['http://localhost/', 'host'],
      ['https://tiendita.example:8443/', 'port'],
      ['ftp://tiendita.example/', 'scheme'],
    ] as const) {
      const refused = fakeFetchPage(url);
      await expect(refused).rejects.toBeInstanceOf(UrlRejected);
      await expect(refused).rejects.toMatchObject({ code });
    }
  });
});
