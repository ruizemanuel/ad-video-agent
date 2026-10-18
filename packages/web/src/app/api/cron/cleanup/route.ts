// GET /api/cron/cleanup: expires the orders that are 30 days old and deletes their files, once a day (see vercel.ts).
// Only Vercel's cron, with the secret.
import { cleanup } from '../../../../maintenance/cleanup';
import { NO_STORE, refuseWithoutSecret } from '../auth';
import { cronDeps } from '../deps';

export async function GET(req: Request): Promise<Response> {
  const refused = refuseWithoutSecret(req);
  if (refused !== null) return refused;
  const { store, blob } = await cronDeps();
  return Response.json(await cleanup({ store, blob }, new Date()), { headers: NO_STORE });
}
