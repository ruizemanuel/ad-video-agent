// Downloads the page of a site for the pre-check, as a visitor with Chrome would see it before any script runs. It
// follows redirects by hand so the guard checks every address it is sent to, and it bounds the time and the size.
import { assertPublicUrl, UrlRejected, type LookupFn } from './url-guard';

export type FetchedPage = {
  /** The address the last request went to, after the redirects. */
  finalUrl: string;
  status: number;
  html: string;
};

export type FetchFailedCode = 'timeout' | 'network' | 'redirects' | 'not_html';

/** The page could not be had. `message` is for the person who asked. */
export class FetchFailed extends Error {
  constructor(
    readonly code: FetchFailedCode,
    message: string,
  ) {
    super(message);
    this.name = 'FetchFailed';
  }
}

/** The part of `fetch` this uses, so a test can stand in for the network. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type FetchPageOptions = {
  fetch?: FetchLike;
  lookup?: LookupFn;
  /** For the whole job, redirects included. */
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
};

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

// The same Chrome as the capture, so the pre-check sees what the capture will see. The language is English because
// the block pages the detector knows are in English.
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
  'accept-language': 'en-US,en;q=0.9',
};

export async function fetchPage(url: string, options: FetchPageOptions = {}): Promise<FetchedPage> {
  const { fetch: send = fetch, lookup, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES, maxRedirects = MAX_REDIRECTS } = options;
  const signal = AbortSignal.timeout(timeoutMs);

  try {
    let current = url;
    for (let hops = 0; ; hops += 1) {
      // Every address is checked, the first and each one a redirect points to.
      const target = await assertPublicUrl(current, lookup);
      const response = await send(target, { redirect: 'manual', signal, headers: HEADERS });

      const location = REDIRECTS.has(response.status) ? response.headers.get('location') : null;
      if (location === null) return { finalUrl: target.href, status: response.status, html: await readText(response, maxBytes) };

      await response.body?.cancel().catch(() => undefined);
      if (hops >= maxRedirects) throw new FetchFailed('redirects', 'The site redirects too many times.');
      current = new URL(location, target).href;
    }
  } catch (error) {
    if (error instanceof UrlRejected || error instanceof FetchFailed) throw error;
    if (signal.aborted) throw new FetchFailed('timeout', 'The site took too long to answer.');
    throw new FetchFailed('network', 'The site could not be reached.');
  }
}

/** The body as text, up to `maxBytes`: a page that is longer is cut, and the rest is not downloaded. */
async function readText(response: Response, maxBytes: number): Promise<string> {
  const type = response.headers.get('content-type') ?? '';
  // An error page is read whatever it says it is: a block is told by its content. Anything else must be a web page.
  if (response.ok && type !== '' && !/\b(html|xml)\b/i.test(type)) {
    await response.body?.cancel().catch(() => undefined);
    throw new FetchFailed('not_html', 'The address is not a web page.');
  }
  const bytes = await readCapped(response, maxBytes);
  return decoder(type).decode(bytes);
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  if (size >= maxBytes) await reader.cancel().catch(() => undefined);

  const all = new Uint8Array(Math.min(size, maxBytes));
  let at = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, all.length - at);
    all.set(part, at);
    at += part.length;
    if (at === all.length) break;
  }
  return all;
}

/** UTF-8, or the charset the server declares if the runtime knows it. */
function decoder(contentType: string): TextDecoder {
  const label = /charset\s*=\s*"?([^\s";]+)/i.exec(contentType)?.[1];
  if (label !== undefined) {
    try {
      return new TextDecoder(label);
    } catch {
      // A charset that nobody knows: UTF-8 is the best guess.
    }
  }
  return new TextDecoder();
}
