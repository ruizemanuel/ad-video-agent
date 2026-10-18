// GET /api/cron/reconcile: the reconciliation, every 10 minutes (see vercel.ts). Only Vercel's cron, with the secret.
import { env } from '../../../../env';
import { reconcile } from '../../../../maintenance/reconcile';
import { NO_STORE, refuseWithoutSecret } from '../auth';
import { cronDeps } from '../deps';

export async function GET(req: Request): Promise<Response> {
  const refused = refuseWithoutSecret(req);
  if (refused !== null) return refused;
  const { store, buy } = await cronDeps();
  return Response.json(await reconcile({ store, buy, payTo: env().PAYTO_ADDRESS }, new Date()), { headers: NO_STORE });
}
