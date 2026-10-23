// What the two OrderStore adapters (Postgres and files) have to do the same way.
import { randomBytes } from 'node:crypto';
import { VIDEO_STATUSES, type Order } from '../ports';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** `ord_` and 24 random base32 characters: 120 bits, so an id cannot be guessed and shows in a URL as it is. */
export function newOrderId(): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of randomBytes(15)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return `ord_${out}`;
}

/** A cost in dollars, kept to the millionth. A cost that is not a finite, non-negative number would corrupt every cap. */
export function roundUsd(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) throw new RangeError(`A cost must be a finite, non-negative number of dollars; got ${usd}.`);
  return Math.round(usd * 1e6) / 1e6;
}

/** Atomic units of a 6-decimal token (USDT, USDC) in dollars. */
export const atomicToUsd = (atomic: bigint): number => Number(atomic) / 1e6;

/** An order that has its video or is on its way to it, as `holdsVideo` in db/schema.ts says it in SQL. */
export const holdsVideo = (o: Pick<Order, 'status' | 'deliveredAt'>): boolean =>
  (VIDEO_STATUSES as readonly string[]).includes(o.status) || (o.status === 'expired' && o.deliveredAt !== null);

/**
 * An order that holds a first-video promo slot, as `holdsPromoSlot` in db/schema.ts says it in SQL. (An order the
 * FileStore wrote before slots were kept has no `promoSlot` at all.)
 */
export const holdsPromoSlot = (o: Pick<Order, 'status' | 'deliveredAt' | 'promoSlot'>): boolean => typeof o.promoSlot === 'number' && holdsVideo(o);

/** The lowest promo slot in 1..`slots` that none of `held` is, or null when all of them are. */
export function lowestFreeSlot(held: Iterable<number | null>, slots: number): number | null {
  const taken = new Set(held);
  for (let slot = 1; slot <= slots; slot++) if (!taken.has(slot)) return slot;
  return null;
}

/** The patch without the keys that are `undefined`: a patch means "change these", not "erase these". */
export function defined<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>;
}
