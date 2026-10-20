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
/** A part of a shot, in shot pixels: a box, a block, or what the camera aims at. `clippedTop`: see Box. */
type Region = { x: number; y: number; w: number; h: number; clippedTop?: true };

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

/**
 * UiFocus: the director's take, or the full page of the same viewport when a one-screen shot cannot center the target or
 * frame it cleanly (see Landing): a section shot starts partway down the page, and the element exists whole in the full page.
 */
export const focusShot = (site: SiteData, scene: Scene, format: Format): Take => {
  const take = resolveShot(site, scene.shotId, scene.boxIndex, format);
  if (!take.box) return take;
  const keeps = canCenter(take.shot, take.box, format, site.boxes, site.blocks) && focusLanding(take.box, take.shot, format, site.boxes, site.blocks).clean;
  if (keeps) return take;
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
 * The lowest the top of the view can go, in shot pixels, at `scale` card pixels per shot pixel: there the shot ends at
 * the bottom of the card, and placeShot pulls any lower view back up to it (0 for a shot shorter than the card).
 */
const lowestTop = (shot: Shot, scale: number, format: Format): number => Math.max(0, shot.height - stageLayout(format).cardH / scale);

// How far, in shot pixels, an edge may be from the top of the view and still count as on it: placeShot gives a view back
// with float noise (a top flush on 562 comes back as 562.0000000000001).
const EDGE_TOLERANCE = 0.5;

const holds = (outer: Region, inner: Region): boolean =>
  outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.w >= inner.x + inner.w && outer.y + outer.h >= inner.y + inner.h;

/**
 * Whether the top edge of a view whose top is at `top` cuts through the region. One the capture clipped at the top of its
 * shot (`clippedTop`) goes on above it, so a view from the top of the shot cuts it too.
 */
const cutAt = (region: Region, top: number): boolean =>
  (region.clippedTop === true || region.y < top - EDGE_TOLERANCE) && region.y + region.h > top + EDGE_TOLERANCE;

/** Whether the target is whole in a view from `top`, `visible` shot pixels tall (no target: nothing to keep). */
const wholeIn = (target: Region | undefined, top: number, visible: number): boolean =>
  !target || (!cutAt(target, top) && target.y >= top - EDGE_TOLERANCE && target.y + target.h <= top + visible + EDGE_TOLERANCE);

/**
 * What the top edge of a view aimed at `target` must not cut: the boxes and blocks of the shot, but for the blocks that
 * hold the target. Those are the page around it (its own card when that is too tall to frame, the panel around it), and
 * the top edge may pass through them.
 */
const obstacles = (shot: Shot, boxes: readonly Box[], blocks: readonly Block[], target: Region | undefined): Region[] => [
  ...boxes.filter((b) => b.shotId === shot.id),
  ...blocks.filter((b) => b.shotId === shot.id && !(target && b !== target && holds(b, target))),
];

// How a top for the view ranks, best first, compared item by item (see avoidTopCut).
type TopRank = [cuts: number, notWhole: number, flush: number, hidden: number, distance: number];
const better = (a: TopRank, b: TopRank): boolean => {
  const i = a.findIndex((value, n) => value !== b[n]);
  return i >= 0 && a[i]! < b[i]!;
};

type TopCut = {
  camera: Camera;
  /** Card pixels per shot pixel at the landing. */
  scale: number;
  shot: Shot;
  format: Format;
  boxes: readonly Box[];
  blocks: readonly Block[];
  target: Region | undefined;
  /** The lowest top the view may have; by default where placeShot stops it (see lowestTop). Infinity: as if the shot ran on. */
  lowest?: number;
};

/**
 * Moves the camera so that the top edge of the view cuts through no box (a heading cut mid-glyph reads as a bug) and no
 * block (the last lines of the card above read as a cut card), see obstacles and cutAt, on the view the frame really
 * shows: its top never goes above the top of the shot nor below `lowest`, so a camera aimed lower is measured where
 * placeShot puts it.
 *
 * The tops it weighs are where the camera aims (held within those limits), the two limits, and for each box and block of
 * the shot the one that shows it whole and the one that pushes it out of view, 24 px clear of it, or else flush with
 * it (cards closer together than that). Of those, the one that cuts the fewest; then one that keeps `target` whole above
 * the platform UI; then one 24 px clear; then the one that hides the least of the target; then the nearest to where the
 * camera aims. When no clean top keeps the target whole (it sits too near the end of the shot, or is taller than the
 * view), the target gives way, as little as it can.
 */
const avoidTopCut = ({ camera, scale, shot, format, boxes, blocks, target, lowest = lowestTop(shot, scale, format) }: TopCut): Camera => {
  const { focusY } = stageLayout(format);
  const visible = (2 * focusY) / scale;
  const own: Region[] = [...boxes, ...blocks].filter((r) => r.shotId === shot.id);
  const kept = obstacles(shot, boxes, blocks, target);
  const aimed = camera.y - focusY / scale;
  const start = Math.min(Math.max(aimed, 0), lowest);
  const hidden = (top: number): number => (target ? Math.min(target.h, Math.max(0, top - target.y) + Math.max(0, target.y + target.h - (top + visible))) : 0);
  const rank = ({ top, flush }: { top: number; flush: boolean }): TopRank => [
    kept.filter((r) => cutAt(r, top)).length,
    wholeIn(target, top, visible) ? 0 : 1,
    flush ? 1 : 0,
    hidden(top),
    Math.abs(top - start),
  ];
  const clear = [start, 0, ...(Number.isFinite(lowest) ? [lowest] : []), ...own.flatMap((r) => [r.y - TOP_CUT_MARGIN, r.y + r.h + TOP_CUT_MARGIN])];
  const flush = own.flatMap((r) => [r.y, r.y + r.h]);
  // The first of equals is kept, and the first is where the camera aims.
  const best = [...clear.map((top) => ({ top, flush: false })), ...flush.map((top) => ({ top, flush: true }))]
    .filter(({ top }) => top >= 0 && top <= lowest)
    .map((candidate) => ({ top: candidate.top, rank: rank(candidate) }))
    .reduce((winner, candidate) => (better(candidate.rank, winner.rank) ? candidate : winner)).top;
  // A camera aimed above the top of the shot is left as it is: placeShot shows the top of the shot either way, and the
  // opening above it too. One aimed below `lowest` lands where the view stops, so the opening is anchored to the landing
  // the frame shows.
  return best === start && aimed <= start ? camera : { ...camera, y: best + focusY / scale };
};

/**
 * Where a UI scene's camera lands, and whether the landing is clean: on the view the frame shows (see placeShot), the top
 * edge cuts nothing it must not (see obstacles; what the capture clipped at the top of a one-screen shot counts as cut
 * by a view from there), and the target (the card the camera aims at, else the element) is whole above the platform UI.
 * Edges within half a shot pixel count as on the top of the view.
 */
export type Landing = { camera: Camera; clean: boolean };

const landing = (shot: Shot, camera: Camera, format: Format, boxes: readonly Box[], blocks: readonly Block[], target: Region | undefined): Landing => {
  const placed = placeShot(shot, camera, format, boxes);
  const top = -placed.y / placed.scale;
  const visible = (2 * stageLayout(format).focusY) / placed.scale;
  const clean = obstacles(shot, boxes, blocks, target).every((r) => !cutAt(r, top)) && wholeIn(target, top, visible);
  return { camera, clean };
};

// ---------- moves ----------

type Aim = { aim: Camera; scale: number; target: Region | undefined };

/** UiFocus's aim before the top edge rule (see focusMove): the camera on the target, its scale, and the target. */
const focusAim = (box: Box | undefined, shot: Shot, format: Format, boxes: readonly Box[], blocks: readonly Block[]): Aim => {
  const { cardW, cardH } = stageLayout(format);
  const base = baseScale(shot, cardW, boxes);
  const { x0, x1 } = contentSpan(shot, boxes);
  const maxZoom = shot.viewport === 'mobile' ? PHONE_MAX_ZOOM : DESKTOP_MAX_ZOOM;
  const zoomFor = (target: Region): number =>
    Math.max(base, Math.min(MAX_SCALE, base * maxZoom, (cardW * TARGET_WIDTH) / target.w, (cardH * TARGET_HEIGHT) / target.h));
  const block = box && targetBlock(box, shot, format, blocks, zoomFor);
  const region = block ?? (box ? focusRegion(box) : { x: 0, y: 0, w: shot.width, h: Math.min(shot.height, cardH / base) });
  const scale = zoomFor(region);
  const pan = cardW / scale < (x1 - x0) * 0.8;
  const aim = { scale: scale / base, x: pan ? region.x + region.w / 2 : contentMiddle(shot, boxes), y: region.y + region.h / 2 };
  return { aim, scale, target: block ?? box };
};

/**
 * Whether the camera can hold the target at the focus point: the landing it would pick if the shot ran on (the top edge
 * rule with no lowest top) is one the shot reaches, running on far enough below it to fill the card.
 */
const canCenter = (shot: Shot, box: Box, format: Format, boxes: readonly Box[], blocks: readonly Block[] = []): boolean => {
  const { cardH, focusY } = stageLayout(format);
  const { aim, scale, target } = focusAim(box, shot, format, boxes, blocks);
  const camera = avoidTopCut({ camera: aim, scale, shot, format, boxes, blocks, target, lowest: Infinity });
  return (shot.height - camera.y) * scale >= cardH - focusY;
};

/** Where UiFocus lands (see focusMove), and whether that landing is clean (see Landing). */
export const focusLanding = (box: Box | undefined, shot: Shot, format: Format, boxes: readonly Box[] = [], blocks: readonly Block[] = []): Landing => {
  const { aim, scale, target } = focusAim(box, shot, format, boxes, blocks);
  return landing(shot, avoidTopCut({ camera: aim, scale, shot, format, boxes, blocks, target }), format, boxes, blocks, target);
};

/**
 * UiFocus: the camera starts wide on the real UI, a little above where it lands, and eases down and in to the element
 * that backs the caption, like a scroll that settles. It aims at the card of the page the element is in when it can frame it
 * whole (see targetBlock), else at the element (see focusRegion). It zooms until the target takes 78% of the card's
 * width or 60% of its height, within the limits of the shot's viewport, and pans sideways only when the view gets
 * narrower than most of the content. The top edge rule (see avoidTopCut) then moves the landing so that the top of the
 * view the frame shows slices no box and no card, and the opening follows the landing. `blocks` are the cards of the
 * capture: a capture without them aims at the element, and the top edge rule has the boxes alone to go by.
 */
export const focusMove = (box: Box | undefined, shot: Shot, format: Format, boxes: readonly Box[] = [], blocks: readonly Block[] = []): Move => {
  const { cardW, cardH } = stageLayout(format);
  const base = baseScale(shot, cardW, boxes);
  const to = focusLanding(box, shot, format, boxes, blocks).camera;
  // Anchored to the landing, not to the target: the top edge rule may move the landing up or down.
  const from: Camera = { scale: 1, x: contentMiddle(shot, boxes), y: to.y - (cardH * OPENING_DROP) / base };
  return { from, to };
};

/** Where UiFocus's camera lands: see focusMove. */
export const focusCamera = (box: Box | undefined, shot: Shot, format: Format, boxes: readonly Box[] = [], blocks: readonly Block[] = []): Camera =>
  focusMove(box, shot, format, boxes, blocks).to;

/** Where UiScroll lands (see scrollMove), and whether that landing is clean (see Landing). */
export const scrollLanding = (box: Box | undefined, shot: Shot, format: Format, boxes: readonly Box[] = [], blocks: readonly Block[] = []): Landing => {
  const { cardW, cardH, focusY } = stageLayout(format);
  const base = baseScale(shot, cardW, boxes);
  const target = box && (targetBlock(box, shot, format, blocks, () => base) ?? box);
  const end = target ? target.y + target.h / 2 : Math.min(shot.height - cardH / base / 2, focusY / base + shot.height * 0.45);
  const camera = avoidTopCut({ camera: { scale: 1, x: contentMiddle(shot, boxes), y: end }, scale: base, shot, format, boxes, blocks, target });
  return landing(shot, camera, format, boxes, blocks, target);
};

/**
 * UiScroll: glides down the page at one scale, from its top to the target (or a little under half the page): the card of
 * the page the target is in when it fits the view whole (see targetBlock), else the target itself, with the top edge
 * rule (see avoidTopCut) on where it lands.
 */
export const scrollMove = (box: Box | undefined, shot: Shot, format: Format, boxes: readonly Box[] = [], blocks: readonly Block[] = []): Move => {
  const { cardW, focusY } = stageLayout(format);
  const base = baseScale(shot, cardW, boxes);
  return { from: { scale: 1, x: contentMiddle(shot, boxes), y: focusY / base }, to: scrollLanding(box, shot, format, boxes, blocks).camera };
};

/** The camera at progress `p` (0 to 1) of a move: the zoom grows by the same factor at each step, the pan in equal steps. */
export const cameraAt = ({ from, to }: Move, p: number): Camera => ({
  scale: from.scale ** (1 - p) * to.scale ** p,
  x: from.x * (1 - p) + to.x * p,
  y: from.y * (1 - p) + to.y * p,
});
