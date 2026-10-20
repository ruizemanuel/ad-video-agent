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

// What makes a "price" box show money. The capture calls a price any short text with a currency symbol, a percentage, a
// currency code or a billing period, so "0% de comisión", the stat of a feature card, is a price box too: it takes a
// currency or a billing period, with a number, to be product UI.
const NUMBER = String.raw`\d[\d.,]*`;
const SYMBOL = '[$€£¥₹₩₽₺₫₪₱₦฿]';
const CODE =
  '(?:USDT|USDC|cUSD|USD|EUR|GBP|ARS|BRL|MXN|CLP|COP|PEN|UYU|BOB|PYG|VES|CAD|AUD|NZD|CHF|JPY|CNY|INR|KRW|RUB|TRY|ZAR|SEK|NOK|DKK|PLN|CZK|HUF|AED|SAR|ILS|NGN|KES|PHP|THB|IDR|VND|SGD|HKD|TWD)';
const PERIOD = '(?:mes|month|mo|año|ano|year|yr|semana|week|día|dia|day)';
// A symbol or a code beside a number ("US$ 10", "€9", "9 €", "ARS 4500"), in either order; the codes are in capitals.
const MONEY = new RegExp(
  String.raw`${SYMBOL}\s?${NUMBER}|${NUMBER}\s?${SYMBOL}|(?<![\p{L}\d])${CODE}\s?${NUMBER}|${NUMBER}\s?${CODE}(?!\p{L})`,
  'u',
);
// A number with a billing period ("4.990 / mes", "9 per month", "4990 por mes").
const BILLED = new RegExp(String.raw`${NUMBER}\s?(?:/|por|per|al|cada)\s?${PERIOD}(?!\p{L})`, 'iu');

const showsMoney = (text: string | undefined): boolean => text !== undefined && (MONEY.test(text) || BILLED.test(text));

// What the box is evidence of: an image, or a price that shows money.
const isPicture = (box: Box): boolean => box.kind === 'image' || (box.kind === 'price' && showsMoney(box.text));

/**
 * Whether the box `boxIndex` of the shot (counted among the boxes of that shot, as the director counts it) shows product
 * UI: the shot has an image or a price that shows money (a percentage alone is not one) in the same section as the box
 * (both sections known) or whose center lies in the card the box is in (see blockOf; a capture without blocks has no
 * cards). A box that is itself such an image or price is product UI. A cta alone is not: a "sign up" button over text is
 * marketing. False for a box that is not there.
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
