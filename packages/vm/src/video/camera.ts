// The camera of the UI scenes, as plain math: which shot a format films, how it frames it, and where it moves. The real
// UI sits in a card under the caption; the camera holds a point of the shot at the card's focus point, the middle of the
// part of the card the platform UI leaves visible. Rules from the prueba (spec 6.5): frame the content and not the
// margins, zoom a phone shot 1.12x at most, aim a heading at the block it titles, never cut a heading with the top edge,
// and take the full page when a one-screen shot cannot center the target.
import { FORMATS, PREFERRED_VIEWPORT, type Box, type Format, type Scene, type Shot, type SiteData } from '@app/core';

/** The layout of a UI scene: a caption block on top and, under it, the card with the shot, bleeding off the bottom edge. */
export type Stage = {
  captionTop: number;
  captionHeight: number;
  cardLeft: number;
  cardTop: number;
  cardW: number;
  /** The card runs to the bottom of the frame, under the platform UI. */
  cardH: number;
  /** In card pixels: the middle of the part of the card that the platform UI leaves visible. */
  focusY: number;
  radius: number;
};

const CAPTION_HEIGHT: Record<Format, number> = { '9x16': 300, '16x9': 190, '4x5': 220 };
const CARD_SIDE: Record<Format, number> = { '9x16': 60, '16x9': 150, '4x5': 60 };
const CAPTION_GAP = 44;

export const stageLayout = (format: Format): Stage => {
  const { width, height, safe } = FORMATS[format];
  const cardTop = safe.top + CAPTION_HEIGHT[format] + CAPTION_GAP;
  return {
    captionTop: safe.top,
    captionHeight: CAPTION_HEIGHT[format],
    cardLeft: CARD_SIDE[format],
    cardTop,
    cardW: width - 2 * CARD_SIDE[format],
    cardH: height - cardTop,
    focusY: (height - safe.bottom - cardTop) / 2,
    radius: Math.round(width * 0.034),
  };
};

/**
 * Where the camera looks. `scale` is the zoom over the base framing (1: the page's content fills the card's width) and
 * (x, y) is the point of the shot, in shot pixels, held at the card's focus point.
 */
export type Camera = { scale: number; x: number; y: number };
export type Move = { from: Camera; to: Camera };

// A phone layout is one column already: zooming into it only crops rows at the sides, so the camera mostly travels.
const PHONE_MAX_ZOOM = 1.12;
const DESKTOP_MAX_ZOOM = 2.4;
// Shot pixels are DPR 2: past this scale (card pixels per shot pixel) the UI goes soft.
const MAX_SCALE = 2.2;
// With no boxes to show where a desktop page's content is, the camera frames its central 78%, without the container's margins.
const DESKTOP_CENTER = 0.78;
const CONTENT_PAD = 0.08;
const MIN_CONTENT = 0.3;
// The target takes at most this share of the card.
const TARGET_WIDTH = 0.78;
const TARGET_HEIGHT = 0.6;
// The opening framing sits this share of the card above the target, so the move also travels down the page to it: the
// page moves up into place, the same way the card it is in rises.
const OPENING_DROP = 0.12;
const TOP_CUT_MARGIN = 24;

// ---------- which shot ----------

/** The page a shot is of: extra pages carry a prefix ("x1-d-full"), the site's own page has none. */
export const pageOf = (shotId: string): string => shotId.match(/^x\d+-/)?.[0] ?? '';

/** The full-page capture of the same page, in the given viewport. */
export const fullShotOf = (site: SiteData, shot: Shot, viewport: Shot['viewport'] = shot.viewport): Shot | undefined =>
  site.shots.find((s) => s.id === `${pageOf(shot.id)}${viewport === 'desktop' ? 'd' : 'm'}-full`);

const sameElement = (site: SiteData, shot: Shot, box: Box): Box | undefined =>
  site.boxes.find((b) => b.shotId === shot.id && b.kind === box.kind && b.text === box.text);

export type Take = { shot: Shot; box: Box | undefined };

/**
 * The director picks a shot and a box in it (`boxIndex` counts the boxes of that shot); each format films the viewport
 * that reads best in it, so the same element is looked up by kind and text in the other viewport's shots of that page.
 */
export const resolveShot = (site: SiteData, shotId: string | undefined, boxIndex: number | undefined, format: Format): Take => {
  const shot = site.shots.find((s) => s.id === shotId) ?? site.shots[0];
  if (!shot) throw new Error('The site has no shots to film.');
  const box = boxIndex === undefined ? undefined : site.boxes.filter((b) => b.shotId === shot.id)[boxIndex];
  const want = PREFERRED_VIEWPORT[format];
  if (shot.viewport === want) return { shot, box };
  const page = pageOf(shot.id);
  const alternatives = site.shots
    .filter((s) => s.viewport === want && pageOf(s.id) === page && (s.sectionId === shot.sectionId || !s.sectionId))
    .sort((a, b) => Number(b.sectionId === shot.sectionId) - Number(a.sectionId === shot.sectionId));
  for (const alternative of alternatives) {
    if (!box) return { shot: alternative, box: undefined };
    const match = sameElement(site, alternative, box);
    if (match) return { shot: alternative, box: match };
  }
  return { shot, box };
};

/** UiFocus: the director's take, or the full page of the same viewport when a one-screen shot cannot center the target. */
export const focusShot = (site: SiteData, scene: Scene, format: Format): Take => {
  const take = resolveShot(site, scene.shotId, scene.boxIndex, format);
  if (!take.box || canCenter(take.shot, take.box, format, site.boxes)) return take;
  const full = fullShotOf(site, take.shot);
  const match = full && sameElement(site, full, take.box);
  return full && match ? { shot: full, box: match } : take;
};

/** UiScroll: a scroll wants a page, so a one-screen pick becomes the full page of the viewport the format films. */
export const scrollShot = (site: SiteData, scene: Scene, format: Format): Take => {
  const take = resolveShot(site, scene.shotId, scene.boxIndex, format);
  if (take.shot.id.endsWith('-full')) return take;
  const full = fullShotOf(site, take.shot, PREFERRED_VIEWPORT[format]);
  if (!full) return take;
  return { shot: full, box: take.box && sameElement(site, full, take.box) };
};

// ---------- framing ----------

/** The horizontal extent of the page's content, from its boxes, padded. Pages sit in a centered container, sometimes a narrow one. */
const contentSpan = (shot: Shot, boxes: readonly Box[]): { x0: number; x1: number } => {
  const own = boxes.filter((b) => b.shotId === shot.id);
  if (own.length < 2) {
    if (shot.viewport === 'mobile') return { x0: 0, x1: shot.width };
    const margin = (shot.width * (1 - DESKTOP_CENTER)) / 2;
    return { x0: margin, x1: shot.width - margin };
  }
  const x0 = Math.min(...own.map((b) => b.x));
  const x1 = Math.max(...own.map((b) => b.x + b.w));
  const pad = (x1 - x0) * CONTENT_PAD;
  return { x0: Math.max(0, x0 - pad), x1: Math.min(shot.width, x1 + pad) };
};

/** Card pixels per shot pixel at zoom 1: the content fills the card's width (a phone shot is content-wide already). */
const baseScale = (shot: Shot, cardW: number, boxes: readonly Box[]): number => {
  if (shot.viewport === 'mobile') return cardW / shot.width;
  const { x0, x1 } = contentSpan(shot, boxes);
  return cardW / Math.max(x1 - x0, shot.width * MIN_CONTENT);
};

const contentMiddle = (shot: Shot, boxes: readonly Box[]): number => {
  if (shot.viewport === 'mobile') return shot.width / 2;
  const { x0, x1 } = contentSpan(shot, boxes);
  return (x0 + x1) / 2;
};

/** What the camera aims at for a box: a heading stands for the block it titles (card, feature, section), 4 headings tall. */
export const focusRegion = (box: Box): Box =>
  box.kind === 'heading' ? { ...box, x: box.x - box.w * 0.08, y: box.y - box.h * 0.6, w: box.w * 1.16, h: box.h * 4 } : box;

/**
 * Where the shot goes in the card: translate by (x, y) card pixels, then scale. The point (camera.x, camera.y) lands on
 * the focus point, except that the card never shows past the edges of the shot: a shot narrower than the card is
 * centered, and one shorter than the card sits at its top.
 */
export const placeShot = (shot: Shot, camera: Camera, format: Format, boxes: readonly Box[]): { x: number; y: number; scale: number } => {
  const { cardW, cardH, focusY } = stageLayout(format);
  const scale = baseScale(shot, cardW, boxes) * camera.scale;
  const width = shot.width * scale;
  const height = shot.height * scale;
  const x = width <= cardW ? (cardW - width) / 2 : Math.min(0, Math.max(cardW - width, cardW / 2 - camera.x * scale));
  const y = height <= cardH ? 0 : Math.min(0, Math.max(cardH - height, focusY - camera.y * scale));
  return { x, y, scale };
};

/**
 * Moves the camera so that the top edge of the view does not slice through a box (a heading cut mid-glyph reads as a
 * bug): the smaller move of the two, showing the box or pushing it out of view, as long as the target stays in view.
 */
const avoidTopCut = (camera: Camera, scale: number, shot: Shot, format: Format, boxes: readonly Box[], target: Box | undefined): Camera => {
  const { focusY } = stageLayout(format);
  const top = camera.y - focusY / scale;
  const hit = boxes.find((b) => b.shotId === shot.id && b.y < top && b.y + b.h > top);
  if (!hit || top <= 0) return camera;
  const visible = (2 * focusY) / scale;
  const options = [hit.y - TOP_CUT_MARGIN, hit.y + hit.h + TOP_CUT_MARGIN].sort((a, b) => Math.abs(a - top) - Math.abs(b - top));
  for (const newTop of options) {
    const keepsTarget = !target || (target.y >= newTop && target.y + target.h <= newTop + visible);
    if (keepsTarget && newTop >= 0) return { ...camera, y: newTop + focusY / scale };
  }
  return camera;
};

/** Whether the camera can hold the target at the focus point: the shot runs on far enough below it to fill the card. */
const canCenter = (shot: Shot, box: Box, format: Format, boxes: readonly Box[]): boolean => {
  const { cardH, focusY } = stageLayout(format);
  const camera = focusCamera(box, shot, format, boxes);
  const scale = placeShot(shot, camera, format, boxes).scale;
  return (shot.height - camera.y) * scale >= cardH - focusY;
};

// ---------- moves ----------

/**
 * UiFocus: the camera starts wide on the real UI, a little above the target, and eases down and in to the element that
 * backs the caption, like a scroll that settles. It zooms until the target takes 78% of the card's width or 60% of its height, within the limits of the
 * shot's viewport, and pans sideways only when the view gets narrower than most of the content.
 */
export const focusMove = (box: Box | undefined, shot: Shot, format: Format, boxes: readonly Box[] = []): Move => {
  const { cardW, cardH } = stageLayout(format);
  const base = baseScale(shot, cardW, boxes);
  const { x0, x1 } = contentSpan(shot, boxes);
  const middle = contentMiddle(shot, boxes);
  const maxZoom = shot.viewport === 'mobile' ? PHONE_MAX_ZOOM : DESKTOP_MAX_ZOOM;
  const target = box ? focusRegion(box) : { x: 0, y: 0, w: shot.width, h: Math.min(shot.height, cardH / base) };
  const scale = Math.max(base, Math.min(MAX_SCALE, base * maxZoom, (cardW * TARGET_WIDTH) / target.w, (cardH * TARGET_HEIGHT) / target.h));
  const pan = cardW / scale < (x1 - x0) * 0.8;
  const targetY = target.y + target.h / 2;
  const from: Camera = { scale: 1, x: middle, y: targetY - (cardH * OPENING_DROP) / base };
  const to = avoidTopCut({ scale: scale / base, x: pan ? target.x + target.w / 2 : middle, y: targetY }, scale, shot, format, boxes, box);
  return { from, to };
};

/** Where UiFocus's camera lands: see focusMove. */
export const focusCamera = (box: Box | undefined, shot: Shot, format: Format, boxes: readonly Box[] = []): Camera => focusMove(box, shot, format, boxes).to;

/** UiScroll: glides down the page at one scale, from its top to the target (or a little under half the page). */
export const scrollMove = (box: Box | undefined, shot: Shot, format: Format, boxes: readonly Box[] = []): Move => {
  const { cardW, cardH, focusY } = stageLayout(format);
  const base = baseScale(shot, cardW, boxes);
  const x = contentMiddle(shot, boxes);
  const top = focusY / base;
  const end = box ? box.y + box.h / 2 : Math.min(shot.height - cardH / base / 2, top + shot.height * 0.45);
  return { from: { scale: 1, x, y: top }, to: avoidTopCut({ scale: 1, x, y: end }, base, shot, format, boxes, box) };
};

/** The camera at progress `p` (0 to 1) of a move: the zoom grows by the same factor at each step, the pan in equal steps. */
export const cameraAt = ({ from, to }: Move, p: number): Camera => ({
  scale: from.scale ** (1 - p) * to.scale ** p,
  x: from.x * (1 - p) + to.x * p,
  y: from.y * (1 - p) + to.y * p,
});
