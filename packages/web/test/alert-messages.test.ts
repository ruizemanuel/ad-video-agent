import { describe, expect, it } from 'vitest';
import { refundFailedAlert, runLostAlert, settledWithoutOrderAlert, settleFailedAlert, shortOrderId } from '../src/maintenance/alerts';
import { TOKENS } from '../src/payments/tokens';

const ORDER = 'ord_js2sr2uwkl5lpewa26aylmzw';

describe('shortOrderId', () => {
  it('keeps the start of an order id: enough to find it in the store, too little to read the order with', () => {
    expect(shortOrderId(ORDER)).toBe('ord_js2sr2…');
  });
});

describe('refundFailedAlert', () => {
  it('rings, names the order by the start of its id, says why and what to do', () => {
    const alert = refundFailedAlert(ORDER, 'insufficient_balance');
    expect(alert).toMatchObject({ title: 'Refund not paid', priority: 'high' });
    expect(alert.message).toContain('ord_js2sr2…');
    expect(alert.message).toContain('insufficient_balance');
    expect(alert.message).toContain('Load the refund wallet');
    expect(alert.message).toContain('refund:retry');
    expect(alert.message).not.toContain(ORDER);
  });

  it.each([
    ['refund-daily-cap', 'REFUND_DAILY_CAP_USD'],
    ['fee_too_high', 'gas'],
    ['refund-reverted', 'by hand'],
    ['refund-unconfirmed', 'hash'],
    ['refund-dead', 'refund:retry'],
    ['refund-unsigned', 'refund:retry'],
    ['something-new', 'refund:retry'],
  ])('says what to do for %s', (why, hint) => {
    expect(refundFailedAlert(ORDER, why).message).toContain(hint);
  });
});

describe('settledWithoutOrderAlert', () => {
  it('rings, with the token, the payer and the transaction, which are all on the chain already', () => {
    const txHash = `0x${'ab'.repeat(32)}`;
    const alert = settledWithoutOrderAlert({ asset: TOKENS.USDC.address, payer: '0xFE6cf39Fe8223E025696d6653C1D149D034E13Fb', nonce: `0x${'1'.repeat(64)}`, txHash });
    expect(alert).toMatchObject({ title: 'Payment with no order', priority: 'high' });
    expect(alert.message).toContain('USDC');
    expect(alert.message).toContain('0xFE6c…13Fb');
    expect(alert.message).toContain(txHash);
    expect(alert.message).toContain('by hand');
  });
});

describe('settleFailedAlert', () => {
  const PAYER = '0xFE6cf39Fe8223E025696d6653C1D149D034E13Fb';
  const failure = (refused: boolean, reason: string) => ({ asset: TOKENS.USDT.address, payer: PAYER, nonce: `0x${'1'.repeat(64)}`, refused, reason });

  it("shows, without ringing, a payment the facilitator refused, with its reason and the start of the order's id", () => {
    const alert = settleFailedAlert(ORDER, failure(true, 'insufficient_funds'));
    expect(alert).toMatchObject({ title: 'Settlement failed', priority: 'low' });
    expect(alert.message).toBe('ord_js2sr2…: the facilitator refused the payment (insufficient_funds), so nothing moved. Its page says it did not go through.');
  });

  it('says when it is not known whether the tokens moved, and what happens next', () => {
    expect(settleFailedAlert(ORDER, failure(false, 'Facilitator settle request timed out after 90000ms')).message).toBe(
      'ord_js2sr2…: the settlement ended in doubt (Facilitator settle request timed out after 90000ms), so the tokens may have moved. The reconciliation starts the order if they did, and gives it up as unpaid if not.',
    );
  });

  it("keeps only the reason's first line, and at most 200 characters of it: what follows can quote the call's arguments", () => {
    const quoted = settleFailedAlert(ORDER, failure(false, 'invalid_exact_evm_transaction_failed: The contract function reverted.\n\nContract Call:\n  args: (0xabc)'));
    expect(quoted.message).toContain('(invalid_exact_evm_transaction_failed: The contract function reverted.)');
    expect(quoted.message).not.toContain('args');
    const long = settleFailedAlert(ORDER, failure(false, 'x'.repeat(500)));
    expect(long.message).toContain(`(${'x'.repeat(200)}…)`);
    expect(long.message).not.toContain('x'.repeat(201));
  });

  it('names the token and the payer of a payment that has no order', () => {
    expect(settleFailedAlert(null, failure(true, 'insufficient_funds')).message).toBe(
      'A payment in USDT from 0xFE6c…13Fb, with no order: the facilitator refused the payment (insufficient_funds), so nothing moved.',
    );
    expect(settleFailedAlert(null, failure(false, 'fetch failed')).message).toBe(
      'A payment in USDT from 0xFE6c…13Fb, with no order: the settlement ended in doubt (fetch failed), so the tokens may have moved. Look it up on the chain: if it settled, pay it back by hand.',
    );
  });
});

describe('runLostAlert', () => {
  it('shows, without ringing, an order refunded because its run was lost, with what the runtime said of the run', () => {
    const alert = runLostAlert(ORDER, 'run-lost', 'failed');
    expect(alert).toMatchObject({ title: 'Run lost, refunded', priority: 'low' });
    expect(alert.message).toContain('ord_js2sr2…');
    expect(alert.message).toContain('failed');
    expect(alert.message).not.toContain(ORDER);
  });

  it('says when the run never started', () => {
    expect(runLostAlert(ORDER, 'run-not-started', 'missing').message).toContain('never started');
  });
});
