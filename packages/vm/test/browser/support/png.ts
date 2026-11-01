// Reads a PNG as Chrome writes a screenshot on a transparent background: 8-bit RGBA, not interlaced.
import { inflateSync } from 'node:zlib';

/** The size of the PNG and its rows as stored: each row its filter byte, then 4 bytes a pixel. */
function storedRows(png: Buffer): { width: number; height: number; rows: Buffer } {
  const [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  const [depth, colorType, interlace] = [png[24], png[25], png[28]];
  if (depth !== 8 || colorType !== 6 || interlace !== 0) throw new Error(`Not an 8-bit RGBA PNG (depth ${depth}, color type ${colorType}, interlace ${interlace}).`);
  const data: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.toString('ascii', at + 4, at + 8) === 'IDAT') data.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  return { width, height, rows: inflateSync(Buffer.concat(data)) };
}

/** Whether any pixel of the PNG has something in it, that is, is not transparent black. */
export function pngHasInk(png: Buffer): boolean {
  const { width, rows } = storedRows(png);
  const stride = 1 + width * 4;
  // Each row starts with its filter byte. A filtered image is all zeros exactly when the image is, whatever the filters.
  return rows.some((byte, i) => i % stride !== 0 && byte !== 0);
}

/** The predictor of the Paeth filter: of the pixel to the left, above and above-left, the one nearest their gradient. */
const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** The pixels of the PNG, its filters undone: RGBA, 4 bytes a pixel, row after row, as a canvas's getImageData gives them. */
export function pngPixels(png: Buffer): { width: number; height: number; rgba: Uint8ClampedArray } {
  const { width, height, rows } = storedRows(png);
  const stride = width * 4;
  const rgba = new Uint8ClampedArray(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = rows[y * (stride + 1)];
    const from = y * (stride + 1) + 1;
    const at = y * stride;
    for (let x = 0; x < stride; x++) {
      // The bytes the filter of this one was computed from: the same channel of the pixel to the left, above, above-left.
      const a = x >= 4 ? (rgba[at + x - 4] ?? 0) : 0;
      const b = y > 0 ? (rgba[at - stride + x] ?? 0) : 0;
      const c = x >= 4 && y > 0 ? (rgba[at - stride + x - 4] ?? 0) : 0;
      const raw = rows[from + x] ?? 0;
      const predicted = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth(a, b, c) : NaN;
      if (Number.isNaN(predicted)) throw new Error(`Row ${y} of the PNG has an unknown filter, ${filter}.`);
      // Modulo 256, as the format adds: the clamped array would otherwise saturate.
      rgba[at + x] = (raw + predicted) & 0xff;
    }
  }
  return { width, height, rgba };
}
