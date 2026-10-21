// What a shot shows in a region: whether two shots of a page are the same picture there. A full-page shot can be 2880 x
// 16000 pixels (184 MB as RGBA), so a PNG is read row by row, and only what the regions need is kept: the mean color of
// each of their cells.
import { createInflate } from 'node:zlib';

/** A rectangle in pixels of the shot. */
export type Region = { x: number; y: number; w: number; h: number };

/** The side of the square cells a region is read in, in pixels of the shot (4 CSS pixels at DPR 2). */
const CELL = 8;
/** How far, of 255, the mean color of a cell may move in a channel with the picture still the same: less than shows. */
const SAME = 2;

type Area = { x0: number; y0: number; x1: number; y1: number; cols: number };

/**
 * The mean RGB of each cell of each region, the part of it that is in the picture (null for a region with none). Reads
 * an 8-bit, non-interlaced RGB or RGBA PNG, as Chrome writes its screenshots.
 */
async function cellMeans(png: Uint8Array, regions: readonly Region[]): Promise<(Float64Array | null)[]> {
  const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const [depth, colorType, interlace] = [bytes[24], bytes[25], bytes[28]];
  if (bytes.toString('ascii', 12, 16) !== 'IHDR' || depth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error(`Not an 8-bit RGB or RGBA PNG (depth ${depth}, color type ${colorType}, interlace ${interlace}).`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const areas = regions.map((r): Area | null => {
    const [x0, y0] = [Math.max(0, Math.round(r.x)), Math.max(0, Math.round(r.y))];
    const [x1, y1] = [Math.min(width, Math.round(r.x + r.w)), Math.min(height, Math.round(r.y + r.h))];
    return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1, cols: Math.ceil((x1 - x0) / CELL) } : null;
  });
  // Per cell: the sums of R, G and B, and the count of pixels.
  const sums = areas.map((a) => (a ? new Float64Array(a.cols * Math.ceil((a.y1 - a.y0) / CELL) * 4) : null));

  const idat: Buffer[] = [];
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    if (bytes.toString('ascii', at + 4, at + 8) === 'IDAT') idat.push(bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = new Uint8Array(stride + 1); // a row as stored: its filter byte, then the filtered bytes
  let line = new Uint8Array(stride);
  let prior = new Uint8Array(stride);
  let filled = 0;
  let y = 0;
  const unfilter = (): void => {
    const filter = raw[0];
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? (line[i - channels] ?? 0) : 0;
      const up = prior[i] ?? 0;
      const byte = raw[i + 1] ?? 0;
      if (filter === 0) line[i] = byte;
      else if (filter === 1) line[i] = byte + left;
      else if (filter === 2) line[i] = byte + up;
      else if (filter === 3) line[i] = byte + ((left + up) >> 1);
      else if (filter === 4) {
        const upLeft = i >= channels ? (prior[i - channels] ?? 0) : 0;
        const p = left + up - upLeft;
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
        line[i] = byte + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      } else throw new Error(`Unknown PNG filter ${filter}.`);
    }
  };
  const take = (): void => {
    areas.forEach((a, k) => {
      const s = sums[k];
      if (!a || !s || y < a.y0 || y >= a.y1) return;
      const rowOfCells = Math.floor((y - a.y0) / CELL) * a.cols;
      for (let x = a.x0; x < a.x1; x++) {
        const cell = (rowOfCells + Math.floor((x - a.x0) / CELL)) * 4;
        const at = x * channels;
        s[cell] = (s[cell] ?? 0) + (line[at] ?? 0);
        s[cell + 1] = (s[cell + 1] ?? 0) + (line[at + 1] ?? 0);
        s[cell + 2] = (s[cell + 2] ?? 0) + (line[at + 2] ?? 0);
        s[cell + 3] = (s[cell + 3] ?? 0) + 1;
      }
    });
  };
  const inflate = createInflate();
  inflate.end(Buffer.concat(idat));
  for await (const chunk of inflate as AsyncIterable<Buffer>) {
    for (let at = 0; at < chunk.length && y < height; ) {
      const n = Math.min(stride + 1 - filled, chunk.length - at);
      raw.set(chunk.subarray(at, at + n), filled);
      filled += n;
      at += n;
      if (filled === stride + 1) {
        unfilter();
        take();
        [prior, line] = [line, prior];
        filled = 0;
        y++;
      }
    }
  }
  return sums.map((s) => {
    if (!s) return null;
    const means = new Float64Array((s.length / 4) * 3);
    for (let cell = 0; cell < s.length / 4; cell++) {
      const count = s[cell * 4 + 3] || 1;
      for (let c = 0; c < 3; c++) means[cell * 3 + c] = (s[cell * 4 + c] ?? 0) / count;
    }
    return means;
  });
}

/**
 * For each region (in pixels of the shots), whether two shots of the same size show the same picture there: no cell of
 * 8 x 8 pixels changed its mean color by more than 2 of 255 in any channel. False for a region with no part in the
 * shots: nothing can be said of it.
 */
export async function unchangedRegions(before: Uint8Array, after: Uint8Array, regions: readonly Region[]): Promise<boolean[]> {
  // One after the other: a full-page shot is read with what the regions need of it in memory, and no more.
  const a = await cellMeans(before, regions);
  const b = await cellMeans(after, regions);
  return regions.map((_, k) => {
    const [x, y] = [a[k], b[k]];
    if (!x || !y || x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (Math.abs((x[i] ?? 0) - (y[i] ?? 0)) > SAME) return false;
    return true;
  });
}
