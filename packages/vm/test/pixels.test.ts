import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { unchangedRegions } from '../src/capture/pixels';

type Rgb = [number, number, number];

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/**
 * A PNG of `width` x `height` with the color `pixel` gives, 8-bit RGB or RGBA (opaque), every row written with `filter`
 * (0 none, 1 sub, 2 up, 3 average, 4 Paeth) and the data split over `chunks` IDAT chunks, as an encoder may write it.
 */
function png(width: number, height: number, pixel: (x: number, y: number) => Rgb, { rgba = false, filter = 0, chunks = 1 } = {}): Buffer {
  const channels = rgba ? 4 : 3;
  const stride = width * channels;
  const rows = Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => [...pixel(x, y), ...(rgba ? [255] : [])]).flat());
  const data = Buffer.alloc((stride + 1) * height);
  rows.forEach((row, y) => {
    const above = rows[y - 1] ?? new Array<number>(stride).fill(0);
    data[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? (row[i - channels] ?? 0) : 0;
      const b = above[i] ?? 0;
      const c = i >= channels ? (above[i - channels] ?? 0) : 0;
      const predictor = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter] ?? 0;
      data[y * (stride + 1) + 1 + i] = ((row[i] ?? 0) - predictor) & 0xff;
    }
  });
  const chunk = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([head, typed, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = rgba ? 6 : 2;
  const compressed = deflateSync(data);
  const size = Math.ceil(compressed.length / chunks);
  const idat = Array.from({ length: chunks }, (_, k) => chunk('IDAT', compressed.subarray(k * size, (k + 1) * size)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), ...idat, chunk('IEND', Buffer.alloc(0))]);
}

const YELLOW: Rgb = [252, 255, 82];
// A picture with something in every row and column, so that each filter has work to do.
const busy = (x: number, y: number): Rgb => [(x * 7 + y * 3) % 256, (x * y) % 256, (255 - x * 5 + y) & 0xff];

describe('unchangedRegions', () => {
  it('reads the same picture as the same, whatever filter its rows were written with, RGB or RGBA, in one IDAT chunk or many', async () => {
    const regions = [
      { x: 0, y: 0, w: 40, h: 30 },
      { x: 5, y: 3, w: 17, h: 11 },
    ];
    const plain = png(40, 30, busy);
    for (const filter of [1, 2, 3, 4]) {
      for (const rgba of [false, true]) {
        expect(await unchangedRegions(plain, png(40, 30, busy, { filter, rgba, chunks: 3 }), regions), `filter ${filter}, rgba ${rgba}`).toEqual([true, true]);
      }
    }
  });

  it('tells a region where a one-pixel line was drawn from one where nothing was', async () => {
    const empty = png(64, 64, () => YELLOW);
    const line = png(64, 64, (x) => (x === 40 ? [0, 0, 0] : YELLOW), { filter: 4 });
    const halves = [
      { x: 0, y: 0, w: 32, h: 64 },
      { x: 32, y: 0, w: 32, h: 64 },
    ];
    expect(await unchangedRegions(empty, line, halves)).toEqual([true, false]);
  });

  it('takes a picture no part of which moved by more than 2 of 255 as the same: that is no paint', async () => {
    const empty = png(32, 32, () => YELLOW);
    const whole = [{ x: 0, y: 0, w: 32, h: 32 }];
    expect(await unchangedRegions(empty, png(32, 32, () => [YELLOW[0], YELLOW[1], YELLOW[2] - 2]), whole)).toEqual([true]);
    expect(await unchangedRegions(empty, png(32, 32, () => [YELLOW[0], YELLOW[1], YELLOW[2] - 3]), whole)).toEqual([false]);
  });

  it('reads the part of a region that is in the picture, and cannot call one with no part in it unchanged', async () => {
    const empty = png(32, 32, () => YELLOW);
    expect(await unchangedRegions(empty, empty, [{ x: 24, y: 24, w: 20, h: 20 }])).toEqual([true]);
    expect(await unchangedRegions(empty, empty, [{ x: 40, y: 0, w: 8, h: 8 }])).toEqual([false]);
  });
});
