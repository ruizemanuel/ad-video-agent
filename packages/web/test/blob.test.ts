import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FileBlob } from '../src/adapters/fake/blob';
import type { BlobPort } from '../src/ports';

const dirs: string[] = [];
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'blob-'));
  dirs.push(dir);
  return dir;
};
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

// What any BlobPort has to do. The real adapter cannot run it without a store, so its calls are checked in blob-real.test.ts.
function describeBlobContract(name: string, make: () => Promise<BlobPort>) {
  describe(`${name} as a BlobPort`, () => {
    it('keeps what it is given, byte for byte', async () => {
      const blob = await make();
      const bytes = Uint8Array.from([0, 255, 1, 254, 128, 10, 13]);
      expect(await blob.put('orders/ord_a/music/cand-0.wav', bytes, 'audio/wav')).toEqual({ bytes: 7 });
      expect(await blob.get('orders/ord_a/music/cand-0.wav')).toEqual(bytes);
    });

    it('counts the bytes of a string, not its characters', async () => {
      const blob = await make();
      expect(await blob.put('orders/ord_a/out/claims.md', 'Précio – 5 €', 'text/markdown')).toEqual({ bytes: Buffer.byteLength('Précio – 5 €') });
      expect(text(await blob.get('orders/ord_a/out/claims.md'))).toBe('Précio – 5 €');
    });

    it('replaces what is already there', async () => {
      const blob = await make();
      await blob.put('orders/ord_a/capture.json', 'first', 'application/json');
      await blob.put('orders/ord_a/capture.json', 'second', 'application/json');
      expect(text(await blob.get('orders/ord_a/capture.json'))).toBe('second');
    });

    it('fails on a blob that does not exist', async () => {
      const blob = await make();
      await expect(blob.get('orders/ord_a/nothing.json')).rejects.toThrow('orders/ord_a/nothing.json');
    });

    it('deletes everything under a prefix, counts it, and leaves the rest', async () => {
      const blob = await make();
      await blob.put('orders/ord_a/capture.json', '1', 'application/json');
      await blob.put('orders/ord_a/out/hook-a-9x16.mp4', '2', 'video/mp4');
      await blob.put('orders/ord_a/music/cand-0.wav', '3', 'audio/wav');
      await blob.put('orders/ord_ab/capture.json', '4', 'application/json');
      await blob.put('orders/ord_b/capture.json', '5', 'application/json');
      expect(await blob.deletePrefix('orders/ord_a/')).toBe(3);
      await expect(blob.get('orders/ord_a/capture.json')).rejects.toThrow();
      await expect(blob.get('orders/ord_a/out/hook-a-9x16.mp4')).rejects.toThrow();
      expect(text(await blob.get('orders/ord_ab/capture.json'))).toBe('4');
      expect(text(await blob.get('orders/ord_b/capture.json'))).toBe('5');
      expect(await blob.deletePrefix('orders/ord_a/')).toBe(0);
    });

    it('refuses an empty prefix, which would delete every order', async () => {
      const blob = await make();
      await blob.put('orders/ord_a/capture.json', '1', 'application/json');
      await expect(blob.deletePrefix('')).rejects.toThrow('prefix');
      expect(text(await blob.get('orders/ord_a/capture.json'))).toBe('1');
    });

    it('gives a URL for a presigned read and one for a presigned write', async () => {
      const blob = await make();
      const get = await blob.presignGet('orders/ord_a/out/hook-a-9x16.mp4', 10);
      const put = await blob.presignPut('orders/ord_a/capture.json', 'application/json', 1_000_000, 30);
      expect(new URL(get).protocol).toBe('https:');
      expect(new URL(put).protocol).toBe('https:');
      expect(get).not.toBe(put);
    });
  });
}

describeBlobContract('FileBlob', async () => new FileBlob(await tempDir()));

describe('FileBlob', () => {
  it('keeps its files under <dir>/blob, next to the store and not mixed with it', async () => {
    const dir = await tempDir();
    await new FileBlob(dir).put('orders/ord_a/out/claims.md', 'x', 'text/markdown');
    expect(await readdir(dir)).toEqual(['blob']);
    expect((await readdir(join(dir, 'blob'), { recursive: true })).map((file) => file.replaceAll('\\', '/')).sort()).toEqual([
      'orders',
      'orders/ord_a',
      'orders/ord_a/out',
      'orders/ord_a/out/claims.md',
    ]);
  });

  it('shares its files between instances over one directory, as a test that seeds a blob and a route that reads it do', async () => {
    const dir = await tempDir();
    await new FileBlob(dir).put('orders/ord_a/out/claims.md', 'shared', 'text/markdown');
    expect(text(await new FileBlob(dir).get('orders/ord_a/out/claims.md'))).toBe('shared');
  });

  it('works on a directory that does not exist yet', async () => {
    const blob = new FileBlob(join(await tempDir(), 'nested', 'fake'));
    await expect(blob.get('orders/ord_a/capture.json')).rejects.toThrow('orders/ord_a/capture.json');
    expect(await blob.deletePrefix('orders/')).toBe(0);
    await blob.put('orders/ord_a/capture.json', '1', 'application/json');
    expect(text(await blob.get('orders/ord_a/capture.json'))).toBe('1');
  });

  it('matches a prefix against the start of the path, as the real store does, so it need not end at a slash', async () => {
    const blob = new FileBlob(await tempDir());
    await blob.put('orders/ord_a/capture.json', '1', 'application/json');
    await blob.put('orders/ord_ab/capture.json', '2', 'application/json');
    await blob.put('orders/ord_b/capture.json', '3', 'application/json');
    expect(await blob.deletePrefix('orders/ord_a')).toBe(2);
    expect(text(await blob.get('orders/ord_b/capture.json'))).toBe('3');
  });

  it('records the last presigned read, for the tests that check what a route asked for', async () => {
    const blob = new FileBlob(await tempDir());
    expect(blob.lastPresignGet).toBeUndefined();
    await blob.presignGet('orders/ord_a/out/hook-a-9x16.mp4', 10);
    expect(blob.lastPresignGet).toEqual({ path: 'orders/ord_a/out/hook-a-9x16.mp4', minutes: 10 });
    await blob.presignGet('orders/ord_a/out/claims.md', 2);
    expect(blob.lastPresignGet).toEqual({ path: 'orders/ord_a/out/claims.md', minutes: 2 });
  });

  it('records the last presigned write with what it allows', async () => {
    const blob = new FileBlob(await tempDir());
    expect(blob.lastPresignPut).toBeUndefined();
    await blob.presignPut('orders/ord_a/capture.json', 'application/json', 5_000_000, 30);
    expect(blob.lastPresignPut).toEqual({ path: 'orders/ord_a/capture.json', contentType: 'application/json', maxBytes: 5_000_000, minutes: 30 });
  });

  it('keeps a path with odd characters out of the way of the file system', async () => {
    const blob = new FileBlob(await tempDir());
    await blob.put('orders/ord_a/out/my ad (final).mp4', 'x', 'video/mp4');
    expect(text(await blob.get('orders/ord_a/out/my ad (final).mp4'))).toBe('x');
  });

  it.each([['../outside.txt'], ['orders/../../outside.txt'], ['/etc/passwd'], ['C:/Windows/win.ini'], ['orders\\ord_a\\x'], ['']])(
    'refuses the path %j, which would leave the blob folder',
    async (path) => {
      const blob = new FileBlob(await tempDir());
      await expect(blob.put(path, 'x', 'text/plain')).rejects.toThrow();
      await expect(blob.get(path)).rejects.toThrow();
    },
  );
});
