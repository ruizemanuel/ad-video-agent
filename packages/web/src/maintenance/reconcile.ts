// The reconciliation, run by the cron every 10 minutes. It closes what the paying request could not: a settlement
// that landed on chain but was never reported (the facilitator timed out, or the request died), an authorization
// that expired without settling, a paid order whose run never started. It also keeps the refunds that could not be
// paid in the log, every run, until someone pays them by hand.
import { markPaidAndStart, startRun } from '../payments/orders';
import { SETTLEMENT_GRACE_SECONDS, type BuyPort, type OrderStore } from '../ports';

const MINUTE_MS = 60_000;
/** How old an order has to be before this looks at it: the request that made it has had time to finish. */
const GRACE_MS = 5 * MINUTE_MS;

export type ReconcileDeps = {
  store: Pick<OrderStore, 'ordersAwaitingSettlement' | 'paidWithoutRun' | 'refundFailures' | 'findOrderByPayment' | 'transition' | 'setStep' | 'setRunId'>;
  buy: Pick<BuyPort, 'authorizationSettled'>;
  /** The wallet the payments go to (PAYTO_ADDRESS): a settlement counts only if it paid this one. */
  payTo: string;
};

/** The ids of the orders it started, the ones it gave up as unpaid, and the ones whose refund has failed. */
export type ReconcileResult = { started: string[]; unpaid: string[]; refundFailed: string[] };

/**
 * One order at a time: what goes wrong with one (the chain does not answer, the run does not start) is logged and the
 * order is left as it was, so the next pass tries it again and the rest of this one is not held up.
 */
async function attempt(orderId: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    console.error('[reconcile_error]', orderId, error instanceof Error ? error.message : String(error));
  }
}

export async function reconcile(deps: ReconcileDeps, now: Date): Promise<ReconcileResult> {
  const { store, buy, payTo } = deps;
  const result: ReconcileResult = { started: [], unpaid: [], refundFailed: [] };
  const olderThan = new Date(now.getTime() - GRACE_MS);
  const nowSeconds = BigInt(Math.floor(now.getTime() / 1000));

  // The client was told its order id and status URL even when the settlement failed or timed out, so an order that
  // settled late is one to run.
  for (const order of await store.ordersAwaitingSettlement(olderThan)) {
    await attempt(order.id, async () => {
      const settlement = await buy.authorizationSettled({
        asset: order.asset,
        authorization: { from: order.payer, nonce: order.nonce, validAfter: order.validAfter.toString(), validBefore: order.validBefore.toString() },
        // Not only that the nonce was spent: that the service got the price. The payer can spend the nonce on a transfer to
        // themselves, which makes the settlement fail while the nonce looks used.
        to: payTo,
        value: order.amount,
      });
      if (settlement === 'settled') {
        // Found on the chain, which does not say which transaction settled it.
        const payment = { asset: order.asset, payer: order.payer, nonce: order.nonce, txHash: null };
        if ((await markPaidAndStart(payment, { store })) === 'started') result.started.push(order.id);
      } else if (settlement === 'unsettled' && nowSeconds >= order.validBefore + SETTLEMENT_GRACE_SECONDS) {
        // The token takes an authorization only before `validBefore`, by the chain's clock (this one may run ahead of it):
        // this one can never settle (nor could one whose nonce went to another transfer). If the order was paid while the
        // chain was being asked, the move is refused and the order stays as it is.
        if (await store.transition(order.id, 'unpaid')) result.unpaid.push(order.id);
      }
      // `unknown`, or `unsettled` while it still can: nothing to do yet.
    });
  }

  // Measured from the payment, so a run that the paying request is still starting is not started twice.
  for (const order of await store.paidWithoutRun(olderThan)) {
    await attempt(order.id, async () => {
      await startRun(order.id, store);
      result.started.push(order.id);
    });
  }

  for (const order of await store.refundFailures()) {
    console.error('[refund_failed]', order.id);
    result.refundFailed.push(order.id);
  }
  return result;
}
