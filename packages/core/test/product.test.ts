import { describe, expect, it } from 'vitest';
import { blockOf, isProductTarget, type Block, type Box, type SiteData } from '../src/index';

const SHOT = 'm-s7';
const box = (kind: Box['kind'], x: number, y: number, w: number, h: number, extra: Partial<Box> = {}): Box => ({ shotId: SHOT, kind, x, y, w, h, ...extra });
const block = (x: number, y: number, w: number, h: number, shotId = SHOT): Block => ({ shotId, x, y, w, h });

const site = (boxes: Box[], blocks?: Block[]): SiteData => ({
  url: 'https://tiendita.example',
  lang: 'es',
  title: 'Tiendita',
  description: '',
  sections: [],
  brand: { colors: [], fonts: [] },
  shots: [{ id: SHOT, file: 'media/m-s7.png', viewport: 'mobile', dpr: 2, sectionId: 's7', width: 780, height: 1688 }],
  boxes,
  ...(blocks ? { blocks } : {}),
  recordings: [],
});

describe('blockOf', () => {
  const small = block(100, 100, 300, 300);
  const big = block(0, 0, 780, 1200);

  it('is the smallest block of the shot that holds the center of the box', () =>
    expect(blockOf([big, small], SHOT, { x: 150, y: 150, w: 100, h: 100 })).toBe(small));

  it('does not mind the order the blocks come in', () => expect(blockOf([small, big], SHOT, { x: 150, y: 150, w: 100, h: 100 })).toBe(small));

  it('is the outer block for a box whose center is out of the inner one', () => expect(blockOf([big, small], SHOT, { x: 380, y: 380, w: 100, h: 100 })).toBe(big));

  it('counts the edges of a block as inside it', () => expect(blockOf([small], SHOT, { x: 350, y: 350, w: 100, h: 100 })).toBe(small));

  it('ignores the blocks of other shots', () => expect(blockOf([block(0, 0, 780, 1200, 'm-s8')], SHOT, { x: 150, y: 150, w: 100, h: 100 })).toBeUndefined());

  it('keeps the first of two blocks of the same size', () => {
    const twin = block(100, 100, 300, 300);
    expect(blockOf([small, twin], SHOT, { x: 150, y: 150, w: 100, h: 100 })).toBe(small);
  });

  it('is undefined when no block holds the center, or there are none', () => {
    expect(blockOf([small], SHOT, { x: 500, y: 500, w: 100, h: 100 })).toBeUndefined();
    expect(blockOf([], SHOT, { x: 150, y: 150, w: 100, h: 100 })).toBeUndefined();
  });
});

describe('isProductTarget: the section of the target', () => {
  it('is false for a heading whose section has only text', () =>
    expect(isProductTarget(site([box('heading', 56, 200, 600, 100, { sectionId: 's7', text: 'Cobrás como querés' })]), SHOT, 0)).toBe(false));

  it.each(['image', 'price'] as const)('is true for a heading whose section has %s', (kind) =>
    expect(isProductTarget(site([box('heading', 56, 200, 600, 100, { sectionId: 's7' }), box(kind, 56, 900, 600, 400, { sectionId: 's7' })]), SHOT, 0)).toBe(true));

  it('is false when the only product box is in another section', () =>
    expect(isProductTarget(site([box('heading', 56, 200, 600, 100, { sectionId: 's7' }), box('image', 56, 900, 600, 400, { sectionId: 's8' })]), SHOT, 0)).toBe(false));

  it('is false for a heading whose section has only a cta: a button over text is marketing', () =>
    expect(isProductTarget(site([box('heading', 56, 200, 600, 100, { sectionId: 's7' }), box('cta', 56, 400, 300, 100, { sectionId: 's7' })]), SHOT, 0)).toBe(false));

  it('is true for a cta of a section that has an image', () =>
    expect(isProductTarget(site([box('cta', 56, 400, 300, 100, { sectionId: 's7' }), box('image', 56, 900, 600, 400, { sectionId: 's7' })]), SHOT, 0)).toBe(true));

  it('counts the target itself when it is an image or a price', () => {
    expect(isProductTarget(site([box('image', 56, 900, 600, 400, { sectionId: 's7' })]), SHOT, 0)).toBe(true);
    expect(isProductTarget(site([box('price', 56, 900, 300, 80, { sectionId: 's7', text: '$4.990' })]), SHOT, 0)).toBe(true);
  });

  it('counts an image or a price of the same shot only: the boxes of other shots do not make product UI', () => {
    const boxes = [box('heading', 56, 200, 600, 100, { sectionId: 's7' }), box('image', 56, 900, 600, 400, { sectionId: 's7', shotId: 'm-s8' })];
    expect(isProductTarget(site(boxes), SHOT, 0)).toBe(false);
  });

  it('numbers the target as boxIndex counts: among the boxes of its shot', () => {
    const boxes = [
      box('image', 0, 0, 600, 400, { sectionId: 's6', shotId: 'm-s6' }),
      box('heading', 56, 200, 600, 100, { sectionId: 's7' }),
      box('cta', 56, 400, 300, 100, { sectionId: 's7' }),
    ];
    // Box 0 of m-s7 is the heading: the image of m-s6 is not in its shot.
    expect(isProductTarget(site(boxes), SHOT, 0)).toBe(false);
    expect(isProductTarget(site(boxes), SHOT, 1)).toBe(false);
    expect(isProductTarget(site([...boxes, box('price', 56, 600, 300, 80, { sectionId: 's7' })]), SHOT, 1)).toBe(true);
  });

  it('is false for a box that is not there, or a shot that is not there', () => {
    const boxes = [box('image', 56, 900, 600, 400, { sectionId: 's7' })];
    expect(isProductTarget(site(boxes), SHOT, 1)).toBe(false);
    expect(isProductTarget(site(boxes), SHOT, -1)).toBe(false);
    expect(isProductTarget(site(boxes), 'm-s9', 0)).toBe(false);
  });
});

describe('isProductTarget: a box with no section', () => {
  it('has no section to share: an image with no section does not make a heading with no section product UI', () =>
    expect(isProductTarget(site([box('heading', 56, 200, 600, 100), box('image', 56, 900, 600, 400)]), SHOT, 0)).toBe(false));

  it('is not made product UI by an image of a section either', () =>
    expect(isProductTarget(site([box('heading', 56, 200, 600, 100), box('image', 56, 900, 600, 400, { sectionId: 's7' })]), SHOT, 0)).toBe(false));

  it('is decided by its block alone', () => {
    const boxes = [box('heading', 56, 200, 600, 100), box('image', 56, 330, 600, 400, { sectionId: 's7' })];
    expect(isProductTarget(site(boxes, [block(40, 150, 700, 700)]), SHOT, 0)).toBe(true);
    expect(isProductTarget(site(boxes, [block(40, 150, 700, 100)]), SHOT, 0)).toBe(false);
  });

  it('is product UI when it is itself an image or a price', () => {
    expect(isProductTarget(site([box('image', 56, 900, 600, 400)]), SHOT, 0)).toBe(true);
    expect(isProductTarget(site([box('price', 56, 900, 300, 80, { text: '$4.990' })]), SHOT, 0)).toBe(true);
  });
});

describe('isProductTarget: the block of the target', () => {
  // A heading in one section and a picture in another.
  const heading = box('heading', 80, 300, 600, 100, { sectionId: 's7', text: 'Cobrás como querés' });
  const picture = box('image', 80, 700, 600, 400, { sectionId: 's8' });

  it('is true for a heading inside a block that also holds an image of another section', () =>
    expect(isProductTarget(site([heading, picture], [block(40, 250, 700, 1000)]), SHOT, 0)).toBe(true));

  it('is false when the image is outside the block of the heading', () =>
    expect(isProductTarget(site([heading, picture], [block(40, 250, 700, 250)]), SHOT, 0)).toBe(false));

  it('is true for a price inside the block', () =>
    expect(isProductTarget(site([heading, box('price', 100, 450, 200, 60, { sectionId: 's8', text: '$4.990' })], [block(40, 250, 700, 400)]), SHOT, 0)).toBe(true));

  it('does not count a cta inside the block', () =>
    expect(isProductTarget(site([heading, box('cta', 100, 450, 200, 60, { sectionId: 's8' })], [block(40, 250, 700, 400)]), SHOT, 0)).toBe(false));

  it('goes by the center of the image: a picture that only reaches into the block is out', () => {
    // The picture starts at y 700 and is 400 tall: its center is at 900.
    expect(isProductTarget(site([heading, picture], [block(40, 250, 700, 500)]), SHOT, 0)).toBe(false);
    expect(isProductTarget(site([heading, picture], [block(40, 250, 700, 650)]), SHOT, 0)).toBe(true);
  });

  it('takes the smallest block that holds the center of the target: a text card nested in a bigger block with a picture is marketing', () => {
    const outer = block(40, 250, 700, 1000);
    const card = block(60, 280, 660, 200);
    expect(isProductTarget(site([heading, picture], [outer, card]), SHOT, 0)).toBe(false);
    expect(isProductTarget(site([heading, picture], [card, outer]), SHOT, 0)).toBe(false);
  });

  it('takes the smallest block even when it is the one that holds the picture', () => {
    const outer = block(40, 250, 700, 1000);
    const card = block(60, 280, 660, 900);
    expect(isProductTarget(site([heading, picture], [outer, card]), SHOT, 0)).toBe(true);
  });

  it('ignores the blocks of other shots', () =>
    expect(isProductTarget(site([heading, picture], [block(40, 250, 700, 1000, 'm-s8')]), SHOT, 0)).toBe(false));

  it('lets the section rule decide when the capture has no blocks', () => {
    expect(isProductTarget(site([heading, picture]), SHOT, 0)).toBe(false);
    expect(isProductTarget(site([heading, { ...picture, sectionId: 's7' }]), SHOT, 0)).toBe(true);
  });

  it('is true by the section even when the card around the heading holds no picture', () =>
    expect(isProductTarget(site([heading, { ...picture, sectionId: 's7' }], [block(60, 280, 660, 200)]), SHOT, 0)).toBe(true));
});
