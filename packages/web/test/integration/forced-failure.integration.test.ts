// The development run of the refund: with DEV_MODE=1 and FORCE_FAIL_AT=before-vm the order is refunded before any VM is
// rented. A file of its own, because the settings are read once per process.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { start } from 'workflow/api';
import { orderWorkflow } from '../../src/workflows/order';
import { fakeService, paidOrder, PAYER, PRICE, removeFakeService, tasks, USDT, type Fakes } from './support';

let fakes: Fakes;
let dir: string;

beforeAll(async () => {
  ({ fakes, dir } = await fakeService({ DEV_MODE: '1', FORCE_FAIL_AT: 'before-vm' }));
});

afterAll(async () => {
  await removeFakeService(dir);
});

it('refunds before renting a VM when FORCE_FAIL_AT=before-vm in dev mode', async () => {
  const id = await paidOrder(fakes.store);
  expect(await (await start(orderWorkflow, [id])).returnValue).toEqual({ status: 'refunded', reason: 'forced' });
  expect(fakes.buy.vmRentals).toEqual([]);
  expect(await tasks(fakes.store, id)).toEqual([]);
  expect(fakes.refunds.lastPrepare).toEqual({ to: PAYER, asset: USDT, amount: PRICE });
  expect(await fakes.store.getOrder(id)).toMatchObject({ status: 'refunded', failureReason: 'forced' });
});
