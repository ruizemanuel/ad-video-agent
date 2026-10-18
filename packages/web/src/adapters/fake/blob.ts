// The BlobPort on plain files under `<dir>/blob`, for the tests that run the routes and the flow without a store.
// A blob's path is its path under that folder. The presigned URLs are not real: they only say what was asked for,
// and the last of each is kept in `lastPresignGet` and `lastPresignPut` so a test can check it.
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { BlobPort } from '../../ports';

// A path as the path of a URL: a header (the Location of a redirect) cannot hold what is not ASCII.
const urlPath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

const isMissing = (error: unknown): boolean => (error as { code?: string }).code === 'ENOENT';

export class FileBlob implements BlobPort {
  private readonly root: string;

  /** What the last `presignGet` was asked for. */
  lastPresignGet: { path: string; minutes: number } | undefined;
  /** What the last `presignPut` was asked for. */
  lastPresignPut: { path: string; contentType: string; maxBytes: number; minutes: number } | undefined;

  constructor(dir: string) {
    this.root = resolve(dir, 'blob');
  }

  /** Where a blob lives. A path that could leave the blob folder (or name a drive or a stream on Windows) is refused. */
  private locate(path: string): string {
    const segments = path.split('/');
    if (path === '' || /[\\:]/.test(path) || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new RangeError(`"${path}" is not a blob path: use names joined by single slashes, with no leading slash, "." or "..".`);
    }
    return join(this.root, ...segments);
  }

  async put(path: string, body: Uint8Array | string, _contentType: string): Promise<{ bytes: number }> {
    const file = this.locate(path);
    const bytes = typeof body === 'string' ? Buffer.from(body) : body;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
    return { bytes: bytes.byteLength };
  }

  async get(path: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await readFile(this.locate(path)));
    } catch (error) {
      if (isMissing(error)) throw new Error(`The blob ${path} does not exist.`);
      throw error;
    }
  }

  async presignPut(path: string, contentType: string, maxBytes: number, minutes: number): Promise<string> {
    this.lastPresignPut = { path, contentType, maxBytes, minutes };
    return `https://fake-blob.invalid/${urlPath(path)}?op=put&type=${encodeURIComponent(contentType)}&max=${maxBytes}&minutes=${minutes}`;
  }

  async presignGet(path: string, minutes: number): Promise<string> {
    this.lastPresignGet = { path, minutes };
    return `https://fake-blob.invalid/${urlPath(path)}?op=get&minutes=${minutes}`;
  }

  async deletePrefix(prefix: string): Promise<number> {
    if (prefix === '') throw new RangeError('deletePrefix needs a prefix: an empty one would delete every blob.');
    let entries;
    try {
      entries = await readdir(this.root, { recursive: true, withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return 0;
      throw error;
    }
    // A prefix matches the start of the path, as in the real store: it need not end at a slash.
    const doomed = entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .filter((file) => file.slice(this.root.length + 1).split(sep).join('/').startsWith(prefix));
    await Promise.all(doomed.map((file) => rm(file, { force: true })));
    return doomed.length;
  }
}
