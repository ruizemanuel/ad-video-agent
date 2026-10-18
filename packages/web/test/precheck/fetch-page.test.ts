import { describe, expect, it, vi } from 'vitest';
import { FetchFailed, fetchPage, type FetchLike } from '../../src/precheck/fetch-page';
import { UrlRejected, type LookupFn } from '../../src/precheck/url-guard';

const publicDns: LookupFn = async () => [{ address: '93.184.216.34', family: 4 }];
const html = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });
const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });

/** A fetch that answers from a list, one response per request, and keeps what it was asked. */
function scripted(...responses: (Response | Error)[]) {
  const asked: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = vi.fn<FetchLike>(async (input, init) => {
    asked.push({ url: String(input), init });
    const next = responses.shift();
    if (next === undefined) throw new Error('more requests than the test expected');
    if (next instanceof Error) throw next;
    return next;
  });
  return { fetch, asked };
}

describe('fetchPage', () => {
  it('gets the page, as Chrome would, and gives back where it ended, the status and the HTML', async () => {
    const { fetch, asked } = scripted(html('<h1>Hola</h1>'));
    const page = await fetchPage('https://tiendita.example/', { fetch, lookup: publicDns });
    expect(page).toEqual({ finalUrl: 'https://tiendita.example/', status: 200, html: '<h1>Hola</h1>' });
    expect(asked).toHaveLength(1);
    const init = asked[0]?.init;
    expect(init?.redirect).toBe('manual');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get('user-agent')).toMatch(/^Mozilla\/5\.0 .*Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/);
    expect(headers.get('accept')).toContain('text/html');
    expect(headers.get('accept-language')).toMatch(/^en/);
  });

  it('follows redirects (relative ones too) and reports the last address', async () => {
    const { fetch, asked } = scripted(redirect('/es/'), redirect('https://www.tiendita.example/es/inicio', 301), html('ok'));
    const page = await fetchPage('https://tiendita.example/', { fetch, lookup: publicDns });
    expect(page.finalUrl).toBe('https://www.tiendita.example/es/inicio');
    expect(asked.map((a) => a.url)).toEqual(['https://tiendita.example/', 'https://tiendita.example/es/', 'https://www.tiendita.example/es/inicio']);
  });

  it('re-checks every redirect hop', async () => {
    const { fetch, asked } = scripted(redirect('http://169.254.169.254/computeMetadata/v1/'), html('secret'));
    await expect(fetchPage('https://tiendita.example/', { fetch, lookup: publicDns })).rejects.toThrow(UrlRejected);
    // The second request was never made.
    expect(asked.map((a) => a.url)).toEqual(['https://tiendita.example/']);
  });

  it('re-checks the DNS answer of every hop, not only the first', async () => {
    const lookup = vi.fn<LookupFn>(async (host) => [{ address: host === 'inside.example' ? '10.0.0.8' : '93.184.216.34', family: 4 }]);
    const { fetch, asked } = scripted(redirect('https://inside.example/admin'), html('secret'));
    await expect(fetchPage('https://tiendita.example/', { fetch, lookup })).rejects.toMatchObject({ code: 'private_address' });
    expect(lookup.mock.calls.map(([host]) => host)).toEqual(['tiendita.example', 'inside.example']);
    expect(asked).toHaveLength(1);
  });

  it('refuses a redirect to another scheme or port', async () => {
    for (const to of ['ftp://tiendita.example/x', 'https://tiendita.example:8443/', 'file:///etc/passwd']) {
      const { fetch } = scripted(redirect(to));
      await expect(fetchPage('https://tiendita.example/', { fetch, lookup: publicDns }), to).rejects.toThrow(UrlRejected);
    }
  });

  it('does not even ask for an address that is not public', async () => {
    const { fetch } = scripted(html('secret'));
    await expect(fetchPage('http://10.0.0.5/', { fetch, lookup: publicDns })).rejects.toThrow(UrlRejected);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('follows up to 3 redirects and gives up on the fourth', async () => {
    const three = scripted(redirect('/1'), redirect('/2'), redirect('/3'), html('ok'));
    await expect(fetchPage('https://tiendita.example/', { fetch: three.fetch, lookup: publicDns })).resolves.toMatchObject({ finalUrl: 'https://tiendita.example/3', status: 200 });

    const four = scripted(redirect('/1'), redirect('/2'), redirect('/3'), redirect('/4'), html('ok'));
    await expect(fetchPage('https://tiendita.example/', { fetch: four.fetch, lookup: publicDns })).rejects.toMatchObject({ name: 'FetchFailed', code: 'redirects' });
    expect(four.asked).toHaveLength(4);
  });

  it('gives back an error page as it is, because a block is told by its content', async () => {
    const { fetch } = scripted(new Response('<title>Just a moment...</title>', { status: 403, headers: { 'content-type': 'text/html' } }));
    await expect(fetchPage('https://tiendita.example/', { fetch, lookup: publicDns })).resolves.toMatchObject({ status: 403, html: '<title>Just a moment...</title>' });
  });

  it('gives back a redirect that has nowhere to go as the answer it is', async () => {
    const { fetch } = scripted(new Response(null, { status: 302 }));
    await expect(fetchPage('https://tiendita.example/', { fetch, lookup: publicDns })).resolves.toMatchObject({ status: 302, html: '' });
  });

  it('cuts the page at 2 MB, and at maxBytes when asked', async () => {
    const big = 'a'.repeat(2 * 1024 * 1024 + 5000);
    const page = await fetchPage('https://tiendita.example/', { fetch: scripted(html(big)).fetch, lookup: publicDns });
    expect(page.html).toHaveLength(2 * 1024 * 1024);

    const small = await fetchPage('https://tiendita.example/', { fetch: scripted(html('b'.repeat(5000))).fetch, lookup: publicDns, maxBytes: 1000 });
    expect(small.html).toBe('b'.repeat(1000));
  });

  it('stops reading a page that is cut, instead of downloading the rest', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode('x'.repeat(100)));
        if (pulled > 10_000) controller.close();
      },
    });
    const { fetch } = scripted(new Response(body, { status: 200, headers: { 'content-type': 'text/html' } }));
    const page = await fetchPage('https://tiendita.example/', { fetch, lookup: publicDns, maxBytes: 1000 });
    expect(page.html).toHaveLength(1000);
    expect(pulled).toBeLessThan(100);
  });

  it('gives up after the timeout, however many redirects it took', async () => {
    const hang: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const started = Date.now();
    await expect(fetchPage('https://tiendita.example/', { fetch: hang, lookup: publicDns, timeoutMs: 30 })).rejects.toMatchObject({ name: 'FetchFailed', code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('waits 10 seconds by default', async () => {
    const { fetch, asked } = scripted(html('ok'));
    const spy = vi.spyOn(AbortSignal, 'timeout');
    await fetchPage('https://tiendita.example/', { fetch, lookup: publicDns });
    expect(spy).toHaveBeenCalledWith(10_000);
    expect(asked).toHaveLength(1);
    spy.mockRestore();
  });

  it('turns a network failure into one the caller knows', async () => {
    const { fetch } = scripted(new TypeError('fetch failed'));
    const error = await fetchPage('https://tiendita.example/', { fetch, lookup: publicDns }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FetchFailed);
    expect(error).toMatchObject({ code: 'network' });
  });

  it('says so when the address is not a web page', async () => {
    const pdf = new Response('%PDF-1.7', { status: 200, headers: { 'content-type': 'application/pdf' } });
    await expect(fetchPage('https://tiendita.example/catalogo.pdf', { fetch: scripted(pdf).fetch, lookup: publicDns })).rejects.toMatchObject({ code: 'not_html' });
    // Without a content type it is taken for HTML; XHTML is HTML; plain text is not; an error is read whatever it is.
    await expect(fetchPage('https://tiendita.example/', { fetch: scripted(new Response(new TextEncoder().encode('<p>hi</p>'), { status: 200 })).fetch, lookup: publicDns })).resolves.toMatchObject({ status: 200 });
    await expect(fetchPage('https://tiendita.example/', { fetch: scripted(new Response('hi', { status: 200 })).fetch, lookup: publicDns })).rejects.toMatchObject({ code: 'not_html' });
    const xhtml = new Response('<p>hi</p>', { status: 200, headers: { 'content-type': 'application/xhtml+xml' } });
    await expect(fetchPage('https://tiendita.example/', { fetch: scripted(xhtml).fetch, lookup: publicDns })).resolves.toMatchObject({ status: 200 });
    const json = new Response('{"error":"forbidden"}', { status: 403, headers: { 'content-type': 'application/json' } });
    await expect(fetchPage('https://tiendita.example/', { fetch: scripted(json).fetch, lookup: publicDns })).resolves.toMatchObject({ status: 403 });
  });

  it('reads the text in the charset the server declares, and in UTF-8 otherwise', async () => {
    const latin1 = new Response(new Uint8Array([0x43, 0x61, 0x66, 0xe9]), { status: 200, headers: { 'content-type': 'text/html; charset=ISO-8859-1' } });
    await expect(fetchPage('https://tiendita.example/', { fetch: scripted(latin1).fetch, lookup: publicDns })).resolves.toMatchObject({ html: 'Café' });
    const unknown = new Response('Café', { status: 200, headers: { 'content-type': 'text/html; charset=klingon' } });
    await expect(fetchPage('https://tiendita.example/', { fetch: scripted(unknown).fetch, lookup: publicDns })).resolves.toMatchObject({ html: 'Café' });
  });
});
