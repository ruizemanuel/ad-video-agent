// The camera of the UI scenes, as plain math: which shot a format films, how it frames it, and where it moves. The real
// UI sits in a card under the caption; the camera holds a point of the shot at the card's focus point, the middle of the
// part of the card the platform UI leaves visible. Rules from the prueba (spec 6.5): frame the content and not the
// margins, zoom a phone shot 1.12x at most, aim at the page's card (block) that holds the target or else a heading at
// what it titles, never let the top edge slice a box or a block, and take the full page when a one-screen shot cannot
// center the target.
import { blockOf, FORMATS, PREFERRED_VIEWPORT, type Block, type Box, type Format, type Scene, type Shot, type SiteData } from '@app/core';

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
/** A part of a shot, in shot pixels: a box, a block, or what the camera aims at. */
type Region = { x: number; y: number; w: number; h: number };

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
// The opening framing sits this share of the card above the landing one, so the move always travels down the page, and
// as far: the page moves up into place, the same way the card it is in rises.
const OPENING_DROP = 0.12;
// A block is framed whole when it takes at most this share of the visible part of the card.
const BLOCK_FIT = 0.9;
const TOP_CUT_MARGIN = 24;
// How many times the camera moves to clear the top edge before it settles for the position that slices the fewest.
const TOP_CUT_PASSES = 3;

// ---------- which shot ----------

/** The page a shot is of: extra pages carry a prefix ("x1-d-full"), the site's own page has none. */
export const pageOf = (shotId: string): string => shotId.match(/^x\d+-/)?.[0] ?? '';

/** The full-page capture of the same page, in the given viewport. */
export const fullShotOf = (site: SiteData, shot: Shot, viewport: Shot['viewport'] = shot.viewport): Shot | undefined =>
  site.shots.find((s) => s.id === `${pageOf(shot.id)}${viewport === 'desktop' ? 'd' : 'm'}-full`);

/** The boxes of the shot that look like `box` (same kind and text): a store repeats its buttons and pictures. */
const lookAlikes = (site: SiteData, shot: Shot, box: Box): Box[] =>
  site.boxes.filter((b) => b.shotId === shot.id && b.kind === box.kind && b.text === box.text);

/** The look-alike that sits in the same section as `box`, when the box has one: it is the very element the director chose. */
const inSectionOf = (box: Box, candidates: readonly Box[]): Box | undefined =>
  box.sectionId === undefined ? undefined : candidates.find((b) => b.sectionId === box.sectionId);

/** The same element in another shot: the look-alike of its own section, else the first look-alike. */
const sameElement = (site: SiteData, shot: Shot, box: Box): Box | undefined => {
  const candidates = lookAlikes(site, shot, box);
  return inSectionOf(box, candidates) ?? candidates[0];
};

export type Take = { shot: Shot; box: Box | undefined };

/**
 * The director picks a shot and a box in it (`boxIndex` counts the boxes of that shot); each format films the viewport
 * that reads best in it, so the same element is looked up in the other viewport's shots of that page: by kind and text,
 * and in the same section when the box has one (a store repeats its buttons and pictures). A shot of the page that has
 * the element in its section wins over an earlier one that has only a look-alike from another section.
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
  if (!box) return { shot: alternatives[0] ?? shot, box: undefined };
  for (const alternative of alternatives) {
    const match = inSectionOf(box, lookAlikes(site, alternative, box));
    if (match) return { shot: alternative, box: match };
  }
  for (const alternative of alternatives) {
    const match = lookAlikes(site, alternative, box)[0];
    if (match) return { shot: alternative, box: match };
  }
  return { shot, box };
};

/** UiFocus: the director's take, or the full page of the same viewport when a one-screen shot cannot center the target. */
export const focusShot = (site: SiteData, scene: Scene, format: Format): Take => {
  const take = resolveShot(site, scene.shotId, scene.boxIndex, format);
  if (!take.box || canCenter(take.shot, take.box, format, site.boxes, site.blocks)) return take;
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

/** What the camera aims at for a box with no block to frame: a heading stands for what it titles (card, feature, section), 4 headings tall. */
export const focusRegion = (box: Box): Box =>
  box.kind === 'heading' ? { ...box, x: box.x - box.w * 0.08, y: box.y - box.h * 0.6, w: box.w * 1.16, h: box.h * 4 } : box;

/**
 * The card of the page a box sits in: the smallest block of the shot that holds the box's center, when the camera can
 * frame it whole at `scaleFor(block)` (card pixels per shot pixel): its height within 90% of the visible part of the
 * card, its width within the card's. Undefined when there is none or it does not fit.
 */
const targetBlock = (box: Box, shot: Shot, format: Format, blocks: readonly Block[], scaleFor: (block: Block) => number): Block | undefined => {
  const { cardW, focusY } = stageLayout(format);
  const block = blockOf(blocks, shot.id, box);
  if (!block) return undefined;
  const scale = scaleFor(block);
  return block.h * scale <= BLOCK_FIT * 2 * focusY && block.w * scale <= cardW ? block : undefined;
};

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
 * Moves the camera so that the top edge of the view slices through no box (a heading cut mid-glyph reads as a bug) and
 * no block (the last lines of the card above read as a cut card). For each one it slices, the move that shows it whole or
 * pushes it out of view, as long as `target` stays in view and the view does not go above the top of the shot; of those,
 * the one whose new top slices the fewest, then the smaller. The new top is checked again, up to 3 moves; when no
 * position clears everything, the camera keeps the one that slices the fewest.
 */
const avoidTopCut = (
  camera: Camera,
  scale: number,
  shot: Shot,
  format: Format,
  boxes: readonly Box[],
  blocks: readonly Block[],
  target: Region | undefined,
): Camera => {
  const { focusY } = stageLayout(format);
  const visible = (2 * focusY) / scale;
  const own: Region[] = [...boxes, ...blocks].filter((r) => r.shotId === shot.id);
  const sliced = (top: number): Region[] => (top <= 0 ? [] : own.filter((r) => r.y < top && r.y + r.h > top));
  const allowed = (top: number): boolean => top >= 0 && (!target || (target.y >= top && target.y + target.h <= top + visible));
  const start = camera.y - focusY / scale;
  const tried = [start];
  let top = start;
  for (let pass = 0; pass < TOP_CUT_PASSES && sliced(top).length > 0; pass++) {
    const from = top;
    const [next] = sliced(from)
      .flatMap((r) => [r.y - TOP_CUT_MARGIN, r.y + r.h + TOP_CUT_MARGIN])
      .filter((t) => allowed(t) && !tried.includes(t))
      .sort((a, b) => sliced(a).length - sliced(b).length || Math.abs(a - from) - Math.abs(b - from));
    if (next === undefined) break;
    tried.push(next);
    top = next;
  }
  const best = tried.reduce((kept, t) => (sliced(t).length < sliced(kept).length ? t : kept));
  return best === start ? camera : { ...camera, y: best + focusY / scale };
};

/** Whether the camera can hold the target at the focus point: the shot runs on far enough below it to fill the card. */
const canCenter = (shot: Shot, box: Box, format: Format, boxes: readonly Box[], blocks: readonly Block[] = []): boolean => {
  const { cardH, focusY } = stageLayout(format);
  const camera = focusCamera(box, shot, format, boxes, blocks);
  const scale = placeShot(shot, camera, format, boxes).scale;
  return (shot.height - camera.y) * scale >= cardH - focusY;
};

// ---------- moves ----------

/**
 * UiFocus: the camera starts wide on the real UI, a little above where it lands, and eases down and in to the element
 * that backs the caption, like a scroll that settles. It aims at the card of the page the element is in when it can frame it
 * whole (see targetBlock), else at the element (see focusRegion). It zooms until the target takes 78% of the card's
 * width or 60% of its height, within the limits of the shot's viewport, and pans sideways only when the view gets
 * narrower than most of the content. The top edge rule (see avoidTopCut) then moves the landing, in up to 3 moves, so that
 * the top of the view slices no box and no card, and the opening follows the landing. `blocks` are the cards of the
 * capture: a capture without them aims at the element, and the top edge rule has the boxes alone to go by.
 */
export const focusMove = (box: Box | undefined, shot: Shot, format: Format, boxes: readonly Box[] = [], blocks: readonly Block[] = []): Move => {
  const { cardW, cardH } = stageLayout(format);
  const base = baseScale(shot, cardW, boxes);
  const { x0, x1 } = contentSpan(shot, boxes);
  const middle = contentMiddle(shot, boxes);
  const maxZoom = shot.viewport === 'mobile' ? PHONE_MAX_ZOOM : DESKTOP_MAX_ZOOM;
  const zoomFor = (target: Region): number =>
    Math.max(base, Math.min(MAX_SCALE, base * maxZoom, (cardW * TARGET_WIDTH) / target.w, (cardH * TARGET_HEIGHT) / target.h));
  const block = box && targetBlock(box, shot, format, blocks, zoomFor);
  const target = block ?? (box ? focusRegion(box) : { x: 0, y: 0, w: shot.width, h: Math.min(shot.height, cardH / base) });
  const scale = zoomFor(target);
  const pan = cardW / scale < (x1 - x0) * 0.8;
  const targetY = target.y + target.h / 2;
  const to = avoidTopCut({ scale: scale / base, x: pan ? target.x + target.w / 2 : middle, y: targetY }, scale, shot, format, boxes, blocks, block ?? box);
  // Anchored to the landing, not to the target: the top edge rule may move the landing up or down.
  const from: Camera = { scale: 1, x: middle, y: to.y - (cardH * OPENING_DROP) / base };
  return { from, to };
};

/** Where UiFocus's camera lands: see focusMove. */
export const focusCamera = (box: Box | undefined, shot: Shot, format: Format, boxes: readonly Box[] = [], blocks: readonly Block[] = []): Camera =>
  focusMove(box, shot, format, boxes, blocks).to;

/**
 * UiScroll: glides down the page at one scale, from its top to the target (or a little under half the page): the card of
 * the page the target is in when it fits the view whole (see targetBlock), else the target itself.
 */
export const scrollMove = (box: Box | undefined, shot: Shot, format: Format, boxes: readonly Box[] = [], blocks: readonly Block[] = []): Move => {
  const { cardW, cardH, focusY } = stageLayout(format);
  const base = baseScale(shot, cardW, boxes);
  const x = contentMiddle(shot, boxes);
  const top = focusY / base;
  const target = box && (targetBlock(box, shot, format, blocks, () => base) ?? box);
  const end = target ? target.y + target.h / 2 : Math.min(shot.height - cardH / base / 2, top + shot.height * 0.45);
  return { from: { scale: 1, x, y: top }, to: avoidTopCut({ scale: 1, x, y: end }, base, shot, format, boxes, blocks, target) };
};

/** The camera at progress `p` (0 to 1) of a move: the zoom grows by the same factor at each step, the pan in equal steps. */
export const cameraAt = ({ from, to }: Move, p: number): Camera => ({
  scale: from.scale ** (1 - p) * to.scale ** p,
  x: from.x * (1 - p) + to.x * p,
  y: from.y * (1 - p) + to.y * p,
});
