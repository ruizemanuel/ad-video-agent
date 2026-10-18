// The cleanup, run by the cron once a day: an order is kept for 30 days from when it was made. Then its files are
// deleted and it expires (the status shows `expired` and the delivery links stop working).
import { ORDER_DAYS, type BlobPort, type OrderStore } from '../ports';

const DAY_MS = 24 * 60 * 60 * 1000;

export type CleanupDeps = {
  store: Pick<OrderStore, 'ordersToExpire' | 'transition'>;
  blob: Pick<BlobPort, 'deletePrefix'>;
};

/** The ids of the orders it expired. */
export type CleanupResult = { expired: string[] };

export async function cleanup(deps: CleanupDeps, now: Date): Promise<CleanupResult> {
  const { store, blob } = deps;
  const expired: string[] = [];
  for (const order of await store.ordersToExpire(new Date(now.getTime() - ORDER_DAYS * DAY_MS))) {
    try {
      // The files first: an order that expired with its files still there would never come up again. If this fails,
      // the order stays as it is and the next run tries again; the others are not held up.
      await blob.deletePrefix(`orders/${order.id}/`);
      if (await store.transition(order.id, 'expired')) expired.push(order.id);
    } catch (error) {
      console.error('[cleanup_error]', order.id, error instanceof Error ? error.message : String(error));
    }
  }
  return { expired };
}
