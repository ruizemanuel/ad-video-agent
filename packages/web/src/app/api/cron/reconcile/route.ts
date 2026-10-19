// GET /api/cron/reconcile: the reconciliation, every 10 minutes (see vercel.ts). Only Vercel's cron, with the secret.
import { env } from '../../../../env';
import { reconcile } from '../../../../maintenance/reconcile';
import { runStatus } from '../../../../payments/orders';
import { NO_STORE, refuseWithoutSecret } from '../auth';
import { cronDeps } from '../deps';

export async function GET(req: Request): Promise<Response> {
  const refused = refuseWithoutSecret(req);
  if (refused !== null) return refused;
  const { store, buy, refunds } = await cronDeps();
  const { PAYTO_ADDRESS, REFUND_DAILY_CAP_USD } = env();
  const result = await reconcile({ store, buy, refunds, payTo: PAYTO_ADDRESS, refundDailyCapUsd: REFUND_DAILY_CAP_USD, runStatus }, new Date());
  return Response.json(result, { headers: NO_STORE });
}
