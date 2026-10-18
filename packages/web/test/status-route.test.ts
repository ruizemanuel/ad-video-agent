import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { getAdapters } from '../src/adapters';
import { GET } from '../src/app/v1/videos/[id]/route';
import { verifyFileLink } from '../src/links';
import type { Order } from '../src/ports';

const SECRET = 's'.repeat(40);
const BASE = 'https://ad-video-agent.example.com';
const DAY_S = 24 * 3600;

// The route reads its settings and its store the way the service does: from the environment, once.
const dir = await mkdtemp(join(tmpdir(), 'status-route-'));
vi.stubEnv('AD_AGENT_ADAPTERS', 'fake');
vi.stubEnv('FAKE_DIR', dir);
vi.stubEnv('PAYTO_ADDRESS', `0x${'1'.repeat(40)}`);
vi.stubEnv('LINK_SIGNING_SECRET', SECRET);
vi.stubEnv('CRON_SECRET', 'c'.repeat(40));
vi.stubEnv('PUBLIC_BASE_URL', BASE);
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const { store } = await getAdapters();

let counter = 0;
async function newOrder(): Promise<Order> {
  const { order } = await store.createOrder({
    request: { url: 'https://example.com', audio: 'music' },
    network: 'eip155:42220',
    asset: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e',
    payer: '0x1234567890AbcdEF1234567890aBcdef12345678',
    amount: 5_000_000n,
    nonce: `0x${(++counter).toString(16).padStart(64, '0')}`,
    validAfter: 0n,
    validBefore: 1_790_000_000n,
  });
  return order;
}

/** A paid order the flow has taken up to the capture. */
async function runningOrder(): Promise<Order> {
  const order = await newOrder();
  await store.transition(order.id, 'paid', { settleTx: `0x${'ab'.repeat(32)}` });
  await store.setStep(order.id, 'payment', 'done');
  await store.transition(order.id, 'running');
  await store.setStep(order.id, 'vm', 'done');
  await store.setStep(order.id, 'capture', 'running');
  return order;
}

const get = (id: string) => GET(new Request(`${BASE}/v1/videos/${id}`), { params: Promise.resolve({ id }) });
const body = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe('GET /v1/videos/<id>', () => {
  it('shows steps while running and signed links when delivered', async () => {
    const order = await runningOrder();
    const running = await body(await get(order.id));
    expect(running).toMatchObject({ id: order.id, status: 'running', warnings: [] });
    expect(running.steps).toEqual([
      { name: 'payment', state: 'done' },
      { name: 'vm', state: 'done' },
      { name: 'capture', state: 'running' },
      { name: 'script', state: 'pending' },
      { name: 'music', state: 'pending' },
      { name: 'preview', state: 'pending' },
      { name: 'review', state: 'pending' },
      { name: 'render', state: 'pending' },
      { name: 'delivery', state: 'pending' },
    ]);
    expect(running.files).toBeUndefined();

    await store.setDeliverables(order.id, [
      { name: 'hook-a-9x16.mp4', path: `orders/${order.id}/out/hook-a-9x16.mp4`, bytes: 3_780_000 },
      { name: 'claims.md', path: `orders/${order.id}/out/claims.md`, bytes: 900 },
    ]);
    await store.addWarning(order.id, 'The site shows little of the product.');
    await store.transition(order.id, 'delivered');
    const deliveredAt = (await store.getOrder(order.id))!.deliveredAt!;

    const delivered = await body(await get(order.id));
    expect(delivered).toMatchObject({ status: 'delivered', warnings: ['The site shows little of the product.'] });
    const files = delivered.files as { name: string; url: string; bytes: number }[];
    expect(files.map(({ name, bytes }) => [name, bytes])).toEqual([
      ['hook-a-9x16.mp4', 3_780_000],
      ['claims.md', 900],
    ]);
    for (const file of files) {
      const url = new URL(file.url);
      expect(url.origin + url.pathname).toBe(`${BASE}/v1/files/${order.id}/${file.name}`);
      const exp = Number(url.searchParams.get('exp'));
      // The links live 30 days from the delivery.
      expect(exp).toBe(Math.floor(deliveredAt.getTime() / 1000) + 30 * DAY_S);
      expect(verifyFileLink({ orderId: order.id, name: file.name, exp, sig: url.searchParams.get('sig')! }, SECRET, Date.now())).toBe('ok');
    }
  });

  it('says when the order and its files are deleted: 30 days after it was made', async () => {
    const order = await runningOrder();
    expect((await body(await get(order.id))).expiresAt).toBe(new Date(order.createdAt.getTime() + 30 * DAY_S * 1000).toISOString());
  });

  it('shows an order waiting for its settlement with nothing done yet', async () => {
    const order = await newOrder();
    const status = await body(await get(order.id));
    expect(status.status).toBe('awaiting_settlement');
    expect((status.steps as { state: string }[]).every((step) => step.state === 'pending')).toBe(true);
  });

  it('shows the refund, as a step and with its transaction', async () => {
    const order = await runningOrder();
    await store.setStep(order.id, 'capture', 'failed');
    await store.transition(order.id, 'refunding');
    await store.setStep(order.id, 'refund', 'running');
    await store.insertRefund({
      orderId: order.id,
      to: order.payer,
      asset: order.asset,
      amount: order.amount,
      status: 'broadcast',
      reason: 'site-blocked',
      rawTx: '0x02',
      txHash: `0x${'cd'.repeat(32)}`,
    });
    const status = await body(await get(order.id));
    expect(status).toMatchObject({ status: 'refunding', refund: { status: 'broadcast', txHash: `0x${'cd'.repeat(32)}` } });
    expect((status.steps as { name: string }[]).at(-1)).toEqual({ name: 'refund', state: 'running' });
    expect(status.files).toBeUndefined();
  });

  it('keeps the answer, which carries signed links, out of every cache', async () => {
    const order = await runningOrder();
    expect((await get(order.id)).headers.get('cache-control')).toBe('no-store');
  });

  it('answers 404 for an unknown id', async () => {
    const res = await get('ord_doesnotexistdoesnotex');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'order_not_found' });
  });
});
