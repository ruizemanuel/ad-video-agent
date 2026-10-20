// Reads a PNG as Chrome writes a screenshot on a transparent background: 8-bit RGBA, not interlaced.
import { inflateSync } from 'node:zlib';

/** Whether any pixel of the PNG has something in it, that is, is not transparent black. */
export function pngHasInk(png: Buffer): boolean {
  const width = png.readUInt32BE(16);
  const [depth, colorType, interlace] = [png[24], png[25], png[28]];
  if (depth !== 8 || colorType !== 6 || interlace !== 0) throw new Error(`Not an 8-bit RGBA PNG (depth ${depth}, color type ${colorType}, interlace ${interlace}).`);
  const data: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.toString('ascii', at + 4, at + 8) === 'IDAT') data.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const rows = inflateSync(Buffer.concat(data));
  const stride = 1 + width * 4;
  // Each row starts with its filter byte. A filtered image is all zeros exactly when the image is, whatever the filters.
  return rows.some((byte, i) => i % stride !== 0 && byte !== 0);
}
