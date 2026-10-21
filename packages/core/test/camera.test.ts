import { blockOf, FORMATS, type Block, type Box, type Format, type Scene, type Shot, type SiteData } from '../src/index';
import { describe, expect, it } from 'vitest';
import {
  cameraAt,
  focusCamera,
  focusLanding,
  focusMove,
  focusRegion,
  focusShot,
  framesCleanly,
  placeShot,
  resolveShot,
  scrollLanding,
  scrollMove,
  scrollShot,
  stageLayout,
  type Camera,
} from '../src/camera';

const shot = (id: string, viewport: Shot['viewport'], height: number, sectionId?: string): Shot => ({
  id,
  file: `media/${id}.png`,
  viewport,
  dpr: 2,
  ...(sectionId ? { sectionId } : {}),
  width: viewport === 'mobile' ? 780 : 2880,
  height,
});

const box = (shotId: string, kind: Box['kind'], text: string, x: number, y: number, w: number, h: number): Box => ({ shotId, kind, text, x, y, w, h });
const block = (shotId: string, x: number, y: number, w: number, h: number): Block => ({ shotId, x, y, w, h });

const site = (shots: Shot[], boxes: Box[], blocks?: Block[]): SiteData => ({
  url: 'https://tiendita.example',
  lang: 'en',
  title: 'Tiendita',
  description: '',
  sections: [],
  brand: { colors: [], fonts: [] },
  shots,
  boxes,
  ...(blocks ? { blocks } : {}),
  recordings: [],
});

const uiScene = (piece: 'UiFocus' | 'UiScroll', shotId: string, boxIndex?: number): Scene => ({
  piece,
  beats: 6,
  lines: [{ text: 'Your shop in one link', kind: 'framing' }],
  shotId,
  ...(boxIndex === undefined ? {} : { boxIndex }),
});

// A phone screen, a phone page and a desktop page, as the capture takes them (DPR 2).
const phoneScreen = shot('m-s2', 'mobile', 1688, 's2');
const phonePage = shot('m-full', 'mobile', 6000);
const desktopPage = shot('d-full', 'desktop', 4000);

/** Where a point of the shot lands in the frame, with the camera there. */
const inFrame = (target: Shot, at: { x: number; y: number }, camera: ReturnType<typeof focusCamera>, boxes: Box[], format: '9x16' | '16x9' | '4x5' = '9x16') => {
  const stage = stageLayout(format);
  const placed = placeShot(target, camera, format, boxes);
  return { x: stage.cardLeft + placed.x + at.x * placed.scale, y: stage.cardTop + placed.y + at.y * placed.scale };
};

/**
 * The part of the shot the card shows above the platform UI, with the camera there: its top and bottom, in shot pixels;
 * and `end`, where the bottom edge of the frame falls on the shot (the card runs on under the platform UI to it).
 */
const viewOf = (target: Shot, camera: Camera, boxes: Box[], format: '9x16' | '16x9' | '4x5' = '9x16') => {
  const placed = placeShot(target, camera, format, boxes);
  const top = -placed.y / placed.scale;
  const stage = stageLayout(format);
  return { top, bottom: top + (2 * stage.focusY) / placed.scale, end: top + stage.cardH / placed.scale };
};
// A view that comes back from placeShot is off by float noise (562.0000000000001 for a top flush on 562).
const EPS = 1e-6;
/** Whether the top edge of the view cuts through the region: one the capture clipped at the top of its shot goes on above it. */
const slices = (view: { top: number }, r: { y: number; h: number; clippedTop?: true }): boolean =>
  (r.clippedTop === true || r.y < view.top - EPS) && r.y + r.h > view.top + EPS;
const shows = (view: { top: number; bottom: number }, r: { y: number; h: number }): boolean => r.y >= view.top - EPS && r.y + r.h <= view.bottom + EPS;
/** Whether the bottom edge of the frame cuts through the region (a box never runs past the end of its shot). */
const slicesEnd = (view: { end: number }, r: { y: number; h: number }): boolean => r.y < view.end - EPS && r.y + r.h > view.end + EPS;

describe('the camera on a UI shot', () => {
  it('never zooms a phone shot past 1.12x', () => {
    const price = box('m-s2', 'price', '$ 4.500', 244, 700, 212, 40);
    const camera = focusCamera(price, phoneScreen, '9x16', [price]);
    expect(camera.scale).toBeLessThanOrEqual(1.12);
    // A small target is zoomed in as far as a phone allows, and no further.
    expect(camera.scale).toBeCloseTo(1.12);
  });

  it('aims a heading at the block it titles (4x its height)', () => {
    const heading = box('m-full', 'heading', 'Why Tiendita', 56, 2000, 668, 166);
    expect(focusRegion(heading).h).toBe(4 * heading.h);
    // The block starts a little above the heading and runs down under it: its middle is 1.4 headings below the heading's top.
    expect(focusCamera(heading, phonePage, '9x16', [heading]).y).toBeCloseTo(heading.y + 1.4 * heading.h);
    // Other boxes are aimed at as they are.
    const cta = box('m-full', 'cta', 'Start free', 56, 3000, 400, 100);
    expect(focusRegion(cta)).toEqual(cta);
  });

  it('keeps the target above the 9x16 platform UI', () => {
    const { height, safe } = FORMATS['9x16'];
    const low = box('m-s2', 'price', '$ 4.500', 244, 1500, 212, 40);
    const sameOnPage = box('m-full', 'price', '$ 4.500', 244, 3300, 212, 40);
    const boxes = [low, sameOnPage];
    const center = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

    // On the phone screen the target sits near the bottom: the shot would end first, and the target would sink under the UI.
    expect(inFrame(phoneScreen, center(low), focusCamera(low, phoneScreen, '9x16', boxes), boxes).y).toBeGreaterThan(height - safe.bottom);

    // So UiFocus takes the full page of the same viewport, where the same element can be centered.
    const picked = focusShot(site([phoneScreen, phonePage], boxes), uiScene('UiFocus', 'm-s2', 0), '9x16');
    expect(picked.shot.id).toBe('m-full');
    expect(picked.box).toEqual(sameOnPage);
    const landed = inFrame(picked.shot, center(sameOnPage), focusCamera(sameOnPage, picked.shot, '9x16', boxes), boxes);
    expect(landed.y).toBeLessThanOrEqual(height - safe.bottom);
    // It lands in the middle of the part of the card that the platform UI leaves visible.
    const stage = stageLayout('9x16');
    expect(landed.y).toBeCloseTo(stage.cardTop + stage.focusY);
    expect((stage.cardTop + height - safe.bottom) / 2).toBeCloseTo(stage.cardTop + stage.focusY);
  });

  it('keeps the one-screen shot when it leaves room to center the target', () => {
    const middle = box('m-s2', 'price', '$ 4.500', 244, 600, 212, 40);
    const sameOnPage = box('m-full', 'price', '$ 4.500', 244, 2400, 212, 40);
    const picked = focusShot(site([phoneScreen, phonePage], [middle, sameOnPage]), uiScene('UiFocus', 'm-s2', 0), '9x16');
    expect(picked).toEqual({ shot: phoneScreen, box: middle });
  });

  it('frames the central 78% of a desktop shot', () => {
    // With no boxes to tell where the page's content is, the camera leaves out the container's margins.
    const target = box('d-full', 'cta', 'Start free', 1300, 1800, 280, 80);
    const { from } = focusMove(target, desktopPage, '16x9', []);
    const stage = stageLayout('16x9');
    const placed = placeShot(desktopPage, from, '16x9', []);
    const left = -placed.x / placed.scale;
    const right = (stage.cardW - placed.x) / placed.scale;
    expect(left).toBeCloseTo(0.11 * desktopPage.width);
    expect(right).toBeCloseTo(0.89 * desktopPage.width);
  });

  it('frames the content of a desktop page, not its gutters, when the boxes show where it is', () => {
    // A store that is one phone-wide column even on desktop: the camera frames the column (padded by 8% of it).
    const column = [box('d-full', 'heading', 'Demo shop', 960, 300, 960, 120), box('d-full', 'price', '$ 4.990', 1000, 900, 300, 60)];
    const stage = stageLayout('16x9');
    const placed = placeShot(desktopPage, focusMove(column[1], desktopPage, '16x9', column).from, '16x9', column);
    expect(-placed.x / placed.scale).toBeCloseTo(960 - 0.08 * 960);
    expect((stage.cardW - placed.x) / placed.scale).toBeCloseTo(1920 + 0.08 * 960);
  });

  it('starts wide and a little above the target, and eases the zoom in on the way down to it', () => {
    const price = box('m-full', 'price', '$ 4.500', 244, 2400, 212, 40);
    const move = focusMove(price, phonePage, '9x16', [price]);
    expect(move.from.scale).toBe(1);
    // The camera travels down the page, so the page moves up into place, the same way as the card it is in rises.
    expect(move.from.y).toBeLessThan(move.to.y);
    const center = { x: price.x + price.w / 2, y: price.y + price.h / 2 };
    expect(inFrame(phonePage, center, move.from, [price]).y).toBeGreaterThan(inFrame(phonePage, center, move.to, [price]).y);
    expect(cameraAt(move, 0)).toEqual(move.from);
    expect(cameraAt(move, 1)).toEqual(move.to);
    // The zoom grows by the same factor in each step of the way (it reads as a steady push in), the pan in equal steps.
    const half = cameraAt(move, 0.5);
    expect(half.scale).toBeCloseTo(Math.sqrt(move.to.scale));
    expect(half.y).toBeCloseTo((move.from.y + move.to.y) / 2);
  });

  it('never shows past the edges of the shot', () => {
    const top = box('m-full', 'cta', 'Start free', 56, 20, 400, 100);
    const placed = placeShot(phonePage, focusCamera(top, phonePage, '9x16', [top]), '9x16', [top]);
    expect(placed.y).toBe(0);
    const stage = stageLayout('9x16');
    const bottom = box('m-full', 'cta', 'Create your shop', 56, 5950, 400, 40);
    const atEnd = placeShot(phonePage, focusCamera(bottom, phonePage, '9x16', [bottom]), '9x16', [bottom]);
    expect(atEnd.y + phonePage.height * atEnd.scale).toBeCloseTo(stage.cardH);
  });

  it('never leaves a heading cut by the top edge of the card', () => {
    const price = box('m-full', 'price', '$ 4.990 / mes', 244, 3000, 212, 40);
    // Where the view would start without the rule: right through this heading.
    const heading = box('m-full', 'heading', 'Simple pricing', 56, 2600, 668, 100);
    const boxes = [price, heading];
    const stage = stageLayout('9x16');
    const { to } = scrollMove(price, phonePage, '9x16', boxes);
    const scale = placeShot(phonePage, to, '9x16', boxes).scale;
    const viewTop = to.y - stage.focusY / scale;
    expect(viewTop <= heading.y || viewTop >= heading.y + heading.h).toBe(true);
    // And the target is still in view.
    expect(price.y).toBeGreaterThanOrEqual(viewTop);
    expect(price.y + price.h).toBeLessThanOrEqual(viewTop + (2 * stage.focusY) / scale);
  });
});

describe('the camera of a scroll', () => {
  it('glides down a page at one scale, from its top to the target', () => {
    const price = box('m-full', 'price', '$ 4.990 / mes', 244, 3000, 212, 40);
    const move = scrollMove(price, phonePage, '9x16', [price]);
    expect(move.from.scale).toBe(1);
    expect(move.to.scale).toBe(1);
    expect(placeShot(phonePage, move.from, '9x16', [price]).y).toBe(0);
    expect(move.to.y).toBeCloseTo(price.y + price.h / 2);
  });

  it('lands mid-page when it has no target', () => {
    const move = scrollMove(undefined, phonePage, '9x16', []);
    expect(move.to.y).toBeGreaterThan(move.from.y);
    const stage = stageLayout('9x16');
    const placed = placeShot(phonePage, move.to, '9x16', []);
    expect(placed.y + phonePage.height * placed.scale).toBeGreaterThanOrEqual(stage.cardH);
  });

  it('scrolls the full page of the viewport the format wants', () => {
    const heading = box('m-s2', 'heading', 'Why Tiendita', 56, 300, 668, 166);
    const onDesktopPage = box('d-full', 'heading', 'Why Tiendita', 400, 1800, 1400, 120);
    const all = site([phoneScreen, phonePage, desktopPage], [heading, onDesktopPage]);
    expect(scrollShot(all, uiScene('UiScroll', 'm-s2', 0), '9x16').shot.id).toBe('m-full');
    expect(scrollShot(all, uiScene('UiScroll', 'm-s2', 0), '16x9')).toEqual({ shot: desktopPage, box: onDesktopPage });
  });
});

describe('the camera on a page with cards', () => {
  // A card of a feature grid on the phone page, with its heading near its top, and the card before it in the grid. At
  // the phone's base scale (960 / 780 card px per shot px) the card shows 760.5 shot px above the platform UI.
  const card = block('m-full', 40, 2600, 700, 500);
  const heading = box('m-full', 'heading', 'Get paid your way', 80, 2640, 400, 60);
  const above = block('m-full', 40, 2100, 700, 420);

  it('aims a heading inside a card at the whole card, and opens above it', () => {
    const move = focusMove(heading, phonePage, '9x16', [heading], [card]);
    expect(move.to.y).toBeCloseTo(card.y + card.h / 2);
    expect(shows(viewOf(phonePage, move.to, [heading]), card)).toBe(true);
    expect(move.from.y).toBeLessThan(move.to.y);
  });

  it('opens above where it lands even when it lands higher, to show the card above whole', () => {
    const target = block('m-full', 40, 2600, 700, 300);
    const title = box('m-full', 'heading', 'Get paid your way', 80, 2630, 400, 60);
    // Sliced in its upper half: showing it whole is the smaller move, and it lifts the landing more than the opening drop.
    const before = block('m-full', 40, 2200, 700, 360);
    const move = focusMove(title, phonePage, '9x16', [title], [before, target]);
    expect(viewOf(phonePage, move.to, [title]).top).toBeLessThanOrEqual(before.y);
    expect(move.from.y).toBeLessThan(move.to.y);
    // The page moves up into place, the same way as the card rises.
    const center = { x: title.x + title.w / 2, y: title.y + title.h / 2 };
    expect(inFrame(phonePage, center, move.from, [title]).y).toBeGreaterThan(inFrame(phonePage, center, move.to, [title]).y);
  });

  it('scrolls in the same length wherever the top edge rule puts the landing', () => {
    const plain = focusMove(heading, phonePage, '9x16', [heading], [card]);
    const pushed = focusMove(heading, phonePage, '9x16', [heading], [above, card]);
    // The card above was pushed out of view: the landing is lower than the card's center.
    expect(pushed.to.y).toBeGreaterThan(plain.to.y);
    expect(pushed.to.y - pushed.from.y).toBeCloseTo(plain.to.y - plain.from.y);
  });

  it('aims at a card only when it also fits the width of the card, else at the heading as before', () => {
    // A desktop page whose content is a column in the middle: the base framing fills the card with that column.
    const title = box('d-full', 'heading', 'Get paid your way', 1000, 1800, 800, 80);
    const button = box('d-full', 'cta', 'Start free', 960, 2500, 960, 80);
    const boxes = [title, button];
    const narrow = block('d-full', 980, 1760, 900, 400);
    expect(focusCamera(title, desktopPage, '16x9', boxes, [narrow]).y).toBeCloseTo(narrow.y + narrow.h / 2);
    // As tall, but wider than the card at the landing scale: its sides would be cut.
    const wide = block('d-full', 400, 1760, 2080, 400);
    expect(focusCamera(title, desktopPage, '16x9', boxes, [wide])).toEqual(focusCamera(title, desktopPage, '16x9', boxes));
  });

  it('takes the smallest card of the same shot that holds the target', () => {
    const panel = block('m-full', 20, 2560, 740, 640);
    const next = block('m-full', 40, 3140, 700, 400);
    const otherShot = block('m-s2', 40, 2620, 700, 200);
    expect(focusCamera(heading, phonePage, '9x16', [heading], [panel, card, next, otherShot]).y).toBeCloseTo(card.y + card.h / 2);
  });

  it('aims at the heading as before when its card is taller than 90% of what the card shows', () => {
    // 684 shot px fit in 90% of the visible part at the base scale; 688 do not.
    const fits = { ...card, h: 684 };
    expect(focusCamera(heading, phonePage, '9x16', [heading], [fits]).y).toBeCloseTo(fits.y + fits.h / 2);
    const tall = { ...card, h: 688 };
    expect(focusCamera(heading, phonePage, '9x16', [heading], [tall])).toEqual(focusCamera(heading, phonePage, '9x16', [heading]));
    expect(focusCamera(heading, phonePage, '9x16', [heading], [tall]).y).toBeCloseTo(heading.y + 1.4 * heading.h);
  });

  it('never leaves the card above sliced by the top edge, and keeps the card it aims at in view', () => {
    // Where the view would start without the rule: through the last lines of the card above.
    expect(slices(viewOf(phonePage, focusCamera(heading, phonePage, '9x16', [heading], [card]), [heading]), above)).toBe(true);
    const view = viewOf(phonePage, focusCamera(heading, phonePage, '9x16', [heading], [above, card]), [heading]);
    expect(slices(view, above)).toBe(false);
    expect(shows(view, card)).toBe(true);
  });

  it('lands a scroll on the card the target is in, with the card above out of the top edge', () => {
    // Without cards it lands on the target itself, as it always has.
    expect(scrollMove(heading, phonePage, '9x16', [heading]).to.y).toBeCloseTo(heading.y + heading.h / 2);
    expect(scrollMove(heading, phonePage, '9x16', [heading], [card]).to.y).toBeCloseTo(card.y + card.h / 2);
    const { to } = scrollMove(heading, phonePage, '9x16', [heading], [above, card]);
    expect(to.scale).toBe(1);
    const view = viewOf(phonePage, to, [heading]);
    expect(slices(view, above)).toBe(false);
    expect(shows(view, card)).toBe(true);
  });

  it('checks the new top again: a move that clears one card but cuts a heading goes on to clear that too', () => {
    const target = block('m-full', 40, 2650, 700, 300);
    const title = box('m-full', 'heading', 'Get paid your way', 80, 2680, 400, 60);
    const before = block('m-full', 40, 2100, 700, 340);
    // Pushing the card before out of view puts the top edge through this label.
    const label = box('m-full', 'heading', 'Step two', 56, 2450, 668, 50);
    const boxes = [label, title];
    const view = viewOf(phonePage, focusCamera(title, phonePage, '9x16', boxes, [before, target]), boxes);
    expect(slices(view, before)).toBe(false);
    expect(slices(view, label)).toBe(false);
    expect(shows(view, target)).toBe(true);
  });

  it('lets a panel around the card it aims at run past the top edge, and clears the card above', () => {
    const panel = block('m-full', 20, 1800, 740, 1500);
    const view = viewOf(phonePage, focusCamera(heading, phonePage, '9x16', [heading], [panel, above, card]), [heading]);
    expect(slices(view, panel)).toBe(true);
    expect(slices(view, above)).toBe(false);
    expect(shows(view, card)).toBe(true);
  });

  it('takes the full page when the card it aims at cannot be centered in the one-screen shot', () => {
    const onScreen = box('m-s2', 'heading', 'Get paid your way', 80, 700, 400, 60);
    const onPage = box('m-full', 'heading', 'Get paid your way', 80, 2700, 400, 60);
    const boxes = [onScreen, onPage];
    // The heading alone can be centered on the phone screen...
    expect(focusShot(site([phoneScreen, phonePage], boxes), uiScene('UiFocus', 'm-s2', 0), '9x16').shot.id).toBe('m-s2');
    // ...but not the card it is in, which runs on lower: the shot would end first.
    const cards = [block('m-s2', 40, 680, 700, 600), block('m-full', 40, 2680, 700, 600)];
    expect(focusShot(site([phoneScreen, phonePage], boxes, cards), uiScene('UiFocus', 'm-s2', 0), '9x16')).toEqual({ shot: phonePage, box: onPage });
  });
});

describe('the camera near the end of a shot', () => {
  // placeShot never shows past the bottom of a shot: a landing near its end is pulled up until the shot fills the card,
  // so the view the frame shows starts higher than the one the camera aimed at. Every view here is the one placeShot
  // really shows (see viewOf), and so is every slice.
  const formats = ['9x16', '4x5', '16x9'] as const;
  const pieces = ['UiFocus', 'UiScroll'] as const;
  const moveOf = (piece: (typeof pieces)[number]) => (piece === 'UiFocus' ? focusMove : scrollMove);
  const nothingSliced = (view: { top: number }, regions: readonly { y: number; h: number }[]) => regions.filter((r) => slices(view, r));

  for (const format of formats) {
    for (const piece of pieces) {
      it(`${piece} in ${format}: the end of the shot pulls the view up, and the top edge of that view still slices nothing`, () => {
        const desktop = format === '16x9';
        const page = shot(desktop ? 'd-full' : 'm-full', desktop ? 'desktop' : 'mobile', 3000);
        // The content is a column x..x+w: on a desktop page its boxes tell the camera so, and it fills the card's width.
        const [x, w] = desktop ? [400, 2080] : [40, 700];
        const stage = stageLayout(format);
        const scale = placeShot(page, { scale: 1, x: 0, y: 0 }, format, [box(page.id, 'heading', '', x, 0, w, 10), box(page.id, 'heading', '', x, 0, w, 10)]).scale;
        const visible = (2 * stage.focusY) / scale;
        // The lowest the top of the view can go: there the shot ends at the bottom of the card.
        const lowest = page.height - stage.cardH / scale;
        // A card that ends 80 px above the platform UI when the view is that low: it can be shown whole, but not held at
        // the focus point.
        const card = block(page.id, x, lowest + visible - 80 - 240, w, 240);
        const title = box(page.id, 'heading', 'Get paid your way', x, card.y + 30, w, 60);
        // A label right where the end of the shot pulls the top edge up to.
        const label = box(page.id, 'heading', 'Popular', x, lowest - 20, w, 40);
        const boxes = [label, title];
        // Aimed at the card's center, the top edge would be under the label: measured there, there is nothing to clear.
        expect(card.y + card.h / 2 - stage.focusY / scale).toBeGreaterThan(label.y + label.h + 60);

        const move = moveOf(piece)(title, page, format, boxes, [card]);
        const view = viewOf(page, move.to, boxes, format);
        expect(placeShot(page, move.to, format, boxes).scale).toBeCloseTo(scale);
        expect(nothingSliced(view, [label, title, card])).toEqual([]);
        expect(shows(view, card)).toBe(true);
        // The camera lands where the view is: placeShot does not have to pull it up.
        expect(view.top).toBeCloseTo(move.to.y - stage.focusY / scale);
        if (piece === 'UiFocus') {
          // So the scroll-in the frame shows is as long as the camera's, and goes down the page.
          expect(move.to.y - move.from.y).toBeGreaterThan(0);
          expect(view.top - viewOf(page, move.from, boxes, format).top).toBeCloseTo(move.to.y - move.from.y);
        }
      });
    }
  }

  // The demo store of paid run 5 (cobrame.app's demo page, 9x16): a column of product cards that ends 79 px above the end
  // of the phone page, each with its price and button in a box along its bottom. In 9x16 the card runs 420 px under the
  // platform UI, so the last 341 px of a phone page never get above it.
  const storePage = shot('x1-m-full', 'mobile', 3072);
  const storeCards = [
    block('x1-m-full', 32, 562, 716, 719),
    block('x1-m-full', 32, 1312, 716, 719),
    block('x1-m-full', 32, 2063, 716, 274),
    block('x1-m-full', 32, 2368, 716, 274),
    block('x1-m-full', 32, 2674, 716, 319),
  ];
  const priceRow = (shotId: string, sectionId: string, text: string, y: number): Box => ({ shotId, sectionId, kind: 'price', text, x: 66, y, w: 648, h: 80 });
  const storePrices = [
    priceRow('x1-m-full', 's14', '$ 4.500 Agregar', 1166),
    priceRow('x1-m-full', 's15', '$ 8.900 Agregar', 1917),
    priceRow('x1-m-full', 's16', '$ 3.000 Agregar', 2222),
    priceRow('x1-m-full', 's18', '$ 15.000 Pedir', 2879),
  ];

  it('scrolls to the last card of a short page with the top edge clean, though that card cannot get above the platform UI', () => {
    const last = storePrices[3]!;
    const { from, to } = scrollMove(last, storePage, '9x16', storePrices, storeCards);
    const view = viewOf(storePage, to, storePrices);
    // Run 5's body[0]: the camera aimed below the second card, and the end of the page pulled the view up through its price.
    expect(nothingSliced(view, [...storeCards, ...storePrices])).toEqual([]);
    expect(view.top).toBeCloseTo(to.y - stageLayout('9x16').focusY / placeShot(storePage, to, '9x16', storePrices).scale);
    expect(to.y).toBeGreaterThan(from.y);
  });

  it('frames the full page it takes from a one-screen shot with the top edge clean', () => {
    // The phone screen of s15: the same store, 1384 px down the page, from the bottom of s15's picture to below s18's price.
    const screen = shot('x1-m-s15', 'mobile', 1688, 's15');
    const screenCards = [block('x1-m-s15', 32, 0, 716, 647), block('x1-m-s15', 32, 679, 716, 274), block('x1-m-s15', 32, 984, 716, 274), block('x1-m-s15', 32, 1290, 716, 319)];
    const screenPrices = [priceRow('x1-m-s15', 's15', '$ 8.900 Agregar', 533), priceRow('x1-m-s15', 's16', '$ 3.000 Agregar', 838), priceRow('x1-m-s15', 's18', '$ 15.000 Pedir', 1495)];
    const store = site([screen, storePage], [...screenPrices, ...storePrices], [...screenCards, ...storeCards]);
    // Run 5's body[4]: UiFocus on s16's price in the phone screen, which cannot center its card and takes the full page.
    const { shot: filmed, box: target } = focusShot(store, uiScene('UiFocus', 'x1-m-s15', 1), '9x16');
    expect(filmed.id).toBe('x1-m-full');
    expect(target).toEqual(storePrices[2]);
    const { to } = focusMove(target, filmed, '9x16', store.boxes, store.blocks);
    const view = viewOf(filmed, to, store.boxes);
    expect(nothingSliced(view, [...storeCards, ...storePrices])).toEqual([]);
    expect(view.top).toBeCloseTo(to.y - stageLayout('9x16').focusY / placeShot(filmed, to, '9x16', store.boxes).scale);
  });

  it('sits flush on the card above when the cards are closer together than its margin, to keep the target whole', () => {
    // The product rows of cobrame.app's hero on the phone page, 22 px apart in a panel, in 4x5.
    const panel = block('m-full', 56, 1215, 668, 943);
    const rows = [block('m-full', 102, 1427, 576, 229), block('m-full', 102, 1678, 576, 229), block('m-full', 102, 1929, 576, 183)];
    const prices = rows.map((row, i) => box('m-full', 'price', `Product ${i + 1} $ ${i + 4}.500`, 244, row.y + 26, 212, row.h - 52));
    const target = prices[2]!;
    for (const piece of pieces) {
      const view = viewOf(phonePage, moveOf(piece)(target, phonePage, '4x5', prices, [panel, ...rows]).to, prices, '4x5');
      expect(nothingSliced(view, [...rows, ...prices])).toEqual([]);
      expect(shows(view, rows[2]!)).toBe(true);
    }
  });

  it('starts a picture taller than the view at the top edge rather than cutting it there', () => {
    // A 16x9 product picture (the demo store's, on the desktop page) that no framing shows whole above the platform UI.
    const picture = box('d-full', 'image', '', 962, 1467, 956, 598);
    const boxes = [box('d-full', 'heading', 'Demo shop', 962, 300, 956, 64), picture];
    for (const piece of pieces) {
      const view = viewOf(desktopPage, moveOf(piece)(picture, desktopPage, '16x9', boxes).to, boxes, '16x9');
      expect(view.bottom - view.top).toBeLessThan(picture.h);
      expect(slices(view, picture)).toBe(false);
      // Its top in view, near the edge.
      expect(picture.y).toBeGreaterThanOrEqual(view.top);
      expect(picture.y - view.top).toBeLessThan(0.1 * (view.bottom - view.top));
    }
  });
});

describe("the target's own card and the top of a one-screen shot", () => {
  const pieces = ['UiFocus', 'UiScroll'] as const;
  const moveOf = (piece: (typeof pieces)[number]) => (piece === 'UiFocus' ? focusMove : scrollMove);
  const landingOf = (piece: (typeof pieces)[number]) => (piece === 'UiFocus' ? focusLanding : scrollLanding);
  const priceRow = (shotId: string, sectionId: string, text: string, y: number): Box => ({ shotId, sectionId, kind: 'price', text, x: 66, y, w: 648, h: 80 });

  // The demo store's "Guía" card on the phone page: a photo, a title and a price row, 719 px tall, too tall to frame whole
  // once UiFocus zooms in, and too tall for UiScroll at the base scale (more than 90% of what the card shows).
  const before = block('m-full', 32, 562, 716, 719);
  const guide = block('m-full', 32, 1312, 716, 719);
  const after = block('m-full', 32, 2063, 716, 274);
  const guideBoxes: Box[] = [
    { shotId: 'm-full', sectionId: 's15', kind: 'image', x: 34, y: 1314, w: 712, h: 445 },
    { shotId: 'm-full', sectionId: 's15', kind: 'heading', text: 'Guía: Monetiza tu Instagram', x: 66, y: 1791, w: 648, h: 48 },
    priceRow('m-full', 's15', '$ 8.900 Agregar', 1917),
    { shotId: 'm-full', sectionId: 's15', kind: 'price', text: '$ 8.900', x: 66, y: 1933, w: 132, h: 56 },
    { shotId: 'm-full', sectionId: 's15', kind: 'cta', text: 'Agregar', x: 542, y: 1925, w: 172, h: 72 },
    { shotId: 'm-full', sectionId: 's16', kind: 'heading', text: 'Comunidad Discord Privada', x: 66, y: 2097, w: 648, h: 48 },
    priceRow('m-full', 's16', '$ 3.000 Agregar', 2222),
  ];

  for (const piece of pieces) {
    it(`${piece}: aims at a price at the bottom of a card too tall to frame, through that card's photo, not on the platform-UI line`, () => {
      const price = guideBoxes[3]!;
      const view = viewOf(phonePage, moveOf(piece)(price, phonePage, '9x16', guideBoxes, [before, guide, after]).to, guideBoxes);
      // The top edge may pass through the price's own card, but through no box and no other card.
      expect(guideBoxes.filter((b) => slices(view, b))).toEqual([]);
      expect([before, after].filter((b) => slices(view, b))).toEqual([]);
      expect(shows(view, price)).toBe(true);
      // The price stays in the upper half of what the card shows, near where the camera aimed, not sunk to the platform UI.
      expect((price.y + price.h / 2 - view.top) / (view.bottom - view.top)).toBeLessThan(0.5);
    });
  }

  // The phone screen of s15, which starts partway through s14's card: the capture records the card and its photo from
  // the top of the shot and says they go on above it.
  const screen = shot('x1-m-s15', 'mobile', 1688, 's15');
  const page = shot('x1-m-full', 'mobile', 3072);
  const clippedCard: Block = { shotId: 'x1-m-s15', x: 32, y: 0, w: 716, h: 647, clippedTop: true };
  const clippedPhoto: Box = { shotId: 'x1-m-s15', sectionId: 's14', kind: 'image', x: 34, y: 0, w: 712, h: 375, clippedTop: true };
  const screenBoxes: Box[] = [
    clippedPhoto,
    { shotId: 'x1-m-s15', sectionId: 's15', kind: 'heading', text: 'Guía: Monetiza tu Instagram', x: 66, y: 407, w: 648, h: 48 },
    priceRow('x1-m-s15', 's15', '$ 8.900 Agregar', 533),
    { shotId: 'x1-m-s15', sectionId: 's15', kind: 'cta', text: 'Agregar', x: 542, y: 541, w: 172, h: 72 },
    priceRow('x1-m-s15', 's16', '$ 3.000 Agregar', 838),
  ];
  const screenBlocks = [clippedCard, block('x1-m-s15', 32, 679, 716, 274), block('x1-m-s15', 32, 984, 716, 274)];
  const pageBoxes: Box[] = [{ shotId: 'x1-m-full', sectionId: 's14', kind: 'image', x: 34, y: 1314, w: 712, h: 445 }];

  it('counts what the capture clipped at the top of a one-screen shot as cut by a view that starts there', () => {
    // 4x5: the button of s15's card, in the card the screen starts partway through.
    const cta = screenBoxes[3]!;
    const view = viewOf(screen, focusMove(cta, screen, '4x5', screenBoxes, screenBlocks).to, screenBoxes, '4x5');
    expect(slices(view, clippedPhoto)).toBe(false);
    expect(screenBoxes.filter((b) => slices(view, b))).toEqual([]);
    expect(shows(view, cta)).toBe(true);
    expect(focusLanding(cta, screen, '4x5', screenBoxes, screenBlocks).clean).toBe(true);
  });

  it('takes the full page when the one-screen shot cannot frame the target cleanly', () => {
    const store = site([screen, page], [...screenBoxes, ...pageBoxes], screenBlocks);
    // The photo the screen starts partway through: any view of the screen either cuts it or leaves it out.
    expect(focusShot(store, uiScene('UiFocus', 'x1-m-s15', 0), '9x16')).toEqual({ shot: page, box: pageBoxes[0] });
    expect(focusLanding(clippedPhoto, screen, '9x16', store.boxes, store.blocks).clean).toBe(false);
  });

  it('says whether a landing is clean: nothing cut at the top edge, and the target whole above the platform UI', () => {
    for (const piece of pieces) {
      // The price at the bottom of the "Guía" card: clean, and the very camera the move lands on.
      const price = guideBoxes[3]!;
      const landing = landingOf(piece)(price, phonePage, '9x16', guideBoxes, [before, guide, after]);
      expect(landing).toEqual({ camera: moveOf(piece)(price, phonePage, '9x16', guideBoxes, [before, guide, after]).to, clean: true });
      // Rows 22 px apart in 4x5: the top sits flush on the row above, which placeShot gives back with float noise.
      const rows = [block('m-full', 102, 1427, 576, 229), block('m-full', 102, 1678, 576, 229), block('m-full', 102, 1929, 576, 183)];
      const prices = rows.map((row, i) => box('m-full', 'price', `Product ${i + 1} $ ${i + 4}.500`, 244, row.y + 26, 212, row.h - 52));
      expect(landingOf(piece)(prices[2]!, phonePage, '4x5', prices, [block('m-full', 56, 1215, 668, 943), ...rows]).clean).toBe(true);
    }
    // A scroll to the last card of the short store page: the top edge is clean, but the card stays under the platform UI.
    const last = priceRow('x1-m-full', 's18', '$ 15.000 Pedir', 2879);
    const cards = [block('x1-m-full', 32, 1312, 716, 719), block('x1-m-full', 32, 2063, 716, 274), block('x1-m-full', 32, 2368, 716, 274), block('x1-m-full', 32, 2674, 716, 319)];
    expect(scrollLanding(last, page, '9x16', [last], cards).clean).toBe(false);
  });
});

describe('the shot a format films', () => {
  const phone = box('m-s2', 'cta', 'Start free', 56, 724, 403, 102);
  const desktopScreen = shot('d-s2', 'desktop', 1800, 's2');
  const desktop = box('d-s2', 'cta', 'Start free', 400, 900, 300, 80);
  const all = site([phoneScreen, desktopScreen], [box('m-s2', 'heading', 'Sell on WhatsApp', 56, 239, 668, 166), phone, desktop]);

  it('is the phone shot for 9x16 and 4x5, and the same element in the desktop shot for 16x9', () => {
    expect(resolveShot(all, 'm-s2', 1, '9x16')).toEqual({ shot: phoneScreen, box: phone });
    expect(resolveShot(all, 'm-s2', 1, '4x5')).toEqual({ shot: phoneScreen, box: phone });
    expect(resolveShot(all, 'm-s2', 1, '16x9')).toEqual({ shot: desktopScreen, box: desktop });
  });

  it('stays on the page the shot came from', () => {
    const demoPhone = shot('x1-m-full', 'mobile', 3072);
    const demoDesktop = shot('x1-d-full', 'desktop', 3378);
    const pages = site([desktopPage, demoDesktop, demoPhone], []);
    expect(resolveShot(pages, 'x1-m-full', undefined, '16x9').shot.id).toBe('x1-d-full');
  });
});

describe('the same element in another shot', () => {
  // A store whose products repeat: each of the sections s13-s15 has a picture and an identical "Agregar" button.
  const sections = ['s13', 's14', 's15'] as const;
  type Section = (typeof sections)[number];
  const products = (shotId: string, tops: Record<Section, number>, only: readonly Section[] = sections): Box[] =>
    only.flatMap((sectionId): Box[] => [
      { shotId, sectionId, kind: 'image', x: 60, y: tops[sectionId], w: 640, h: 400 },
      { shotId, sectionId, kind: 'cta', text: 'Agregar', x: 60, y: tops[sectionId] + 420, w: 300, h: 80 },
    ]);
  // The screen of s13 shows the three products (the shot of a section also holds what is below it); s15's button sits
  // near its bottom edge, where the phone cannot center it.
  const phoneSection = shot('m-s13', 'mobile', 1688, 's13');
  const desktopSection = shot('d-s13', 'desktop', 1800, 's13');
  const phoneBoxes = products('m-s13', { s13: 100, s14: 600, s15: 1100 });
  const desktopBoxes = products('d-s13', { s13: 100, s14: 600, s15: 1100 });
  const phoneFullBoxes = products('m-full', { s13: 1000, s14: 1700, s15: 2400 });
  const desktopFullBoxes = products('d-full', { s13: 1000, s14: 1700, s15: 2400 });
  const store = site([phoneSection, desktopSection, phonePage, desktopPage], [...phoneBoxes, ...desktopBoxes, ...phoneFullBoxes, ...desktopFullBoxes]);
  const at = (shotId: string, sectionId: Section, kind: Box['kind'], boxes: readonly Box[] = store.boxes): { index: number; box: Box } => {
    const own = boxes.filter((b) => b.shotId === shotId);
    const index = own.findIndex((b) => b.sectionId === sectionId && b.kind === kind);
    return { index, box: own[index]! };
  };

  it('lands on the product the director chose in the other viewport, not on the first look-alike', () => {
    for (const kind of ['cta', 'image'] as const) {
      const { index } = at('m-s13', 's15', kind);
      expect(resolveShot(store, 'm-s13', index, '16x9')).toEqual({ shot: desktopSection, box: at('d-s13', 's15', kind).box });
    }
  });

  it('lands on the same product in the full page', () => {
    for (const kind of ['cta', 'image'] as const) {
      const { index } = at('m-s13', 's15', kind);
      const phoneFull = { shot: phonePage, box: at('m-full', 's15', kind).box };
      // The first look-alike would be s13's, a whole screen above.
      expect(focusShot(store, uiScene('UiFocus', 'm-s13', index), '9x16')).toEqual(phoneFull);
      // A scroll always goes to the full page, whichever viewport the format films.
      expect(scrollShot(store, uiScene('UiScroll', 'm-s13', index), '9x16')).toEqual(phoneFull);
      expect(scrollShot(store, uiScene('UiScroll', 'm-s13', index), '16x9')).toEqual({ shot: desktopPage, box: at('d-full', 's15', kind).box });
    }
  });

  it('tries the next shot of the page before settling for a look-alike of another section', () => {
    // The desktop screen of s13 ends before s15, so its only "Agregar" is s13's; the full page has s15's.
    const shortScreen = site(
      [phoneSection, desktopSection, desktopPage],
      [...phoneBoxes, ...products('d-s13', { s13: 100, s14: 600, s15: 1100 }, ['s13']), ...desktopFullBoxes],
    );
    const { index } = at('m-s13', 's15', 'cta', shortScreen.boxes);
    expect(resolveShot(shortScreen, 'm-s13', index, '16x9')).toEqual({ shot: desktopPage, box: at('d-full', 's15', 'cta').box });
  });

  it('keeps the first look-alike for a box with no section', () => {
    const unsectioned = phoneBoxes.map(({ sectionId: _sectionId, ...rest }): Box => rest);
    const loose = site([phoneSection, desktopSection], [...unsectioned, ...desktopBoxes]);
    const { index } = at('m-s13', 's15', 'cta');
    expect(resolveShot(loose, 'm-s13', index, '16x9')).toEqual({ shot: desktopSection, box: at('d-s13', 's13', 'cta').box });
  });

  it('keeps the first look-alike when no shot of the page has one in the box\'s section', () => {
    const noS15 = site([phoneSection, desktopSection], [...phoneBoxes, ...products('d-s13', { s13: 100, s14: 600, s15: 1100 }, ['s13', 's14'])]);
    const { index } = at('m-s13', 's15', 'cta', noS15.boxes);
    expect(resolveShot(noS15, 'm-s13', index, '16x9')).toEqual({ shot: desktopSection, box: at('d-s13', 's13', 'cta', noS15.boxes).box });
  });
});

describe('whether a UI scene frames its target cleanly', () => {
  const pieces = ['UiFocus', 'UiScroll'] as const;
  type Piece = (typeof pieces)[number];
  const pick = (piece: Piece, shotId: string, boxIndex?: number) => ({ piece, shotId, ...(boxIndex === undefined ? {} : { boxIndex }) });

  // The demo store's phone page: the "Guía" card, too tall to frame, then three short cards down to the end of the page.
  const storeCards = (shotId: string): Block[] => [
    block(shotId, 32, 1312, 716, 719),
    block(shotId, 32, 2063, 716, 274),
    block(shotId, 32, 2368, 716, 274),
    block(shotId, 32, 2674, 716, 319),
  ];
  const storeRows = (shotId: string): Box[] => [
    { shotId, sectionId: 's15', kind: 'price', text: '$ 8.900 Agregar', x: 66, y: 1917, w: 648, h: 80 },
    { shotId, sectionId: 's16', kind: 'price', text: '$ 3.000 Agregar', x: 66, y: 2222, w: 648, h: 80 },
  ];
  const store = (height: number): SiteData => site([shot('x1-m-full', 'mobile', height)], storeRows('x1-m-full'), storeCards('x1-m-full'));

  it('is false for a target near the end of a short page, where a clean top edge leaves it under the platform UI', () => {
    // Run 5: the 3072 px page ends too soon to bring the card of "$ 3.000" above the platform UI without cutting the "Guía" card.
    for (const piece of pieces) expect(framesCleanly(store(3072), pick(piece, 'x1-m-full', 1), '9x16'), piece).toBe(false);
  });

  it('is true for the same target on a longer page', () => {
    for (const piece of pieces) expect(framesCleanly(store(6000), pick(piece, 'x1-m-full', 1), '9x16'), piece).toBe(true);
  });

  // The phone screen of s15 starts partway through s14's photo, which the capture records from the top of the shot.
  const screen = shot('x1-m-s15', 'mobile', 1688, 's15');
  const page = shot('x1-m-full', 'mobile', 3072);
  const screenPhoto: Box = { shotId: 'x1-m-s15', sectionId: 's14', kind: 'image', x: 34, y: 0, w: 712, h: 375, clippedTop: true };
  const pagePhoto: Box = { shotId: 'x1-m-full', sectionId: 's14', kind: 'image', x: 34, y: 1314, w: 712, h: 445 };

  it('asks the take the format films: a pick the one-screen shot cannot frame cleanly frames cleanly on its full page', () => {
    // On the screen the photo is cut by any view that shows it...
    expect(focusLanding(screenPhoto, screen, '9x16', [screenPhoto, pagePhoto]).clean).toBe(false);
    // ...but UiFocus and UiScroll film it on the full page, where it is whole.
    for (const piece of pieces) expect(framesCleanly(site([screen, page], [screenPhoto, pagePhoto]), pick(piece, 'x1-m-s15', 0), '9x16'), piece).toBe(true);
    // With no full page to go to, the screen is all there is.
    for (const piece of pieces) expect(framesCleanly(site([screen], [screenPhoto]), pick(piece, 'x1-m-s15', 0), '9x16'), piece).toBe(false);
  });

  it("follows each piece's own camera: UiFocus zooms in on a narrow card near the end of the page, UiScroll cannot bring it above the platform UI", () => {
    // A two-column card 2.5 screens down a 3000 px phone page: UiFocus frames it at 1.12x, and its view ends lower on the
    // page than UiScroll's at the base scale.
    const narrow = shot('m-full', 'mobile', 3000);
    const card = block('m-full', 60, 2180, 330, 500);
    const price = box('m-full', 'price', '$ 4.500', 80, 2560, 290, 60);
    const shop = site([narrow], [price], [card]);
    expect(framesCleanly(shop, pick('UiFocus', 'm-full', 0), '9x16')).toBe(true);
    expect(framesCleanly(shop, pick('UiScroll', 'm-full', 0), '9x16')).toBe(false);
  });

  it('is false for a box or a shot that is not there', () => {
    for (const piece of pieces) {
      expect(framesCleanly(store(6000), pick(piece, 'x1-m-full', 2), '9x16'), piece).toBe(false);
      expect(framesCleanly(store(6000), pick(piece, 'x9-m-full', 0), '9x16'), piece).toBe(false);
      expect(framesCleanly(store(6000), pick(piece, 'x1-m-full'), '9x16'), piece).toBe(false);
    }
  });

  it('is false for a UiScroll whose full page lacks the element: the scroll would land on no target', () => {
    const lone = box('x1-m-s15', 'price', '$ 3.000 Agregar', 66, 300, 648, 80);
    expect(framesCleanly(site([screen, page], [lone]), pick('UiFocus', 'x1-m-s15', 0), '9x16')).toBe(true);
    expect(framesCleanly(site([screen, page], [lone]), pick('UiScroll', 'x1-m-s15', 0), '9x16')).toBe(false);
  });
});

describe('the take UiFocus films', () => {
  it('leaves a screen whose landing could hold the target at the focus point but is not clean', () => {
    // The screen of s14 starts partway through a card the camera aims at (its price row is in it): the screen could bring
    // that card to the focus point, but any view of it either cuts the card at the top or leaves it out.
    const screen = shot('x1-m-s14', 'mobile', 1688, 's14');
    const page = shot('x1-m-full', 'mobile', 3072);
    const row: Box = { shotId: 'x1-m-s14', sectionId: 's13', kind: 'price', text: '$ 4.500 Agregar', x: 66, y: 366, w: 648, h: 80 };
    const pageRow: Box = { ...row, shotId: 'x1-m-full', y: 1166 };
    const clippedCard: Block = { shotId: 'x1-m-s14', x: 32, y: 0, w: 716, h: 480, clippedTop: true };
    const store = site([screen, page], [row, pageRow], [clippedCard, block('x1-m-full', 32, 562, 716, 719)]);
    expect(focusLanding(row, screen, '9x16', store.boxes, store.blocks).clean).toBe(false);
    expect(focusShot(store, uiScene('UiFocus', 'x1-m-s14', 0), '9x16')).toEqual({ shot: page, box: pageRow });
  });

  it('keeps the element the director chose on a full-page take, even when a look-alike shares its section', () => {
    // A grid under one heading: two identical buttons in s1, the second too near the end of the page to center.
    const page = shot('m-full', 'mobile', 3000);
    const first = box('m-full', 'cta', 'Agregar', 66, 600, 172, 72);
    const second = box('m-full', 'cta', 'Agregar', 66, 2900, 172, 72);
    const grid = site([page], [{ ...first, sectionId: 's1' }, { ...second, sectionId: 's1' }]);
    expect(focusShot(grid, uiScene('UiFocus', 'm-full', 1), '9x16')).toEqual({ shot: page, box: { ...second, sectionId: 's1' } });
  });
});

describe('the top edge rule on a long page', () => {
  it('weighs the whole page when no top near the target is clean: a card beside the target that spans every view of it is left whole', () => {
    // A tall card down the left of the page, and a picture beside it: every view that shows the picture cuts the card. (A
    // picture, so that the bottom edge of the frame gives no tops of its own here: a heading, a price or a button would.)
    const card = block('m-full', 0, 600, 300, 2000);
    const picture = box('m-full', 'image', '', 400, 1500, 300, 60);
    const landing = focusLanding(picture, phonePage, '9x16', [picture], [card]);
    const view = viewOf(phonePage, landing.camera, [picture]);
    // The top edge goes up to 24 px above the card, the clean top nearest to where the camera aimed, and the picture gives way.
    expect(slices(view, card)).toBe(false);
    expect(view.top).toBeCloseTo(card.y - 24);
    expect(shows(view, picture)).toBe(false);
    expect(landing.clean).toBe(false);
  });
});

describe('the bottom edge of the frame', () => {
  // The card runs on under the platform UI to the bottom of the frame, and the review sees the whole frame: a heading the
  // bottom edge falls through is sliced in the key frame, as in paid run 9 (celo.org: a UiScroll to the $6.2B card ended
  // in the middle of "1 sec." and "$0.0004").
  const formats = ['9x16', '4x5', '16x9'] as const;
  const pieces = ['UiFocus', 'UiScroll'] as const;
  type Piece = (typeof pieces)[number];
  const landingOf = (piece: Piece) => (piece === 'UiFocus' ? focusLanding : scrollLanding);
  const moveOf = (piece: Piece) => (piece === 'UiFocus' ? focusMove : scrollMove);
  // A long page of the viewport the format films, whose content is a column x..x+w (on a desktop page its title tells the
  // camera so), with a price halfway down.
  const pageFor = (format: Format) => {
    const desktop = format === '16x9';
    const page = shot(desktop ? 'd-full' : 'm-full', desktop ? 'desktop' : 'mobile', 8000);
    const [x, w] = desktop ? [400, 2080] : [40, 700];
    const price = box(page.id, 'price', '$ 4.500', x + 40, 3000, 300, 60);
    return { page, x, w, price, boxes: [box(page.id, 'heading', 'Tiendita', x, 400, w, 60), price] };
  };

  for (const format of formats) {
    for (const piece of pieces) {
      it(`${piece} in ${format}: moves off a heading the bottom edge would slice, with both edges clear and the target whole`, () => {
        const { page, x, w, price, boxes: plain } = pageFor(format);
        const first = landingOf(piece)(price, page, format, plain);
        expect(first.clean).toBe(true);
        // A heading right where the bottom edge of that frame falls.
        const heading = box(page.id, 'heading', 'Simple pricing', x, viewOf(page, first.camera, plain, format).end - 30, w, 60);
        const boxes = [...plain, heading];

        const landed = landingOf(piece)(price, page, format, boxes);
        const view = viewOf(page, landed.camera, boxes, format);
        expect(landed.camera.y).not.toBeCloseTo(first.camera.y);
        expect(boxes.filter((b) => slices(view, b) || slicesEnd(view, b))).toEqual([]);
        expect(shows(view, price)).toBe(true);
        expect(landed.clean).toBe(true);
        expect(moveOf(piece)(price, page, format, boxes).to).toEqual(landed.camera);
      });
    }
  }

  it('lets a picture or a card run off the bottom of the frame: the card the shot is in is drawn bleeding off it', () => {
    for (const format of formats) {
      for (const piece of pieces) {
        const { page, x, w, price, boxes } = pageFor(format);
        const first = landingOf(piece)(price, page, format, boxes);
        const { bottom, end } = viewOf(page, first.camera, boxes, format);
        // Both begin under the platform UI and run on past the bottom of the frame.
        const picture = box(page.id, 'image', '', x, bottom + 10, w, end - bottom + 200);
        const card = block(page.id, x, bottom + 5, w, end - bottom + 300);
        const landed = landingOf(piece)(price, page, format, [...boxes, picture], [card]);
        expect(landed, `${piece} ${format}`).toEqual(first);
        const view = viewOf(page, landed.camera, boxes, format);
        expect([slicesEnd(view, picture), slicesEnd(view, card)]).toEqual([true, true]);
      }
    }
  });

  it('is not clean when every landing that keeps the target whole has a heading at its bottom edge', () => {
    // Headings stacked under the price, each overlapping the next: every frame that shows the price whole ends in one.
    const price = box('m-full', 'price', '$ 4.500', 80, 3000, 290, 40);
    const stack = Array.from({ length: 20 }, (_, k) => box('m-full', 'heading', `Step ${k + 1}`, 40, 3300 + 50 * k, 700, 60));
    const boxes = [price, ...stack];
    const shop = site([phonePage], boxes);
    for (const piece of pieces) {
      const landed = landingOf(piece)(price, phonePage, '9x16', boxes);
      expect(landed.clean, piece).toBe(false);
      // As at the top edge, the target gives way rather than an edge cut through a heading.
      const view = viewOf(phonePage, landed.camera, boxes);
      expect(boxes.filter((b) => slices(view, b) || slicesEnd(view, b))).toEqual([]);
      expect(shows(view, price)).toBe(false);
      expect(framesCleanly(shop, { piece, shotId: 'm-full', boxIndex: 0 }, '9x16'), piece).toBe(false);
    }
    // With the headings apart, the same price frames cleanly.
    const apart = [price, ...stack.filter((_, k) => k % 2 === 0)];
    for (const piece of pieces) expect(framesCleanly(site([phonePage], apart), { piece, shotId: 'm-full', boxIndex: 0 }, '9x16'), piece).toBe(true);
  });
});

describe('the edge rules, against a search of every top', () => {
  // A reference written to be read rather than fast: every top the camera weighs (where it aims, the top of the shot and
  // the lowest top, 24 px clear of each box and card or flush with it, and the same for the bottom edge of the frame
  // against each heading, price and button), each ranked against every region. The camera weighs the tops a window at a
  // time (see avoidTopCut); on layouts made to tempt the windows' edges (regions 0 to 3 px tall, regions flush or 23 to
  // 25 px apart or overlapping, regions clipped at the top of a one-screen shot, panels around cards), each piece has to
  // land where the reference does, and be as clean. The reference takes the scale from the landing (how far UiFocus zooms
  // is not what it checks), and aims as the pieces do: at the card that holds the target when the frame holds it whole,
  // else UiScroll at the target and UiFocus at what a heading titles (see focusRegion).
  const TOLERANCE = 0.5;
  const MARGIN = 24;
  type Piece = 'UiFocus' | 'UiScroll';
  type Region = { x: number; y: number; w: number; h: number; clippedTop?: true };
  const holds = (outer: Region, inner: Region): boolean =>
    outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.w >= inner.x + inner.w && outer.y + outer.h >= inner.y + inner.h;
  const cutTop = (r: Region, top: number): boolean => (r.clippedTop === true || r.y < top - TOLERANCE) && r.y + r.h > top + TOLERANCE;
  const cutEnd = (r: Region, end: number): boolean => r.y < end - TOLERANCE && r.y + r.h > end + TOLERANCE;
  const better = (a: number[], b: number[]): boolean => {
    const i = a.findIndex((value, n) => value !== b[n]);
    return i >= 0 && a[i]! < b[i]!;
  };

  /**
   * Where `piece` lands on `box` at `scale` (card pixels per shot pixel), the top of its view, by the reference: and
   * whether that landing is clean.
   */
  const reference = (piece: Piece, box: Box, scale: number, page: Shot, format: Format, boxes: readonly Box[], blocks: readonly Block[]): { top: number; clean: boolean } => {
    const { cardW, cardH, focusY } = stageLayout(format);
    const visible = (2 * focusY) / scale;
    const frame = cardH / scale;
    const card = blockOf(blocks, page.id, box);
    const aim: Region = card && card.h * scale <= 0.9 * 2 * focusY && card.w * scale <= cardW ? card : box;
    const aimedAt: Region = aim === box && piece === 'UiFocus' ? focusRegion(box) : aim;
    const ownBoxes = boxes.filter((b) => b.shotId === page.id);
    const ownBlocks = blocks.filter((b) => b.shotId === page.id);
    const own: Region[] = [...ownBoxes, ...ownBlocks];
    const kept: Region[] = [...ownBoxes, ...ownBlocks.filter((b) => !(b !== aim && holds(b, aim)))];
    const texts = ownBoxes.filter((b) => b.kind !== 'image');
    const lowest = Math.max(0, page.height - frame);
    const start = Math.min(Math.max(aimedAt.y + aimedAt.h / 2 - focusY / scale, 0), lowest);
    const tops: [number, boolean][] = [[start, false], [0, false], [lowest, false]];
    for (const r of own) tops.push([r.y - MARGIN, false], [r.y + r.h + MARGIN, false]);
    for (const r of texts) tops.push([r.y - MARGIN - frame, false], [r.y + r.h + MARGIN - frame, false]);
    for (const r of own) tops.push([r.y, true], [r.y + r.h, true]);
    for (const r of texts) tops.push([r.y - frame, true], [r.y + r.h - frame, true]);
    let best: { top: number; rank: number[] } | undefined;
    for (const [top, flush] of tops) {
      if (top < 0 || top > lowest) continue;
      const end = top + frame;
      const cuts = kept.filter((r) => cutTop(r, top)).length + (end < page.height - TOLERANCE ? texts.filter((r) => cutEnd(r, end)).length : 0);
      const whole = !cutTop(aim, top) && aim.y >= top - TOLERANCE && aim.y + aim.h <= top + visible + TOLERANCE;
      const hidden = Math.min(aim.h, Math.max(0, top - aim.y) + Math.max(0, aim.y + aim.h - (top + visible)));
      const rank = [cuts, whole ? 0 : 1, flush ? 1 : 0, hidden, Math.abs(top - start)];
      if (!best || better(rank, best.rank)) best = { top, rank };
    }
    return { top: best!.top, clean: best!.rank[0] === 0 && best!.rank[1] === 0 };
  };

  // A park-miller generator, so that every run tries the same layouts.
  const seeded = (seed: number) => () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const KINDS = ['heading', 'price', 'cta', 'image'] as const;

  /** A page or a one-screen shot with a column of boxes and cards, some of them close, some thin, some in panels. */
  const layout = (rand: () => number): { page: Shot; boxes: Box[]; blocks: Block[] } => {
    const desktop = rand() < 0.3;
    const screen = rand() < 0.25;
    const id = `${desktop ? 'd' : 'm'}-${screen ? 's2' : 'full'}`;
    const page = shot(id, desktop ? 'desktop' : 'mobile', screen ? (desktop ? 1800 : 1688) : 1500 + Math.floor(rand() * 9000), screen ? 's2' : undefined);
    const boxes: Box[] = [];
    const blocks: Block[] = [];
    const heights = [0, 1, 2, 3, 40, 84, 160, 300, 700];
    const gaps = [0, 23, 24, 25, -10, 60, 300, 900];
    let y = screen && rand() < 0.5 ? 0 : Math.floor(rand() * 300);
    for (let n = 3 + Math.floor(rand() * 26); n > 0; n -= 1) {
      const h = heights[Math.floor(rand() * heights.length)]! + (rand() < 0.3 ? rand() * 10 : 0);
      if (y + h > page.height) break;
      const x = Math.floor(rand() * page.width * 0.5);
      const w = Math.max(20, Math.floor(rand() * (page.width - x)));
      const clippedTop = y === 0 && screen && rand() < 0.7 ? { clippedTop: true as const } : {};
      if (rand() < 0.3) blocks.push({ shotId: id, x, y, w, h, ...clippedTop });
      else boxes.push({ shotId: id, kind: KINDS[Math.floor(rand() * KINDS.length)]!, text: `Box ${n}`, x, y, w, h, ...clippedTop });
      // Now and then a panel around what came before.
      if (rand() < 0.08) blocks.push({ shotId: id, x: 0, y: Math.max(0, y - 400), w: page.width, h: Math.min(page.height, y + h + 40) - Math.max(0, y - 400) });
      y = Math.max(0, y + (rand() < 0.5 ? h : 0) + gaps[Math.floor(rand() * gaps.length)]!);
    }
    return { page, boxes, blocks };
  };

  // Where an edge of a region lies exactly half a pixel from an edge of the frame, the tolerance decides by a hair, and so
  // does float noise: the view placeShot gives back is the camera's top give or take 1e-12 (see EDGE_TOLERANCE).
  const onTolerance = (edge: number, regions: readonly Region[]): boolean =>
    regions.some((r) => [r.y, r.y + r.h].some((at) => Math.abs(Math.abs(at - edge) - TOLERANCE) < 1e-6));

  it('lands each piece where the reference does, in every format, on 500 layouts', () => {
    const rand = seeded(20261021);
    const differences: string[] = [];
    let compared = 0;
    let ties = 0;
    for (let k = 0; k < 500; k += 1) {
      const { page, boxes, blocks } = layout(rand);
      for (const format of ['9x16', '4x5', '16x9'] as const) {
        for (const piece of ['UiScroll', 'UiFocus'] as const) {
          for (const box of boxes) {
            const landed = (piece === 'UiFocus' ? focusLanding : scrollLanding)(box, page, format, boxes, blocks);
            const { scale } = placeShot(page, landed.camera, format, boxes);
            const want = reference(piece, box, scale, page, format, boxes, blocks);
            const { top, end } = viewOf(page, landed.camera, boxes, format);
            compared += 1;
            if (Math.abs(top - want.top) > 1e-6) differences.push(`layout ${k} ${format} ${piece} box ${boxes.indexOf(box)}: top ${top} against ${want.top}`);
            else if (landed.clean !== want.clean) {
              if (onTolerance(top, [...boxes, ...blocks]) || onTolerance(end, boxes)) ties += 1;
              else differences.push(`layout ${k} ${format} ${piece} box ${boxes.indexOf(box)}: clean ${landed.clean} against ${want.clean}`);
            }
          }
        }
      }
    }
    expect(differences.slice(0, 5)).toEqual([]);
    expect(compared).toBeGreaterThan(20_000);
    expect(ties).toBeLessThan(compared / 1000);
  });
});
