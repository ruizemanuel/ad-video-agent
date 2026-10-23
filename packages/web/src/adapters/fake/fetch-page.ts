// The pre-check's page fetcher as a double, for the app in fake mode (AD_AGENT_ADAPTERS=fake): it never reaches a site.
// Every address gets the page of a site that shows its product well (pages/rich.html); one that says "login" gets a login
// wall (pages/login.html), and one that says "thin" a site that shows little of it (pages/thin.html). An address the real
// fetcher refuses before it fetches (a private network, this machine, another port or scheme) is refused the same way,
// with every name taken for a public one: no name is looked up.
import { readFile } from 'node:fs/promises';
import type { FetchedPage } from '../../precheck/fetch-page';
import { assertPublicUrl, type LookupFn } from '../../precheck/url-guard';

// An address reserved for documentation (RFC 5737): public to the guard, and never reached.
const anyName: LookupFn = async () => [{ address: '192.0.2.1', family: 4 }];

const PAGES = {
  rich: new URL('./pages/rich.html', import.meta.url),
  thin: new URL('./pages/thin.html', import.meta.url),
  login: new URL('./pages/login.html', import.meta.url),
};

export async function fakeFetchPage(url: string): Promise<FetchedPage> {
  const target = await assertPublicUrl(url, anyName);
  const page = target.href.includes('login') ? PAGES.login : target.href.includes('thin') ? PAGES.thin : PAGES.rich;
  return { finalUrl: target.href, status: 200, html: await readFile(page, 'utf8') };
}
