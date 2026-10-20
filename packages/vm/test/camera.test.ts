import { FORMATS, type Block, type Box, type Scene, type Shot, type SiteData } from '@app/core';
import { describe, expect, it } from 'vitest';
import { cameraAt, focusCamera, focusMove, focusRegion, focusShot, placeShot, resolveShot, scrollMove, scrollShot, stageLayout, type Camera } from '../src/video/camera';

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

/** The part of the shot the card shows above the platform UI, with the camera there: its top and bottom, in shot pixels. */
const viewOf = (target: Shot, camera: Camera, boxes: Box[], format: '9x16' | '16x9' | '4x5' = '9x16') => {
  const placed = placeShot(target, camera, format, boxes);
  const top = -placed.y / placed.scale;
  return { top, bottom: top + (2 * stageLayout(format).focusY) / placed.scale };
};
const slices = (view: { top: number }, r: { y: number; h: number }): boolean => r.y < view.top && r.y + r.h > view.top;
const shows = (view: { top: number; bottom: number }, r: { y: number; h: number }): boolean => r.y >= view.top && r.y + r.h <= view.bottom;

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

  it('clears what it can when nothing clears everything: a panel around the cards runs past the top edge anyway', () => {
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
