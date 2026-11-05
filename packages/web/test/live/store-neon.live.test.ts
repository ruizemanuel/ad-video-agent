// Opt-in (`pnpm --filter @app/web test:live`): the OrderStore contract on a real Neon branch, over HTTP, as production
// runs it. PGlite has one connection, so only here do concurrent claims of a promo slot race for real.
//
// It empties every table before each test, so it never runs without its own branch: a schema-only Neon branch whose
// URL is PROMO_TEST_DATABASE_URL, in the environment or in packages/web/.env.promo-test (git-ignored). It refuses a
// database that holds any order, as production does, and leaves the branch empty again for the next run. It costs
// nothing on the card.
import { existsSync } from 'node:fs';
import { count, sql } from 'drizzle-orm';
import { afterAll } from 'vitest';
import { DrizzleStore } from '../../src/adapters/real/store';
import { openDb } from '../../src/db/client';
import { orders } from '../../src/db/schema';
import { describeStoreContract } from '../store-contract';

if (!process.env.PROMO_TEST_DATABASE_URL && existsSync('.env.promo-test')) process.loadEnvFile('.env.promo-test');
const url = process.env.PROMO_TEST_DATABASE_URL;
if (!url) {
  throw new Error('The Neon store test needs a schema-only branch: PROMO_TEST_DATABASE_URL, or packages/web/.env.promo-test.');
}

const db = await openDb(url);
const [held] = await db.select({ orders: count() }).from(orders);
if ((held?.orders ?? 0) > 0) {
  throw new Error(`The database at PROMO_TEST_DATABASE_URL holds ${held?.orders} orders: this test empties its tables, so it runs only on a branch with none.`);
}

const empty = () => db.execute(sql`truncate table orders, vm_tasks, payments, costs, refunds, prechecks, feedback, review_notes restart identity cascade`);
afterAll(empty);

describeStoreContract('DrizzleStore on Neon', async () => {
  await empty();
  return new DrizzleStore(db);
});
