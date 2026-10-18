import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { FileStore } from '../src/adapters/fake/store';
import { DrizzleStore } from '../src/adapters/real/store';
import { openDb } from '../src/db/client';
import { describeStoreContract } from './store-contract';

const dirs: string[] = [];
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'order-store-'));
  dirs.push(dir);
  return dir;
};
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

// One in-memory Postgres for the whole suite, emptied before each test: starting PGlite for every test would take minutes.
const db = await openDb('memory');
describeStoreContract('DrizzleStore', async () => {
  await db.execute(sql`truncate table orders, vm_tasks, payments, costs, refunds, prechecks restart identity cascade`);
  return new DrizzleStore(db);
});

describeStoreContract('FileStore', async () => new FileStore(await tempDir()));

describe('openDb', () => {
  it('gives every call to "memory" a database of its own, with the migrations applied', async () => {
    const payment = {
      request: { url: 'https://example.com', audio: 'music' as const },
      network: 'eip155:42220',
      asset: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e',
      payer: '0x1234567890AbcdEF1234567890aBcdef12345678',
      amount: 1n,
      nonce: `0x${'1'.repeat(64)}`,
      validAfter: 0n,
      validBefore: 1n,
    };
    const first = new DrizzleStore(await openDb('memory'));
    const second = new DrizzleStore(await openDb('memory'));
    await first.createOrder(payment);
    expect(await first.findOrderByPayment(payment.asset, payment.payer, payment.nonce)).not.toBeNull();
    expect(await second.findOrderByPayment(payment.asset, payment.payer, payment.nonce)).toBeNull();
  });
});

describe('FileStore', () => {
  const order = {
    request: { url: 'https://example.com', audio: 'music' as const },
    network: 'eip155:42220',
    asset: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e',
    payer: '0x1234567890AbcdEF1234567890aBcdef12345678',
    amount: 5_000_000n,
    nonce: `0x${'1'.repeat(64)}`,
    validAfter: 0n,
    validBefore: 1_790_000_000n,
  };

  it('shares its records between instances over one directory, as a test that seeds an order and a workflow that reads it do', async () => {
    const dir = await tempDir();
    const seeding = new FileStore(dir);
    const reading = new FileStore(dir);
    const { order: created } = await seeding.createOrder(order);
    await seeding.transition(created.id, 'paid');
    expect(await reading.getOrder(created.id)).toEqual({ ...created, status: 'paid', paidAt: expect.any(Date) });
    expect((await reading.createOrder(order)).created).toBe(false);
  });

  it('hands a task to one of two instances that claim it together', async () => {
    const dir = await tempDir();
    const a = new FileStore(dir);
    const b = new FileStore(dir);
    const { order: created } = await a.createOrder(order);
    await a.enqueueTask({ orderId: created.id, kind: 'capture', round: 0, input: {}, hookToken: `vmtask:${created.id}:capture:0` });
    const claims = await Promise.all([a.claimNextTask(created.id), b.claimNextTask(created.id), a.claimNextTask(created.id), b.claimNextTask(created.id)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('keeps its records after the instance is gone, and leaves no temporary file behind', async () => {
    const dir = await tempDir();
    const { order: created } = await new FileStore(dir).createOrder(order);
    await new FileStore(dir).setStep(created.id, 'vm', 'done');
    expect((await new FileStore(dir).getOrder(created.id))?.steps).toEqual({ vm: 'done' });
    const files = (await readdir(dir, { recursive: true })).map(String);
    expect(files.filter((file) => file.endsWith('.json')).length).toBeGreaterThan(0);
    expect(files.filter((file) => file.endsWith('.tmp'))).toEqual([]);
  });

  it('works on a directory that does not exist yet', async () => {
    const dir = join(await tempDir(), 'nested', 'fake');
    const store = new FileStore(dir);
    expect(await store.getOrder('ord_doesnotexist')).toBeNull();
    expect((await store.createOrder(order)).created).toBe(true);
  });

  it('writes keys that hold a colon as file names Windows accepts', async () => {
    const dir = await tempDir();
    const store = new FileStore(dir);
    const { order: created } = await store.createOrder(order);
    await store.insertPaymentIntent({ key: `${created.id}:vm`, orderId: created.id, kind: 'vm', maxAtomic: 70_000n });
    const files = (await readdir(dir, { recursive: true })).map(String);
    expect(files.filter((file) => file.includes(':'))).toEqual([]);
    expect(await store.getPayment(`${created.id}:vm`)).not.toBeNull();
  });
});
