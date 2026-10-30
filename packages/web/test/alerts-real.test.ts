// The real AlertPort: a POST to an ntfy topic, which a phone subscribed to it shows as a notification. ntfy itself is
// never called in a test: the adapter is handed a fetch that keeps what it was asked.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogAlerts, NtfyAlerts } from '../src/adapters/real/alerts';
import type { Alert } from '../src/ports';

const TOPIC = 'https://ntfy.sh/ad-video-test-topic-k3j4h5g6f7d8s9a0';

type Asked = { url: string; init: RequestInit };

/** A fetch that keeps what it was asked and answers with `answer`. */
const recording = (answer: (init: RequestInit) => Promise<Response>) => {
  const asked: Asked[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(url), init: init ?? {} });
    return answer(init ?? {});
  }) as typeof globalThis.fetch;
  return { asked, fetch };
};

const ok = async () => new Response('{"id":"abc"}', { status: 200 });

const urgent: Alert = { title: 'Refund not paid', message: 'ord_js2sr2... is refund_failed (insufficient_balance).', priority: 'high' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('NtfyAlerts.send', () => {
  it('posts the message to the topic, with its title and its priority', async () => {
    const { asked, fetch } = recording(ok);
    await new NtfyAlerts({ url: TOPIC, fetch }).send(urgent);

    expect(asked).toHaveLength(1);
    expect(asked[0]!.url).toBe(TOPIC);
    expect(asked[0]!.init.method).toBe('POST');
    expect(asked[0]!.init.body).toBe(urgent.message);
    expect(new Headers(asked[0]!.init.headers).get('title')).toBe('Refund not paid');
    expect(new Headers(asked[0]!.init.headers).get('priority')).toBe('high');
  });

  it('sends an alert of low priority as one: ntfy shows it in the list, without a sound', async () => {
    const { asked, fetch } = recording(ok);
    await new NtfyAlerts({ url: TOPIC, fetch }).send({ ...urgent, priority: 'low' });
    expect(new Headers(asked[0]!.init.headers).get('priority')).toBe('low');
  });

  it('logs, and does not throw, when ntfy answers with an error', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { fetch } = recording(async () => new Response('slow down', { status: 429 }));
    await expect(new NtfyAlerts({ url: TOPIC, fetch }).send(urgent)).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledWith('[alert_failed]', 'Refund not paid', 429);
  });

  it('logs, and does not throw, when the request fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { fetch } = recording(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(new NtfyAlerts({ url: TOPIC, fetch }).send(urgent)).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledWith('[alert_failed]', 'Refund not paid', 'TypeError');
  });

  it('gives up on a request that does not answer in time: nothing waits on an alert', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Answers only when its request is cancelled, as a server that never replies.
    const { fetch } = recording(
      (init) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    await expect(new NtfyAlerts({ url: TOPIC, fetch, timeoutMs: 20 }).send(urgent)).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledWith('[alert_failed]', 'Refund not paid', 'TimeoutError');
  });

  it('never puts the topic in the log: whoever has its name reads the alerts', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { fetch } = recording(async () => {
      throw new TypeError(`fetch failed for ${TOPIC}`);
    });
    await new NtfyAlerts({ url: TOPIC, fetch }).send(urgent);
    expect(JSON.stringify(logged.mock.calls)).not.toContain('ad-video-test-topic');
  });

  it('does not show the topic when printed', () => {
    expect(JSON.stringify(new NtfyAlerts({ url: TOPIC }))).not.toContain('ad-video-test-topic');
  });
});

describe('LogAlerts.send', () => {
  it('logs the alert, for a service with no topic set', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await new LogAlerts().send(urgent);
    expect(logged).toHaveBeenCalledWith('[alert]', 'Refund not paid', urgent.message);
  });
});
