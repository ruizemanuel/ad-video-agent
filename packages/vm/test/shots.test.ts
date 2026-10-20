import type { Block, CaptureLog, Shot } from '@app/core';
import { describe, expect, it } from 'vitest';
import { addBlocks, MAX_BLOCKS_PER_SHOT, MAX_DIRECTOR_IMAGES, pngSize, shotsForDirector } from '../src/capture/shots';

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

  it('are at most 20: those of the main page first, then those of the extra pages in their order', () => {
    const phone = (ids: string[]) => ids.map((id) => shot(id, 'mobile', id.split('-').at(-1)));
    const extra1 = phone(Array.from({ length: 8 }, (_, k) => `x1-m-s${100 + k}`));
    const main = phone(Array.from({ length: 15 }, (_, k) => `m-s${k + 1}`));
    const extra2 = phone(Array.from({ length: 5 }, (_, k) => `x2-m-s${200 + k}`));

    const picked = shotsForDirector([...extra1, ...main, ...extra2]).map((s) => s.id);

    expect(MAX_DIRECTOR_IMAGES).toBe(20);
    expect(picked).toEqual([...main.map((s) => s.id), ...extra1.slice(0, 5).map((s) => s.id)]);
  });

  it('keeps the main page whole when it alone has more than 20, and leaves the extra pages out', () => {
    const main = Array.from({ length: 24 }, (_, k) => shot(`m-s${k + 1}`, 'mobile', `s${k + 1}`));
    const picked = shotsForDirector([...main, shot('x1-m-s99', 'mobile', 's99')]).map((s) => s.id);
    expect(picked).toEqual(main.slice(0, 20).map((s) => s.id));
  });
});

describe('the blocks of a shot', () => {
  const log = (): CaptureLog => ({ startedAt: '2026-10-19T00:00:00.000Z', notes: [], timings: {} });
  const found = (n: number) => Array.from({ length: n }, (_, k) => ({ x: 64, y: 100 * k, w: 652, h: 128 }));

  it('are added to the site with the shot they belong to, in the order the page gave them', () => {
    const site: { blocks?: Block[] } = {};
    const notes = log();
    addBlocks(site, 'm-s2', found(2), notes);
    addBlocks(site, 'm-full', found(1), notes);
    expect(site.blocks).toEqual([
      { shotId: 'm-s2', x: 64, y: 0, w: 652, h: 128 },
      { shotId: 'm-s2', x: 64, y: 100, w: 652, h: 128 },
      { shotId: 'm-full', x: 64, y: 0, w: 652, h: 128 },
    ]);
    expect(notes.notes).toEqual([]);
  });

  it('are at most 200 per shot, the first ones in document order, and the log says when there were more', () => {
    const site: { blocks?: Block[] } = { blocks: [] };
    const notes = log();
    addBlocks(site, 'd-full', found(203), notes);
    expect(MAX_BLOCKS_PER_SHOT).toBe(200);
    expect(site.blocks).toHaveLength(200);
    expect(site.blocks?.at(-1)).toEqual({ shotId: 'd-full', x: 64, y: 19_900, w: 652, h: 128 });
    expect(notes.notes).toEqual(['d-full: 203 blocks found, the first 200 kept']);
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
