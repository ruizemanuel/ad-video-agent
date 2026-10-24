import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileBlob } from '../src/adapters/fake/blob';
import { getAdapters } from '../src/adapters';
import { GET } from '../src/app/v1/files/[orderId]/[name]/route';
import { signFileLink } from '../src/links';
import type { Order } from '../src/ports';

const SECRET = 's'.repeat(40);
const BASE = 'https://ad-video-agent.example.com';
const NAME = 'hook-a-9x16.mp4';

// The route reads its settings and its adapters the way the service does: from the environment, once.
const dir = await mkdtemp(join(tmpdir(), 'files-route-'));
vi.stubEnv('AD_AGENT_ADAPTERS', 'fake');
vi.stubEnv('FAKE_DIR', dir);
vi.stubEnv('PAYTO_ADDRESS', `0x${'1'.repeat(40)}`);
vi.stubEnv('LINK_SIGNING_SECRET', SECRET);
vi.stubEnv('CRON_SECRET', 'c'.repeat(40));
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const { store, blob } = await getAdapters();
const fakeBlob = blob as FileBlob;

let counter = 0;
// An order that was delivered with one video and the claims, the way the flow leaves it.
async function deliveredOrder(): Promise<Order> {
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
  await store.transition(order.id, 'paid');
  await store.transition(order.id, 'running');
  await store.setDeliverables(order.id, [
    { name: NAME, path: `orders/${order.id}/out/${NAME}`, bytes: 3_780_000 },
    { name: 'claims.md', path: `orders/${order.id}/out/claims.md`, bytes: 900 },
  ]);
  await store.transition(order.id, 'delivered');
  return (await store.getOrder(order.id)) as Order;
}

const inDays = (days: number) => Math.floor(Date.now() / 1000) + days * 24 * 3600;
const ctxFor = (orderId: string, name: string) => ({ params: Promise.resolve({ orderId, name }) });
const request = (url: string) => new Request(url);
const body = async (res: Response) => (await res.json()) as { error: string };

beforeEach(() => {
  fakeBlob.lastPresignGet = undefined;
});

describe('GET /v1/files/<orderId>/<name>', () => {
  it('redirects a valid link to a 10-minute presigned GET of the file', async () => {
    const order = await deliveredOrder();
    const link = signFileLink({ orderId: order.id, name: NAME, exp: inDays(30) }, SECRET, BASE);
    const res = await GET(request(link), ctxFor(order.id, NAME));
    expect(res.status).toBe(302);
    expect(fakeBlob.lastPresignGet).toEqual({ path: `orders/${order.id}/out/${NAME}`, minutes: 10 });
    expect(res.headers.get('location')).toBe(await fakeBlob.presignGet(`orders/${order.id}/out/${NAME}`, 10));
  });

  it('redirects a link with download=1 to a presigned GET that saves the file instead of showing it', async () => {
    const order = await deliveredOrder();
    const link = `${signFileLink({ orderId: order.id, name: NAME, exp: inDays(30) }, SECRET, BASE)}&download=1`;
    const res = await GET(request(link), ctxFor(order.id, NAME));
    expect(res.status).toBe(302);
    expect(fakeBlob.lastPresignGet).toEqual({ path: `orders/${order.id}/out/${NAME}`, minutes: 10, attachment: true });
    expect(res.headers.get('location')).toBe(await fakeBlob.presignGet(`orders/${order.id}/out/${NAME}`, 10, { attachment: true }));
  });

  it('keeps the plain presigned GET for any other value of download', async () => {
    const order = await deliveredOrder();
    const link = `${signFileLink({ orderId: order.id, name: NAME, exp: inDays(30) }, SECRET, BASE)}&download=0`;
    expect((await GET(request(link), ctxFor(order.id, NAME))).status).toBe(302);
    expect(fakeBlob.lastPresignGet).toEqual({ path: `orders/${order.id}/out/${NAME}`, minutes: 10 });
  });

  it('serves each file of the order from its own path', async () => {
    const order = await deliveredOrder();
    const link = signFileLink({ orderId: order.id, name: 'claims.md', exp: inDays(30) }, SECRET, BASE);
    expect((await GET(request(link), ctxFor(order.id, 'claims.md'))).status).toBe(302);
    expect(fakeBlob.lastPresignGet).toEqual({ path: `orders/${order.id}/out/claims.md`, minutes: 10 });
  });

  it('keeps the redirect, which carries a signature, out of every cache', async () => {
    const order = await deliveredOrder();
    const res = await GET(request(signFileLink({ orderId: order.id, name: NAME, exp: inDays(30) }, SECRET, BASE)), ctxFor(order.id, NAME));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('answers 410 for an expired link, and presigns nothing', async () => {
    const order = await deliveredOrder();
    const link = signFileLink({ orderId: order.id, name: NAME, exp: Math.floor(Date.now() / 1000) - 1 }, SECRET, BASE);
    const res = await GET(request(link), ctxFor(order.id, NAME));
    expect(res.status).toBe(410);
    expect((await body(res)).error).toMatch(/expired/i);
    expect(fakeBlob.lastPresignGet).toBeUndefined();
  });

  it('answers 403 for a link signed with another secret, and presigns nothing', async () => {
    const order = await deliveredOrder();
    const link = signFileLink({ orderId: order.id, name: NAME, exp: inDays(30) }, 'x'.repeat(40), BASE);
    const res = await GET(request(link), ctxFor(order.id, NAME));
    expect(res.status).toBe(403);
    expect((await body(res)).error).toMatch(/not valid/i);
    expect(fakeBlob.lastPresignGet).toBeUndefined();
  });

  it('answers 403 for a link of one file used for another', async () => {
    const order = await deliveredOrder();
    const link = signFileLink({ orderId: order.id, name: NAME, exp: inDays(30) }, SECRET, BASE);
    expect((await GET(request(link), ctxFor(order.id, 'claims.md'))).status).toBe(403);
  });

  it('answers 403 for a link of one order used for another', async () => {
    const [a, b] = [await deliveredOrder(), await deliveredOrder()];
    const link = signFileLink({ orderId: a.id, name: NAME, exp: inDays(30) }, SECRET, BASE);
    expect((await GET(request(link), ctxFor(b.id, NAME))).status).toBe(403);
  });

  it('answers 403 for a link whose expiry was pushed back', async () => {
    const order = await deliveredOrder();
    const link = new URL(signFileLink({ orderId: order.id, name: NAME, exp: Math.floor(Date.now() / 1000) - 1 }, SECRET, BASE));
    link.searchParams.set('exp', String(inDays(365)));
    expect((await GET(request(link.toString()), ctxFor(order.id, NAME))).status).toBe(403);
  });

  // The expiry is 1.8e9 (January 2027), so every spelling below is the same number as the one that was signed.
  it.each([
    ['without the signature', (url: URL) => url.searchParams.delete('sig')],
    ['without the expiry', (url: URL) => url.searchParams.delete('exp')],
    ['with an empty signature', (url: URL) => url.searchParams.set('sig', '')],
    ['with an expiry that is not a number', (url: URL) => url.searchParams.set('exp', 'tomorrow')],
    ['with a fractional expiry', (url: URL) => url.searchParams.set('exp', '1800000000.0')],
    ['with an expiry in exponent form', (url: URL) => url.searchParams.set('exp', '1.8e9')],
    ['with an expiry that starts with zeros', (url: URL) => url.searchParams.set('exp', '01800000000')],
    ['with an expiry that starts with a plus', (url: URL) => url.searchParams.set('exp', '+1800000000')],
  ])('answers 403 for a link %s', async (_label, damage) => {
    const order = await deliveredOrder();
    const link = new URL(signFileLink({ orderId: order.id, name: NAME, exp: 1_800_000_000 }, SECRET, BASE));
    damage(link);
    const res = await GET(request(link.toString()), ctxFor(order.id, NAME));
    expect(res.status).toBe(403);
    expect(fakeBlob.lastPresignGet).toBeUndefined();
  });

  it('answers 404 for a name that is not a deliverable of the order, even with a good signature', async () => {
    const order = await deliveredOrder();
    const link = signFileLink({ orderId: order.id, name: 'secret.txt', exp: inDays(30) }, SECRET, BASE);
    const res = await GET(request(link), ctxFor(order.id, 'secret.txt'));
    expect(res.status).toBe(404);
    expect((await body(res)).error).toMatch(/no such file/i);
    expect(fakeBlob.lastPresignGet).toBeUndefined();
  });

  it('answers 404 for an order that does not exist, even with a good signature', async () => {
    const link = signFileLink({ orderId: 'ord_doesnotexistdoesnotex', name: NAME, exp: inDays(30) }, SECRET, BASE);
    expect((await GET(request(link), ctxFor('ord_doesnotexistdoesnotex', NAME))).status).toBe(404);
  });

  it('answers 404 for an order that has no deliverables', async () => {
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
    const link = signFileLink({ orderId: order.id, name: NAME, exp: inDays(30) }, SECRET, BASE);
    expect((await GET(request(link), ctxFor(order.id, NAME))).status).toBe(404);
  });

  it('answers 410 once the order has expired and its files are gone', async () => {
    const order = await deliveredOrder();
    await store.transition(order.id, 'expired');
    const link = signFileLink({ orderId: order.id, name: NAME, exp: inDays(30) }, SECRET, BASE);
    const res = await GET(request(link), ctxFor(order.id, NAME));
    expect(res.status).toBe(410);
    expect((await body(res)).error).toMatch(/no longer available/i);
    expect(fakeBlob.lastPresignGet).toBeUndefined();
  });

  it('says nothing about orders to a link that is not signed: a forged link and an unknown order look alike', async () => {
    const forged = await GET(request(`${BASE}/v1/files/ord_doesnotexistdoesnotex/${NAME}?exp=${inDays(30)}&sig=${'0'.repeat(64)}`), ctxFor('ord_doesnotexistdoesnotex', NAME));
    const order = await deliveredOrder();
    const real = await GET(request(`${BASE}/v1/files/${order.id}/${NAME}?exp=${inDays(30)}&sig=${'0'.repeat(64)}`), ctxFor(order.id, NAME));
    expect(forged.status).toBe(403);
    expect(real.status).toBe(403);
    expect(await body(forged)).toEqual(await body(real));
  });
});
