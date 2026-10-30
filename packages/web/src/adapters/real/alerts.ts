// The alerts, as notifications on a phone through ntfy (https://ntfy.sh): a POST of the message to a topic, which the
// ntfy app is subscribed to. No account and no SDK: the topic's URL (ALERT_URL) is all it takes, and its name is the
// secret, since whoever has it reads the alerts. So it is never logged, and the alerts never hold a whole order id.
import type { Alert, AlertPort } from '../../ports';

/** How long an alert may take: nothing waits on it longer. */
const ALERT_TIMEOUT_MS = 5_000;

export type NtfyAlertsSettings = {
  /** ALERT_URL: the topic's URL, https://ntfy.sh/<topic>. */
  url: string;
  /** Tests hand it their own. */
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export class NtfyAlerts implements AlertPort {
  // Private (#) so that printing the adapter does not show the topic.
  readonly #url: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(settings: NtfyAlertsSettings) {
    this.#url = settings.url;
    this.#fetch = settings.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = settings.timeoutMs ?? ALERT_TIMEOUT_MS;
  }

  async send({ title, message, priority }: Alert): Promise<void> {
    try {
      const res = await this.#fetch(this.#url, {
        method: 'POST',
        // The titles are plain ASCII, as a header must be: the message, in the body, may be any text.
        headers: { title, priority },
        body: message,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!res.ok) console.error('[alert_failed]', title, res.status);
      // Its answer is not read: the connection is let go.
      await res.body?.cancel().catch(() => undefined);
    } catch (error) {
      // Only the kind of failure: a fetch error's message may hold the URL.
      console.error('[alert_failed]', title, error instanceof Error ? error.name : 'error');
    }
  }
}

/** The alerts of a service with no ALERT_URL (a preview, a local run): they are only logged. */
export class LogAlerts implements AlertPort {
  async send({ title, message }: Alert): Promise<void> {
    console.error('[alert]', title, message);
  }
}
