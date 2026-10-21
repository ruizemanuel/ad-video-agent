// The small site of test/fixtures/site, served on a free local port for the browser tests to capture.
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join } from 'node:path';

const SITE = join(import.meta.dirname, '..', '..', 'fixtures', 'site');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.woff2': 'font/woff2' };

/**
 * Serves the fixture site; `url` ends in a slash. `files` serves more at the paths given (no leading slash), from where
 * they are on disk: a font a test got from Google Fonts, under a name of the site's own.
 */
export async function serveFixtureSite(files: Record<string, string> = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const name = !req.url || req.url === '/' ? 'index.html' : (req.url.slice(1).split('?')[0] ?? '');
    const file = files[name] ?? join(SITE, name);
    if (name.includes('..') || !existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
