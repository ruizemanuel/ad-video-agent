// The links of a site that show the product (a demo, an example, a playground), which the capture follows to get
// more to film. Pure: the pre-check and the capture on the VM both use it.

export type Anchor = { href: string; text: string };

const DEMO = /\b(demo|ejemplo|example|try|probar|playground|sandbox|preview)\b/i;
// A page that asks for an account is not a demo of the product.
const ACCOUNT = /(login|signin|signup|register|auth)/i;

// Under these (com.ar, co.uk, gob.mx...) the registrable name has one label more: otra.com.ar is not tienda.com.ar.
const SECOND_LEVEL = new Set(['com', 'co', 'org', 'net', 'gov', 'gob', 'edu', 'ac', 'mil']);

/** The name that belongs to one owner: `app.tiendita.example` and `www.tiendita.example` are both `tiendita.example`. */
function siteOf(hostname: string): string {
  if (/^[\d.]+$/.test(hostname) || hostname.includes(':')) return hostname;
  const labels = hostname.split('.');
  const tld = labels.at(-1) ?? '';
  const second = labels.at(-2) ?? '';
  const keep = labels.length >= 3 && tld.length === 2 && SECOND_LEVEL.has(second) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

/**
 * Up to `max` links of the page that lead to a demo of the product, as full addresses and in the order of the page.
 * A link counts when its text or its address says so (by whole word), it stays on the site of `baseUrl` (the same host
 * or a subdomain of it) and neither asks for an account. The page itself and repeated links are left out.
 */
export function findDemoLinks(anchors: readonly Anchor[], baseUrl: string, max = 2): string[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const page = withoutHash(base);
  const site = siteOf(hostOf(base));
  const found = new Set<string>();

  for (const { href, text } of anchors) {
    if (found.size >= max) break;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    const host = hostOf(url);
    const here = siteOf(host);
    if (here !== site) continue;
    // Not the host itself: on example.com every address would say "example". A subdomain (demo.tiendita.example) counts.
    const subdomain = host.slice(0, host.length - here.length);
    const said = `${text} ${url.pathname}${url.search} ${subdomain}`;
    if (!DEMO.test(said) || ACCOUNT.test(said)) continue;
    const target = withoutHash(url);
    if (target !== page) found.add(target);
  }
  return [...found];
}

// A trailing dot (tiendita.example.) names the same host.
const hostOf = (url: URL): string => url.hostname.replace(/\.$/, '');

function withoutHash(url: URL): string {
  const copy = new URL(url);
  copy.hash = '';
  return copy.href;
}
