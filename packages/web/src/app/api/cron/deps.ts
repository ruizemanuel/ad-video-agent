// What the cron routes need from outside: the store and the blob store, buy to ask the chain about a payment, and the
// refunds' adapter to ask it about a refund (and to refund an order whose run was lost).
// The service builds them from its settings; a test hands the routes its doubles instead.
import { getAdapters } from '../../../adapters';
import type { BlobPort, BuyPort, OrderStore, RefundPort } from '../../../ports';

export type CronDeps = { store: OrderStore; blob: BlobPort; buy: BuyPort; refunds: RefundPort };

let given: CronDeps | undefined;
let built: Promise<CronDeps> | undefined;

/** For tests: the doubles the routes run on from now on. `undefined` goes back to the service's own. */
export function setCronDeps(deps: CronDeps | undefined): void {
  given = deps;
}

export async function cronDeps(): Promise<CronDeps> {
  if (given !== undefined) return given;
  built ??= getAdapters().then(({ store, blob, buy, refunds }) => ({ store, blob, buy, refunds }));
  return built;
}
