import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { getAdapters } from '../src/adapters';
import { POST } from '../src/app/v1/videos/[id]/feedback/route';
import type { Order, OrderStatus } from '../src/ports';

const BASE = 'https://ad-video-agent.example.com';
const POST_URL = 'https://x.com/someone/status/1';

// The route reads its store the way the service does: from the environment, once.
const dir = await mkdtemp(join(tmpdir(), 'feedback-route-'));
vi.stubEnv('AD_AGENT_ADAPTERS', 'fake');
vi.stubEnv('FAKE_DIR', dir);
vi.stubEnv('PAYTO_ADDRESS', `0x${'1'.repeat(40)}`);
vi.stubEnv('LINK_SIGNING_SECRET', 's'.repeat(40));
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

/** How an order gets to each status, by allowed transitions only. */
const ROUTE = {
  awaiting_settlement: [],
  running: ['paid', 'running'],
  refunding: ['paid', 'refunding'],
  refunded: ['paid', 'refunding', 'refunded'],
  unpaid: ['unpaid'],
  delivered: ['paid', 'running', 'delivered'],
  expired: ['paid', 'running', 'delivered', 'expired'],
} as const satisfies Record<string, readonly OrderStatus[]>;
async function orderIn(status: keyof typeof ROUTE): Promise<Order> {
  const order = await newOrder();
  for (const step of ROUTE[status]) expect(await store.transition(order.id, step)).toBe(true);
  return order;
}

const send = (id: string, raw: string) =>
  POST(new Request(`${BASE}/v1/videos/${id}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw }), {
    params: Promise.resolve({ id }),
  });
const post = (id: string, body: unknown) => send(id, JSON.stringify(body));
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe('POST /v1/videos/<id>/feedback', () => {
  it('stores and replaces the answer of a delivered order', async () => {
    const order = await orderIn('delivered');
    const res = await post(order.id, { answer: 'as_is', postUrl: POST_URL, mayShow: true });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true });
    expect(await store.getFeedback(order.id)).toEqual({ answer: 'as_is', postUrl: POST_URL, mayShow: true, updatedAt: expect.any(Date) });

    // Another answer replaces the first one, whole.
    const again = await post(order.id, { answer: 'with_changes' });
    expect(again.status).toBe(200);
    expect(await json(again)).toEqual({ ok: true });
    expect(await store.getFeedback(order.id)).toEqual({ answer: 'with_changes', postUrl: null, mayShow: false, updatedAt: expect.any(Date) });

    // The order itself is left as it was.
    expect((await store.getOrder(order.id))?.status).toBe('delivered');
  });

  it('takes each of the three answers, and a postUrl that is null or missing', async () => {
    for (const answer of ['as_is', 'with_changes', 'not_yet'] as const) {
      const order = await orderIn('delivered');
      expect((await post(order.id, { answer, postUrl: null })).status).toBe(200);
      expect(await store.getFeedback(order.id)).toMatchObject({ answer, postUrl: null, mayShow: false });
    }
  });

  it('keeps mayShow false when there is no postUrl, whatever the body says', async () => {
    const order = await orderIn('delivered');
    expect((await post(order.id, { answer: 'as_is', mayShow: true })).status).toBe(200);
    expect(await store.getFeedback(order.id)).toMatchObject({ postUrl: null, mayShow: false });
    expect((await post(order.id, { answer: 'as_is', postUrl: null, mayShow: true })).status).toBe(200);
    expect(await store.getFeedback(order.id)).toMatchObject({ postUrl: null, mayShow: false });
    // With a link it is stored as given, and false when the body does not say.
    expect((await post(order.id, { answer: 'as_is', postUrl: POST_URL, mayShow: true })).status).toBe(200);
    expect(await store.getFeedback(order.id)).toMatchObject({ postUrl: POST_URL, mayShow: true });
    expect((await post(order.id, { answer: 'as_is', postUrl: POST_URL })).status).toBe(200);
    expect(await store.getFeedback(order.id)).toMatchObject({ postUrl: POST_URL, mayShow: false });
  });

  it('refuses an order that is not delivered', async () => {
    for (const status of ['awaiting_settlement', 'running', 'refunding', 'refunded', 'unpaid', 'expired'] as const) {
      const order = await orderIn(status);
      const res = await post(order.id, { answer: 'as_is', postUrl: POST_URL, mayShow: true });
      expect(res.status, status).toBe(409);
      expect(await json(res), status).toMatchObject({ error: 'not_delivered' });
      expect(await store.getFeedback(order.id), status).toBeNull();
    }
  });

  it('refuses a postUrl that is not https', async () => {
    const order = await orderIn('delivered');
    const refused = [
      'http://x.com/someone/status/1',
      'javascript:alert(1)',
      'ftp://x.com/file',
      'data:text/html,hi',
      'x.com/someone/status/1',
      'not a url',
      'https://',
      '',
      ' ',
      ` ${POST_URL}`,
      `${POST_URL}\n`,
      `https://x.com/${'a'.repeat(2048 - 'https://x.com/'.length + 1)}`,
      42,
      false,
      ['https://x.com/a'],
    ];
    for (const postUrl of refused) {
      const res = await post(order.id, { answer: 'as_is', postUrl });
      expect(res.status, JSON.stringify(postUrl)).toBe(400);
      expect(await json(res), JSON.stringify(postUrl)).toMatchObject({ error: 'invalid_request', reason: expect.stringContaining('postUrl') });
    }
    expect(await store.getFeedback(order.id)).toBeNull();
  });

  it('takes a postUrl of up to 2048 characters', async () => {
    const order = await orderIn('delivered');
    const longest = `https://x.com/${'a'.repeat(2048 - 'https://x.com/'.length)}`;
    expect(longest).toHaveLength(2048);
    expect((await post(order.id, { answer: 'as_is', postUrl: longest })).status).toBe(200);
    expect((await store.getFeedback(order.id))?.postUrl).toBe(longest);
  });

  it('refuses an answer that is none of the three, a mayShow that is not a boolean, and a body that is not a JSON object', async () => {
    const order = await orderIn('delivered');
    const bodies: unknown[] = [
      {},
      { answer: 'AS_IS' },
      { answer: 'yes' },
      { answer: null },
      { answer: 1 },
      { postUrl: POST_URL },
      { answer: 'as_is', mayShow: 'true' },
      { answer: 'as_is', postUrl: POST_URL, mayShow: null },
      [],
      ['as_is'],
      null,
      'as_is',
      7,
    ];
    for (const body of bodies) {
      const res = await post(order.id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await json(res), JSON.stringify(body)).toMatchObject({ error: 'invalid_request', reason: expect.any(String) });
    }
    for (const raw of ['', '{', 'answer=as_is', 'undefined']) {
      const res = await send(order.id, raw);
      expect(res.status, raw).toBe(400);
      expect(await json(res), raw).toMatchObject({ error: 'invalid_request', reason: 'The body must be JSON.' });
    }
    expect(await store.getFeedback(order.id)).toBeNull();
  });

  it('answers 404 for an unknown order', async () => {
    const res = await post('ord_doesnotexistdoesnotex', { answer: 'as_is' });
    expect(res.status).toBe(404);
    expect(await json(res)).toMatchObject({ error: 'order_not_found' });
  });

  it('keeps every answer out of every cache', async () => {
    const order = await orderIn('delivered');
    const unpaid = await orderIn('running');
    const answers = [
      await post(order.id, { answer: 'as_is' }),
      await post(order.id, { answer: 'nope' }),
      await post(unpaid.id, { answer: 'as_is' }),
      await post('ord_doesnotexistdoesnotex', { answer: 'as_is' }),
    ];
    expect(answers.map((res) => res.status)).toEqual([200, 400, 409, 404]);
    for (const res of answers) expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
