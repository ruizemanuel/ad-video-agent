// The permit the rented VM carries: 32 random bytes, good for one order for 75 minutes. It goes into the VM's script,
// which the provider can read, so it is the only thing the VM holds and it opens nothing but that order's tasks. The
// service keeps only its sha256: a leak of the database does not leak a permit.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Order, OrderStore } from '../ports';

/** How long a permit works, from when the flow gives it. */
export const VM_TOKEN_MINUTES = 75;

/** When a permit given at `from` stops working. */
export const vmTokenExpiry = (from: Date): Date => new Date(from.getTime() + VM_TOKEN_MINUTES * 60_000);

/** The hash the store keeps, in hex. */
export const vmTokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

/** A new permit: `token` goes to the VM and nowhere else; `hash` is what is stored. */
export function issueVmToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: vmTokenHash(token) };
}

// What a token looks like in the header: it is base64url, so no other character is worth hashing.
const BEARER = /^Bearer ([A-Za-z0-9_-]{1,200})$/;

/**
 * The order a VM request is for: the one whose permit the `Authorization: Bearer` header carries, if it has not
 * expired. Null for anything else, and the caller says why to nobody.
 */
export async function orderForVmRequest(req: Request, store: Pick<OrderStore, 'orderByVmTokenHash'>, now: Date): Promise<Order | null> {
  const match = BEARER.exec(req.headers.get('authorization') ?? '');
  if (match === null) return null;
  const hash = vmTokenHash(match[1] as string);
  const order = await store.orderByVmTokenHash(hash);
  if (order === null || order.vmTokenHash === null || order.vmTokenExpiresAt === null) return null;
  // The store found it by the hash; this checks it really is that one, whatever the store's idea of equal.
  const [stored, given] = [Buffer.from(order.vmTokenHash), Buffer.from(hash)];
  if (stored.length !== given.length || !timingSafeEqual(stored, given)) return null;
  return order.vmTokenExpiresAt.getTime() > now.getTime() ? order : null;
}
