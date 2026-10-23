// Orders put straight into the fake store of a running app (its FAKE_DIR), each as the flow leaves an order in that
// state, so a page test can open it at once. A delivered order also gets its four files in the fake blob store. The
// store keeps one JSON file per order, written whole, so the app reads a seeded order as one of its own.
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { musicMarkdown, musicModelName, type ClaimItem } from '@app/core';
import { FileBlob } from '../../../src/adapters/fake/blob';
import { FileStore } from '../../../src/adapters/fake/store';
import { TOKENS } from '../../../src/payments/tokens';
import { STEP_NAMES, type Deliverable, type DeliverySummary, type Order, type OrderStatus, type Steps } from '../../../src/ports';
import { renderPaths } from '../../../src/vm/tasks';

export type SeedState = 'running' | 'delivered' | 'refunded' | 'unpaid' | 'expired';

/** Who paid the seeded orders: a made-up address, no wallet of anyone's. */
export const SEEDED_PAYER = '0x1234567890AbcdEF1234567890aBcdef12345678';
/** What a seeded order paid: 0.05 USDT, the price of the test app. */
const PRICE = 50_000n;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A 1.5 s clip at 270x480 (9:16), H.264, made with ffmpeg's test pattern: both videos of a seeded delivery. */
const VIDEO = new URL('../fixtures/video-9x16.mp4', import.meta.url);

const CLAIMS: ClaimItem[] = [
  { onScreen: 'Get paid on time', quote: 'Invoices that chase themselves, so you get paid on time.', url: 'https://cobrame.example/', section: 'Get paid' },
  { onScreen: 'Reminders on WhatsApp', quote: 'Friendly reminders go out on WhatsApp before each due date.', url: 'https://cobrame.example/', section: 'Reminders' },
];
/** What the status of a seeded delivery shows besides its files: two claims, and Lyria 3.5's track at 120 BPM. */
export const SEEDED_SUMMARY: DeliverySummary = { claims: CLAIMS, music: { model: musicModelName('lyria-3.5'), bpm: 120 } };

const claimsMarkdown = (): string =>
  [
    '# Claims',
    '',
    'Every claim the video makes about the product, as it reads on screen, with the words on the site it comes from.',
    '',
    ...CLAIMS.map(({ onScreen, quote, url, section }) => `- **${onScreen}**\n  Source: "${quote}" (${url}, section "${section}")`),
    '',
  ].join('\n');

/** Every step of the flow done, as a delivered order shows them. */
const allDone = (): Steps => Object.fromEntries(STEP_NAMES.filter((name) => name !== 'refund').map((name) => [name, 'done']));

/** Writes the four files of a delivery into the fake blob store, and says what the order lists of them. */
async function writeDelivery(blob: FileBlob, orderId: string): Promise<Deliverable[]> {
  const video = await readFile(VIDEO);
  const videos = renderPaths(orderId);
  const put = async (name: string, path: string, body: Uint8Array | string, type: string): Promise<Deliverable> => ({
    name,
    path,
    bytes: (await blob.put(path, body, type)).bytes,
  });
  return [
    await put('hook-a-9x16.mp4', videos.withMusic, video, 'video/mp4'),
    await put('hook-a-9x16-muted.mp4', videos.muted, video, 'video/mp4'),
    await put('claims.md', `orders/${orderId}/out/claims.md`, claimsMarkdown(), 'text/markdown; charset=utf-8'),
    await put(
      'music.md',
      `orders/${orderId}/out/music.md`,
      musicMarkdown({ measuredBpm: 120, musicPrompt: 'Warm, steady pop with a light beat.', model: 'lyria-3.5' }),
      'text/markdown; charset=utf-8',
    ),
  ];
}

/**
 * Writes an order of the site https://cobrame.example/ in `state` into the fake store under `fakeDir`, and gives its id:
 * - `running`: paid, its payment done and its capture running;
 * - `delivered`: every step done, its summary (SEEDED_SUMMARY), and its four files in the fake blob store;
 * - `refunded`: its capture failed, and its refund confirmed with a transaction hash;
 * - `unpaid`: its payment never settled;
 * - `expired`: delivered 31 days ago, its files deleted.
 * `patch` goes into the order last (its id and status excepted), over what the state put there.
 */
export async function seedOrder(fakeDir: string, state: SeedState, patch: Partial<Order> = {}): Promise<string> {
  const store = new FileStore(fakeDir);
  const now = Date.now();
  const { order } = await store.createOrder({
    request: { url: 'https://cobrame.example/', audio: 'music' },
    network: 'eip155:42220',
    asset: TOKENS.USDT.address,
    payer: SEEDED_PAYER,
    amount: PRICE,
    nonce: `0x${randomBytes(32).toString('hex')}`,
    validAfter: 0n,
    validBefore: BigInt(Math.floor(now / 1000) + 300),
  });
  const id = order.id;
  const move = async (to: OrderStatus, fields: Partial<Order> = {}): Promise<void> => {
    if (!(await store.transition(id, to, fields))) throw new Error(`The seeded order ${id} could not move to ${to}.`);
  };
  const paid = { settleTx: `0x${randomBytes(32).toString('hex')}`, steps: { payment: 'done' } satisfies Steps };

  switch (state) {
    case 'unpaid':
      await move('unpaid', patch);
      break;
    case 'running':
      await move('paid', paid);
      await move('running', { steps: { payment: 'done', capture: 'running' }, ...patch });
      break;
    case 'delivered': {
      const deliverables = await writeDelivery(new FileBlob(fakeDir), id);
      await move('paid', paid);
      await move('running');
      await move('delivered', { deliverables, summary: SEEDED_SUMMARY, steps: allDone(), ...patch });
      break;
    }
    case 'refunded': {
      await move('paid', paid);
      await move('running', { steps: { payment: 'done', vm: 'done', capture: 'running' } });
      await move('refunding', { failureReason: 'capture', steps: { payment: 'done', vm: 'done', capture: 'failed', refund: 'running' } });
      await store.insertRefund({
        orderId: id,
        to: SEEDED_PAYER,
        asset: TOKENS.USDT.address,
        amount: PRICE,
        status: 'confirmed',
        reason: 'capture',
        rawTx: null,
        txHash: `0x${randomBytes(32).toString('hex')}`,
        nonce: 0,
        signer: `0x${'e'.repeat(40)}`,
      });
      await move('refunded', { steps: { payment: 'done', vm: 'done', capture: 'failed', refund: 'done' }, ...patch });
      break;
    }
    case 'expired': {
      // As the cleanup leaves it: delivered 31 days ago, then its files deleted.
      const blob = new FileBlob(fakeDir);
      const deliverables = await writeDelivery(blob, id);
      const longAgo = new Date(now - 31 * DAY_MS);
      await move('paid', paid);
      await move('running');
      await move('delivered', { deliverables, summary: SEEDED_SUMMARY, steps: allDone(), createdAt: longAgo, paidAt: longAgo, deliveredAt: longAgo });
      await blob.deletePrefix(`orders/${id}/`);
      await move('expired', patch);
      break;
    }
  }
  return id;
}
