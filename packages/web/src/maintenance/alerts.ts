// What the alerts say: each is built here, so every one names an order the same way and says what to do. An alert goes to
// a topic that a third party keeps for a while (see adapters/real/alerts.ts): it holds only the start of an order id,
// enough to find the order in the store and too little to read it with, and otherwise only what the chain shows anyway.
import { formatUnits } from 'viem';
import type { RunStatus } from '../payments/orders';
import { TOKENS, tokenSymbol, type TokenSymbol } from '../payments/tokens';
import type { SettledPayment } from '../payments/x402';
import type { Alert } from '../ports';

/** The start of an order id: `ord_` and six of its characters. */
export const shortOrderId = (orderId: string): string => `${orderId.slice(0, 10)}…`;

const shortAddress = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;

const RETRY = 'Then: pnpm --filter @app/web refund:retry <order id>.';

/** What to do about a refund that could not be paid, by why (the order's `failureReason`). */
const NEXT_STEP: Record<string, string> = {
  'refund-daily-cap': `Today's refunds reached REFUND_DAILY_CAP_USD: raise it, or wait for the next UTC day. ${RETRY}`,
  insufficient_balance: `Load the refund wallet with the order's token (the amount and its gas). ${RETRY}`,
  fee_too_high: `Its gas would cost more than a refund may spend on it: wait for cheaper gas. ${RETRY}`,
  'refund-reverted': 'It was mined and reverted, so no money moved: pay it back by hand.',
  'refund-unconfirmed': `It was sent and is not mined: look its hash up first (the reconciliation keeps looking too). ${RETRY}`,
  'refund-dead': `It can never be mined. ${RETRY}`,
  'refund-unsigned': `No refund was signed for it. ${RETRY}`,
};

/** An order handed to a person as `refund_failed`: the money is owed. */
export function refundFailedAlert(orderId: string, why: string): Alert {
  const next = NEXT_STEP[why] ?? `Look the order up in the store. ${RETRY}`;
  return { title: 'Refund not paid', message: `${shortOrderId(orderId)} is refund_failed (${why}). ${next}`, priority: 'high' };
}

/** A payment that settled to the service with no order to run: the money has nowhere to go. */
export function settledWithoutOrderAlert(payment: SettledPayment): Alert {
  const token = tokenSymbol(payment.asset) ?? payment.asset;
  const message = `A payment in ${token} from ${shortAddress(payment.payer)} settled with no order to run (tx ${payment.txHash}). Pay it back by hand.`;
  return { title: 'Payment with no order', message, priority: 'high' };
}

/** An order the reconciliation refunded because its run was lost, or never started: nothing to do but find out why. */
export function runLostAlert(orderId: string, reason: 'run-lost' | 'run-not-started', run: RunStatus): Alert {
  const what =
    reason === 'run-not-started'
      ? `${shortOrderId(orderId)} never started: every start failed for two hours.`
      : `${shortOrderId(orderId)}'s run was ${run} two hours or more after its payment.`;
  return { title: 'Run lost, refunded', message: `${what} Its refund is on its way.`, priority: 'default' };
}

/** What the daily summary says: what is open, and what the wallets hold (null: could not be read). */
export type DailySummary = {
  /** The orders `refund_failed`. */
  refundsNotPaid: number;
  /** The orders past two hours whose run says it is running: left until a day after their payment. */
  runsStillRunning: number;
  refundWallet: Record<TokenSymbol, bigint> | null;
  /** In USDT. */
  spendWallet: bigint | null;
  /** What one refund at the full price may take from the refund wallet, its gas included, in atomic units. */
  refundAtMost: bigint;
  /** What one machine may cost the spend wallet, in atomic units. */
  machineAtMost: bigint;
};

const SYMBOLS = Object.keys(TOKENS) as TokenSymbol[];
/** Atomic units of a 6-decimal token, as a number of tokens: 2500000 is 2.5. */
const tokens = (atomic: bigint): string => formatUnits(atomic, 6);

/**
 * The summary the reconciliation sends once a day, even when nothing is open: a day without it says the clock, the route
 * or the alerts are down. It rings when something is open, or a wallet cannot pay for one more order.
 */
export function dailySummaryAlert(summary: DailySummary): Alert {
  const { refundWallet, spendWallet, refundAtMost, machineAtMost } = summary;
  const lines = [
    `Refunds not paid: ${summary.refundsNotPaid}`,
    `Runs past 2 h that say they are running: ${summary.runsStillRunning}`,
    `Refund wallet: ${refundWallet === null ? 'could not be read' : SYMBOLS.map((symbol) => `${tokens(refundWallet[symbol])} ${symbol}`).join(', ')}`,
    `Spend wallet: ${spendWallet === null ? 'could not be read' : `${tokens(spendWallet)} USDT`}`,
  ];
  const warnings = [
    ...(refundWallet === null ? [] : SYMBOLS.filter((symbol) => refundWallet[symbol] < refundAtMost)).map(
      (symbol) => `The refund wallet cannot pay one refund in ${symbol}: one takes up to ${tokens(refundAtMost)}.`,
    ),
    ...(spendWallet !== null && spendWallet < machineAtMost ? [`The spend wallet cannot pay one machine: one costs up to ${tokens(machineAtMost)}.`] : []),
  ];
  const open = summary.refundsNotPaid > 0 || summary.runsStillRunning > 0 || warnings.length > 0;
  return { title: 'Daily summary', message: [...lines, ...warnings].join('\n'), priority: open ? 'high' : 'default' };
}
