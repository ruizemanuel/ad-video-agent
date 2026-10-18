import type { Shot } from '@app/core';
import { describe, expect, it } from 'vitest';
import { pngSize, shotsForDirector } from '../src/capture/shots';

const shot = (id: string, viewport: Shot['viewport'], sectionId?: string): Shot => ({
  id,
  file: `media/${id}.png`,
  viewport,
  dpr: 2,
  ...(sectionId ? { sectionId } : {}),
  width: 780,
  height: 1688,
});

describe('the pictures for the director', () => {
  it('are the shots of the phone, of the main page and of the extra pages, but not the full-page ones', () => {
    const shots = [
      shot('d-s2', 'desktop', 's2'),
      shot('d-full', 'desktop'),
      shot('m-s2', 'mobile', 's2'),
      shot('m-s3', 'mobile', 's3'),
      shot('m-full', 'mobile'),
      shot('x1-d-s12', 'desktop', 's12'),
      shot('x1-m-s12', 'mobile', 's12'),
      shot('x1-m-full', 'mobile'),
    ];

    expect(shotsForDirector(shots).map((s) => s.id)).toEqual(['m-s2', 'm-s3', 'x1-m-s12']);
  });
});

describe('the size of a PNG', () => {
  /** The signature and the start of the IHDR chunk of a PNG of this size. */
  const header = (width: number, height: number): Buffer => {
    const png = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8);
    png.write('IHDR', 12, 'ascii');
    png.writeUInt32BE(width, 16);
    png.writeUInt32BE(height, 20);
    return png;
  };

  it('reads the width and height from the header', () => {
    expect(pngSize(header(5760, 264))).toEqual({ width: 5760, height: 264 });
    expect(pngSize(header(480, 160))).toEqual({ width: 480, height: 160 });
  });

  it('reads nothing from what is not a PNG', () => {
    expect(pngSize(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(pngSize(Buffer.alloc(10))).toBeNull();
  });
});
