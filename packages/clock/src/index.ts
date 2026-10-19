/** The Worker's settings (see wrangler.toml). */
interface Env {
  RECONCILE_URL: string;
  CRON_SECRET?: string;
}

/** What we use of a Cron Trigger's event. */
interface ScheduledController {
  scheduledTime: number;
  cron: string;
}

/** Just above the reconcile route's limit (300 s): the route always answers first. */
const RECONCILE_TIMEOUT_MS = 310_000;

/**
 * One call to the reconcile route, and its answer: a JSON summary of the ids of the orders it started, gave up on, found
 * refund_failed and refunded as lost. No secret and no error text is in it, so it can go to the log (an order id lets
 * whoever has it read the order's status, so the log is as private as the Cloudflare account). Anything but a 2xx
 * throws, so the run shows as failed.
 */
async function reconcile(env: Env): Promise<string> {
  if (!env.CRON_SECRET) throw new Error("CRON_SECRET is not set"); // never send "Bearer undefined"
  const response = await fetch(env.RECONCILE_URL, {
    method: "GET",
    headers: { authorization: `Bearer ${env.CRON_SECRET}`, "user-agent": "ad-video-reconcile-clock" },
    signal: AbortSignal.timeout(RECONCILE_TIMEOUT_MS),
  });
  const answer = await response.text();
  if (!response.ok) throw new Error(`The reconcile answered ${response.status}: ${answer.slice(0, 200)}`);
  return answer;
}

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const answer = await reconcile(env);
    console.log(`reconcile for ${new Date(controller.scheduledTime).toISOString()} (${controller.cron}): ${answer}`);
  },
};
