// What guards the cron routes: Vercel calls them with `Authorization: Bearer <CRON_SECRET>`, and nobody else may.
import { createHash, timingSafeEqual } from 'node:crypto';
import { env } from '../../../env';

/** Nothing here is for a cache to keep. */
export const NO_STORE = { 'cache-control': 'no-store' };

// Hashed first, so the comparison takes the same time for a header of any length.
const digest = (text: string): Buffer => createHash('sha256').update(text).digest();

/** Null when the call carries the secret; otherwise the 401 to answer with. It checks before anything is built or read. */
export function refuseWithoutSecret(req: Request): Response | null {
  const given = req.headers.get('authorization') ?? '';
  if (timingSafeEqual(digest(given), digest(`Bearer ${env().CRON_SECRET}`))) return null;
  return Response.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
}
