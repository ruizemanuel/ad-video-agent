// Which adapters the service runs on: the real ones, or the doubles when AD_AGENT_ADAPTERS is `fake` (tests only;
// env.ts refuses it in production). The routes and the flow ask here, and never build an adapter themselves.
import { openDb } from '../db/client';
import { env, type Env } from '../env';
import type { BlobPort, OrderStore } from '../ports';
import { FileBlob } from './fake/blob';
import { FileStore } from './fake/store';
import { VercelBlob } from './real/blob';
import { DrizzleStore } from './real/store';

export type Adapters = {
  store: OrderStore;
  blob: BlobPort;
};

/** The adapters for a set of settings. It is async because the database opens asynchronously. */
export async function createAdapters(settings: Env): Promise<Adapters> {
  if (settings.AD_AGENT_ADAPTERS === 'fake') {
    if (settings.FAKE_DIR === undefined) throw new Error('AD_AGENT_ADAPTERS=fake needs FAKE_DIR: the folder the fake adapters keep their files in.');
    return { store: new FileStore(settings.FAKE_DIR), blob: new FileBlob(settings.FAKE_DIR) };
  }
  // env.ts has already required these when the adapters are the real ones.
  const { DATABASE_URL, BLOB_READ_WRITE_TOKEN } = settings;
  if (DATABASE_URL === undefined || BLOB_READ_WRITE_TOKEN === undefined) throw new Error('The real adapters need DATABASE_URL and BLOB_READ_WRITE_TOKEN.');
  return { store: new DrizzleStore(await openDb(DATABASE_URL)), blob: new VercelBlob(BLOB_READ_WRITE_TOKEN) };
}

let cached: Promise<Adapters> | undefined;

/**
 * The service's adapters, built once. The same ones come back every time, so a double keeps what it recorded
 * (a test reads `lastPresignGet` from the blob that the route used). It rejects when the settings are wrong.
 */
export async function getAdapters(): Promise<Adapters> {
  cached ??= createAdapters(env());
  return cached;
}
