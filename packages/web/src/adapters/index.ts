// Which adapters the service runs on: the real ones, or the doubles when AD_AGENT_ADAPTERS is `fake` (tests only;
// env.ts refuses it in production). The routes and the flow ask here, and never build an adapter themselves.
import { GoogleGenAI } from '@google/genai';
import type { Hex } from 'viem';
import { openDb } from '../db/client';
import { env, type Env } from '../env';
import type { BlobPort, BuyPort, LlmPort, MusicPort, OrderStore, RefundPort } from '../ports';
import { FileBlob } from './fake/blob';
import { FakeBuy } from './fake/buy';
import { FakeLlm } from './fake/llm';
import { FakeMusic } from './fake/music';
import { FakeRefunds } from './fake/refunds';
import { FileStore } from './fake/store';
import { VercelBlob } from './real/blob';
import { CeloBuy } from './real/buy';
import { GatewayLlm } from './real/llm';
import { LyriaMusic } from './real/music';
import { CeloRefunds } from './real/refunds';
import { DrizzleStore } from './real/store';

export type Adapters = {
  store: OrderStore;
  blob: BlobPort;
  buy: BuyPort;
  llm: LlmPort;
  music: MusicPort;
  refunds: RefundPort;
};

/** The adapters for a set of settings. It is async because the database opens asynchronously. */
export async function createAdapters(settings: Env): Promise<Adapters> {
  if (settings.AD_AGENT_ADAPTERS === 'fake') {
    if (settings.FAKE_DIR === undefined) throw new Error('AD_AGENT_ADAPTERS=fake needs FAKE_DIR: the folder the fake adapters keep their files in.');
    return {
      store: new FileStore(settings.FAKE_DIR),
      blob: new FileBlob(settings.FAKE_DIR),
      buy: new FakeBuy(),
      llm: new FakeLlm(),
      music: new FakeMusic(),
      refunds: new FakeRefunds(),
    };
  }
  // env.ts has already required these when the adapters are the real ones.
  const { DATABASE_URL, BLOB_READ_WRITE_TOKEN, SPEND_WALLET_PRIVATE_KEY, REFUND_WALLET_PRIVATE_KEY, GEMINI_API_KEY, CELO_RPC_URL, ERC8021_CODE } = settings;
  if (
    DATABASE_URL === undefined ||
    BLOB_READ_WRITE_TOKEN === undefined ||
    SPEND_WALLET_PRIVATE_KEY === undefined ||
    REFUND_WALLET_PRIVATE_KEY === undefined ||
    GEMINI_API_KEY === undefined
  ) {
    throw new Error('The real adapters need DATABASE_URL, BLOB_READ_WRITE_TOKEN, SPEND_WALLET_PRIVATE_KEY, REFUND_WALLET_PRIVATE_KEY and GEMINI_API_KEY.');
  }
  return {
    store: new DrizzleStore(await openDb(DATABASE_URL)),
    blob: new VercelBlob(BLOB_READ_WRITE_TOKEN),
    // env.ts has checked the key is 0x and 64 hex characters.
    buy: new CeloBuy({ spendKey: SPEND_WALLET_PRIVATE_KEY as Hex, rpcUrl: CELO_RPC_URL }),
    // The AI Gateway signs in with the deployment's OIDC token: no setting.
    llm: new GatewayLlm(),
    // Lyria is reached with the Gemini API's key, which only this client holds.
    music: new LyriaMusic(new GoogleGenAI({ apiKey: GEMINI_API_KEY })),
    // The refunds' wallet, which pays gas in the refunded token; ERC8021_CODE tags every refund once it is set.
    refunds: new CeloRefunds({ refundKey: REFUND_WALLET_PRIVATE_KEY as Hex, rpcUrl: CELO_RPC_URL, erc8021Code: ERC8021_CODE }),
  };
}

// Kept on globalThis, not in this module: one process can hold two copies of it (the workflow's steps are bundled apart
// from the routes, and the workflow tests load that bundle next to their own modules), and all of them must hand out the
// same adapters, one database and one set of doubles.
const CACHE = Symbol.for('ad-agent.adapters');
type WithAdapters = { [CACHE]?: Promise<Adapters> };

/**
 * The service's adapters, built once per process. The same ones come back every time, so a double keeps what it
 * recorded (a test reads `lastPresignGet` from the blob that the route used, or tells the model double what to answer
 * before a workflow runs). It rejects when the settings are wrong.
 */
export async function getAdapters(): Promise<Adapters> {
  const shared = globalThis as WithAdapters;
  shared[CACHE] ??= createAdapters(env());
  return shared[CACHE];
}

/** Tests only: forgets the adapters, so the next getAdapters builds them again. */
export function resetAdaptersForTests(): void {
  delete (globalThis as WithAdapters)[CACHE];
}
