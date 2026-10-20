// Whether a box of a shot is product UI (an image or a price in its section or card) or only marketing text. One
// definition for the code that checks an edit list, the model that writes it and the camera that films it.
import type { Block, Box, SiteData } from './site';

type Region = Pick<Box, 'x' | 'y' | 'w' | 'h'>;

/** Whether the center of the region is in the block, its edges included. */
const holdsCenter = (block: Block, region: Region): boolean => {
  const cx = region.x + region.w / 2;
  const cy = region.y + region.h / 2;
  return block.x <= cx && cx <= block.x + block.w && block.y <= cy && cy <= block.y + block.h;
};

/**
 * The card of the page a box sits in: the smallest block of the shot that holds the center of the box, edges included.
 * Of two blocks of the same size, the first in document order.
 */
export const blockOf = (blocks: readonly Block[], shotId: string, box: Region): Block | undefined =>
  blocks.filter((b) => b.shotId === shotId && holdsCenter(b, box)).sort((a, b) => a.w * a.h - b.w * b.h)[0];

const isPicture = (box: Box): boolean => box.kind === 'image' || box.kind === 'price';

/**
 * Whether the box `boxIndex` of the shot (counted among the boxes of that shot, as the director counts it) shows product
 * UI: the shot has an image or a price that is in the same section as the box (both sections known) or whose center lies
 * in the card the box is in (see blockOf; a capture without blocks has no cards). A box that is itself an image or a
 * price is product UI. A cta alone is not: a "sign up" button over text is marketing. False for a box that is not there.
 */
export const isProductTarget = (site: SiteData, shotId: string, boxIndex: number): boolean => {
  const boxes = site.boxes.filter((b) => b.shotId === shotId);
  const target = boxes[boxIndex];
  if (!target) return false;
  if (isPicture(target)) return true;
  const pictures = boxes.filter(isPicture);
  if (target.sectionId !== undefined && pictures.some((b) => b.sectionId === target.sectionId)) return true;
  const card = blockOf(site.blocks ?? [], shotId, target);
  return card !== undefined && pictures.some((b) => holdsCenter(card, b));
};
