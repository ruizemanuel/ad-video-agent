// GET /api/cron/reconcile: the reconciliation. The Cloudflare Worker in packages/clock calls it every 10 minutes, and
// Vercel's cron once a day as the backstop (see vercel.ts); both with the secret, and nobody else.
import { MAX_REFUND_FEE_ATOMIC } from '../../../../adapters/real/refunds';
import { env } from '../../../../env';
import { reconcile } from '../../../../maintenance/reconcile';
import { runStatus } from '../../../../payments/orders';
import { NO_STORE, refuseWithoutSecret } from '../auth';
import { cronDeps } from '../deps';

export async function GET(req: Request): Promise<Response> {
  const refused = refuseWithoutSecret(req);
  if (refused !== null) return refused;
  const { store, buy, refunds, alerts } = await cronDeps();
  const { PAYTO_ADDRESS, PRICE_ATOMIC, REFUND_DAILY_CAP_USD } = env();
  const result = await reconcile(
    {
      store,
      buy,
      refunds,
      payTo: PAYTO_ADDRESS,
      refundDailyCapUsd: REFUND_DAILY_CAP_USD,
      // A refund at the full price, and the most its gas may cost.
      refundAtMostAtomic: PRICE_ATOMIC + MAX_REFUND_FEE_ATOMIC,
      runStatus,
      alerts,
    },
    new Date(),
  );
  return Response.json(result, { headers: NO_STORE });
}
