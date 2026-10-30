import { describe, expect, it } from 'vitest';
import { refundFailedAlert, runLostAlert, settledWithoutOrderAlert, shortOrderId } from '../src/maintenance/alerts';
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

describe('runLostAlert', () => {
  it('shows, without ringing, an order refunded because its run was lost, with what the runtime said of the run', () => {
    const alert = runLostAlert(ORDER, 'run-lost', 'failed');
    expect(alert).toMatchObject({ title: 'Run lost, refunded', priority: 'default' });
    expect(alert.message).toContain('ord_js2sr2…');
    expect(alert.message).toContain('failed');
    expect(alert.message).not.toContain(ORDER);
  });

  it('says when the run never started', () => {
    expect(runLostAlert(ORDER, 'run-not-started', 'missing').message).toContain('never started');
  });
});
