import path from 'node:path';
import { neon } from '@neondatabase/serverless';
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-http';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * "memory": an in-memory Postgres (PGlite) with every migration applied, for tests.
 * "pglite:<folder>": the same, kept on disk, for local development. Anything else: Neon, over HTTP.
 * Migrations come from packages/web/drizzle, so the process must run from packages/web.
 *
 * PGlite is loaded only on its own branch, by dynamic import: production on Neon never loads it.
 */
export async function openDb(url: string): Promise<Db> {
  if (url === 'memory' || url.startsWith('pglite:')) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    const client = new PGlite(url === 'memory' ? undefined : url.slice('pglite:'.length));
    const db = drizzle({ client, schema });
    await migrate(db, { migrationsFolder: path.join(process.cwd(), 'drizzle') });
    return db as unknown as Db;
  }
  return drizzleNeon({ client: neon(url), schema }) as unknown as Db;
}
