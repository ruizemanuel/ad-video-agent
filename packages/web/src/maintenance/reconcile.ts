// The reconciliation, run by the cron every 10 minutes. It closes what the paying request and the runs could not: a
// refund that landed after the flow gave up on it or stopped watching it (the run died, or the store failed between two
// writes), an order a run left refunding with no refund signed (handed to a person), a paid order whose run was lost
// (refunded here), a settlement that landed on chain but was never reported (the facilitator timed out, or the request
// died), an authorization that expired without settling, and a paid order whose run never started. It also keeps the
// refunds that could not be paid in the log, every run, until someone pays them by hand.
//
// The only refund it signs and sends is that of an order whose run was lost, through the same functions the flow uses
// (prepareRefund, then broadcastRefund): an order has one refund at most that can still be mined, so a run that wakes
// later finds that one and sends the same bytes, and the order is paid back once. Every other refund it only looks up.
//
// Each pass takes the oldest orders first, a bounded number of them, and the refunds' passes go before the payments'.
import { markPaidAndStart, startRun, type RunStatus } from '../payments/orders';
import { broadcastRefund, confirmRefund, prepareRefund } from '../payments/refunds';
import { SETTLEMENT_GRACE_SECONDS, type BuyPort, type Order, type OrderStore, type RefundPort, type RefundStatus } from '../ports';

const MINUTE_MS = 60_000;
/** How old an order has to be before this looks at it: the request that made it has had time to finish. */
const GRACE_MS = 5 * MINUTE_MS;
/**
 * How long a refund may go without a write before its order, still `refunding`, is taken as left by its run. The flow
 * watches a refund for about 10 minutes (40 looks, 15 s apart): this leaves it well past that.
 */
export const REFUND_WINDOW_MS = 30 * MINUTE_MS;
/**
 * How long after its payment a run may still be at work on its order. Longer than any run: VM, capture, script, music,
 * reviews, render and the refund's own watch together take well under an hour. After it, an order `refunding` with no
 * refund signed is handed to a person, and one still `paid` (with a run) or `running` is refunded as its run's loss.
 */
export const UNSIGNED_REFUND_AFTER_MS = 2 * 60 * MINUTE_MS;

// How many orders each pass takes at most, the oldest first. Each order of a pass may cost a few reads of the chain (the
// overdue runs' also a signature and a send), and the cron's call has a time limit: a backlog is worked through over the
// passes that follow, never all in one.
export const STALLED_REFUNDS_PER_PASS = 20;
export const UNSIGNED_REFUNDS_PER_PASS = 50;
export const OVERDUE_RUNS_PER_PASS = 10;
export const REFUND_FAILURES_PER_PASS = 50;
export const AWAITING_SETTLEMENT_PER_PASS = 25;
export const PAID_WITHOUT_RUN_PER_PASS = 25;

/** Why the order of a run that was lost is refunded: its `failureReason`, and its refund's. */
const RUN_LOST = 'run-lost';

/** What a run still at work reports. */
const AT_WORK: readonly RunStatus[] = ['pending', 'running'];

export type ReconcileDeps = {
  store: Pick<
    OrderStore,
    | 'ordersAwaitingSettlement'
    | 'paidWithoutRun'
    | 'runsOverdue'
    | 'refundFailures'
    | 'stalledRefunds'
    | 'unsignedRefunds'
    | 'findOrderByPayment'
    | 'getOrder'
    | 'transition'
    | 'setStep'
    | 'setRunId'
    | 'getRefund'
    | 'insertRefund'
    | 'updateRefund'
    | 'refundsSince'
    | 'refundsByNonce'
  >;
  buy: Pick<BuyPort, 'authorizationSettled'>;
  /** To read the chain about a refund, and to sign and send that of an order whose run was lost. */
  refunds: RefundPort;
  /** The wallet the payments go to (PAYTO_ADDRESS): a settlement counts only if it paid this one. */
  payTo: string;
  /** REFUND_DAILY_CAP_USD: what may be refunded in a UTC day, every order together. */
  refundDailyCapUsd: number;
  /** What the workflow runtime says of a run (`runStatus` in payments/orders). */
  runStatus: (runId: string) => Promise<RunStatus>;
};

/** The refunds that may still have landed: sent, or about to be. */
const MAY_HAVE_LANDED: readonly RefundStatus[] = ['prepared', 'broadcast', 'confirmed'];

/**
 * The ids of the orders it started, the ones it gave up as unpaid, the ones whose refund has failed, and the ones it
 * refunded because their run was lost.
 */
export type ReconcileResult = { started: string[]; unpaid: string[]; refundFailed: string[]; runLost: string[] };

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

/**
 * Whether the refund of an order the flow gave up on landed after all, by its hash: then the order goes back through
 * `refunding` (the only way) to `refunded`. A refund proven dead is given up on here too, for a person to retry.
 */
async function landedLate(orderId: string, deps: Pick<ReconcileDeps, 'store' | 'refunds'>): Promise<boolean> {
  const { store } = deps;
  let landed = false;
  await attempt(orderId, async () => {
    const refund = await store.getRefund(orderId);
    if (refund === null || !MAY_HAVE_LANDED.includes(refund.status)) return;
    if ((await confirmRefund(orderId, deps)) !== 'confirmed-unapplied') return;
    landed = (await store.transition(orderId, 'refunding')) && (await store.transition(orderId, 'refunded'));
    if (landed) console.error('[refund_landed_late]', orderId, refund.txHash);
  });
  return landed;
}

/**
 * An order its run left `refunding`: its refund is looked up by its hash, and the order moved where that says. Mined, it
 * is `refunded` (confirmRefund moves it); reverted, `refund_failed` (confirmRefund too); not mined, or proven dead, it is
 * handed to a person as `refund_failed`, where the pass below keeps looking it up and logging it.
 */
async function settleStalled(orderId: string, deps: Pick<ReconcileDeps, 'store' | 'refunds'>): Promise<void> {
  const { store } = deps;
  await attempt(orderId, async () => {
    const answer = await confirmRefund(orderId, deps);
    if (answer === 'confirmed') {
      console.error('[refund_landed_late]', orderId, (await store.getRefund(orderId))?.txHash ?? null);
    } else if (answer === 'pending' || answer === 'dead') {
      await store.transition(orderId, 'refund_failed', { failureReason: answer === 'dead' ? 'refund-dead' : 'refund-unconfirmed' });
    }
  });
}

/**
 * A paid order whose run should be over and has not let go of it: the run died with the order still `paid` or `running`
 * (the platform failed or cancelled it, the store was down for longer than its refund's watch, Workflow failed before the
 * first step). It is logged, and refunded as `run-lost` unless its run reports it is still at work: the order moves to
 * `refunding` and its refund is signed, kept and sent, as the flow does it. A refund that cannot be paid leaves it
 * `refund_failed` (the pass after this one logs it); the pass for stalled refunds looks the refund up later. A run
 * that cannot be asked does not hold the refund up: two hours after the payment, no run is still at work on its order,
 * and if one were, it would find the refund kept here and send the same one.
 */
async function refundLostRun(order: Order, deps: ReconcileDeps): Promise<boolean> {
  const { store, refunds, refundDailyCapUsd, runStatus } = deps;
  let refunded = false;
  await attempt(order.id, async () => {
    const run = order.runId === null ? 'missing' : await runStatus(order.runId);
    console.error('[order_stuck]', order.id, order.status, run);
    if (AT_WORK.includes(run)) return;
    const prepared = await prepareRefund(order.id, RUN_LOST, { store, refunds, dailyCapUsd: refundDailyCapUsd });
    // Its run moved it on meanwhile (delivered it, or refunded it): nothing of it is this pass's.
    if ('failed' in prepared && prepared.failed === 'not-refundable') return;
    refunded = true;
    if ('failed' in prepared) return;
    await store.setStep(order.id, 'refund', 'running');
    await broadcastRefund(order.id, { store, refunds });
  });
  return refunded;
}

export async function reconcile(deps: ReconcileDeps, now: Date): Promise<ReconcileResult> {
  const { store, buy, refunds, payTo } = deps;
  const result: ReconcileResult = { started: [], unpaid: [], refundFailed: [], runLost: [] };
  const olderThan = new Date(now.getTime() - GRACE_MS);
  const nowSeconds = BigInt(Math.floor(now.getTime() / 1000));
  const runsOverBefore = new Date(now.getTime() - UNSIGNED_REFUND_AFTER_MS);

  // The refunds first: an order waiting for its money back comes before any other.
  for (const order of await store.stalledRefunds(new Date(now.getTime() - REFUND_WINDOW_MS), STALLED_REFUNDS_PER_PASS)) {
    await settleStalled(order.id, { store, refunds });
  }
  // Nothing was signed, so nothing is looked up nor sent: the order goes to a person. A refund its run signs and sends
  // after all is still found, by its hash, in the pass for refund failures.
  for (const order of await store.unsignedRefunds(runsOverBefore, UNSIGNED_REFUNDS_PER_PASS)) {
    await attempt(order.id, async () => {
      await store.transition(order.id, 'refund_failed', { failureReason: 'refund-unsigned' });
    });
  }
  // After the unsigned refunds: an order whose refund this pass moved to `refunding` and then could not sign (the chain
  // could not be read) is handed to a person by the next pass, as any unsigned refund is, and not by this one.
  for (const order of await store.runsOverdue(runsOverBefore, OVERDUE_RUNS_PER_PASS)) {
    if (await refundLostRun(order, deps)) result.runLost.push(order.id);
  }
  // After every pass that may hand an order to a person, so that it is in this pass's log.
  for (const order of await store.refundFailures(REFUND_FAILURES_PER_PASS)) {
    if (await landedLate(order.id, { store, refunds })) continue;
    // What became of its refund, if it has one: its status and its hash say where to look.
    const refund = await store.getRefund(order.id).catch(() => null);
    console.error('[refund_failed]', order.id, refund?.status ?? null, refund?.txHash ?? null);
    result.refundFailed.push(order.id);
  }

  // The client was told its order id and status URL even when the settlement failed or timed out, so an order that
  // settled late is one to run.
  for (const order of await store.ordersAwaitingSettlement(olderThan, AWAITING_SETTLEMENT_PER_PASS)) {
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
        // The chain says this authorization can never settle: by its own clock it is past `validBefore` and the nonce was
        // never spent, or the nonce went to another transfer. This clock (which may run ahead of the chain's) is past it
        // too. If the order was paid while the chain was being asked, the move is refused and the order stays as it is.
        if (await store.transition(order.id, 'unpaid')) result.unpaid.push(order.id);
      }
      // `unknown`, `pending` (the chain says it can still settle), or `unsettled` within the grace minute: nothing yet.
    });
  }

  // Measured from the payment, so a run that the paying request is still starting is not started twice.
  for (const order of await store.paidWithoutRun(olderThan, PAID_WITHOUT_RUN_PER_PASS)) {
    await attempt(order.id, async () => {
      await startRun(order.id, store);
      result.started.push(order.id);
    });
  }
  return result;
}
