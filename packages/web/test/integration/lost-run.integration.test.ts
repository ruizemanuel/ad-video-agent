// A run the reconciliation takes for lost while it is in fact still alive: the reconciliation refunds the order, and the
// run, when it wakes and fails, refunds it with the refund that was kept. A file of its own, so the reconciliation sees
// no order but this one.
import { waitForHook } from '@workflow/vitest';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { start } from 'workflow/api';
import { reconcile } from '../../src/maintenance/reconcile';
import { orderWorkflow } from '../../src/workflows/order';
import { actAsVm, fakeService, paidOrder, PAYER, PRICE, removeFakeService, taskToken, USDT, type Fakes } from './support';

let fakes: Fakes;
let dir: string;

beforeAll(async () => {
  ({ fakes, dir } = await fakeService());
});

afterAll(async () => {
  await removeFakeService(dir);
});

it('pays the order back once: the run that wakes after the reconciliation refunded it sends the same refund', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const id = await paidOrder(fakes.store);
  const run = await start(orderWorkflow, [id]);
  await waitForHook(run, { token: taskToken(id, 'capture', 0) });

  // Two hours after the payment, the runtime says (wrongly) that the run failed: the reconciliation refunds the order.
  const twoHoursOn = new Date(Date.now() + 2 * 60 * 60_000 + 60_000);
  const deps = { store: fakes.store, buy: fakes.buy, refunds: fakes.refunds, payTo: `0x${'1'.repeat(40)}`, refundDailyCapUsd: 10 };
  const result = await reconcile({ ...deps, runStatus: async () => 'failed' }, twoHoursOn);
  expect(result.runLost).toEqual([id]);
  const kept = await fakes.store.getRefund(id);
  expect(kept).toMatchObject({ status: 'broadcast', to: PAYER, asset: USDT, amount: PRICE, reason: 'run-lost' });
  expect(fakes.refunds.prepareCalls).toBe(1);

  // The run was alive: the VM reports that the capture failed, and the run refunds the order.
  await actAsVm(run, id, 'capture', 0, null, { ok: false, code: 'unreachable', message: 'The site did not answer.' });
  expect(await run.returnValue).toEqual({ status: 'refunded', reason: 'capture' });

  // One refund signed, and only its bytes ever sent: one transfer.
  expect(fakes.refunds.prepareCalls).toBe(1);
  expect(new Set(fakes.refunds.broadcasts)).toEqual(new Set([kept?.rawTx]));
  expect(await fakes.refunds.nonceUsed(0)).toBe(true);
  expect(await fakes.refunds.nonceUsed(1)).toBe(false);
  expect(await fakes.store.getRefund(id)).toMatchObject({ status: 'confirmed', txHash: kept?.txHash });
  expect(await fakes.store.getOrder(id)).toMatchObject({ status: 'refunded', failureReason: 'run-lost', steps: { refund: 'done' } });
});
