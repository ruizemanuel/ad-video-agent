// Retries the refund of an order left `refund_failed`, for a person: it moves the order back to `refunding`, signs its
// refund (or takes the one it kept) and sends it, in one go; the reconciliation confirms it later (see retryRefund). It
// runs on the service's own adapters and settings, read from the environment as the deployment reads them, and prints the
// order id, its status and the refund's hash, nothing else.
//
//   pnpm --filter @app/web refund:retry <orderId>
import { getAdapters } from '../src/adapters';
import { env } from '../src/env';
import { RefundNotRetryable, retryRefund } from '../src/payments/refunds';

const ORDER_ID = /^ord_[a-z2-7]{24}$/;

async function main(orderId: string | undefined): Promise<number> {
  if (orderId === undefined || !ORDER_ID.test(orderId)) {
    console.error('Usage: pnpm --filter @app/web refund:retry <orderId>');
    return 2;
  }
  const { store, refunds } = await getAdapters();
  try {
    const { status, txHash } = await retryRefund(orderId, { store, refunds, dailyCapUsd: env().REFUND_DAILY_CAP_USD });
    console.log(orderId, status, txHash ?? '-');
    return status === 'refunding' ? 0 : 1;
  } catch (error) {
    // Only the order, where it stands, and what kind of failure: an adapter's message is not printed.
    const status = (await store.getOrder(orderId).catch(() => null))?.status ?? 'unknown';
    console.error(orderId, status, error instanceof RefundNotRetryable ? error.message : error instanceof Error ? error.name : 'error');
    return 1;
  }
}

process.exitCode = await main(process.argv[2]);
