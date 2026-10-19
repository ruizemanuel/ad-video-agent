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

/**
 * Vercel's default limit on this plan (the route sets no maxDuration) is 300 s; this waits a little longer, so the route
 * always answers first.
 */
const RECONCILE_TIMEOUT_MS = 310_000;

/** The lists the route answers with: the ids of the orders it started, gave up on, found refund_failed and refunded as lost (ReconcileResult in packages/web). */
const LISTS = ["started", "unpaid", "refundFailed", "runLost"] as const;

/**
 * How many orders each list holds, as one line of text. The route answers with the lists of order ids themselves, and an
 * order id lets whoever has it read the order's status and its delivery links, so only the counts may reach the log. An
 * answer that is not those four lists fails the run, and says nothing of what it held.
 */
function summarize(answer: string, status: number): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    parsed = null;
  }
  const result: Record<string, unknown> = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const counts: string[] = [];
  for (const name of LISTS) {
    const list = result[name];
    if (!Array.isArray(list)) throw new Error(`The reconcile answered ${status} with something other than its summary of four lists`);
    counts.push(`${name}=${list.length}`);
  }
  return counts.join(" ");
}

/**
 * One call to the reconcile route, and the counts of its answer. Anything but a 2xx throws, with the status and the start
 * of the body (an error's, which holds no order id), so the run shows as failed.
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
  return summarize(answer, response.status);
}

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const counts = await reconcile(env);
    console.log(`reconcile for ${new Date(controller.scheduledTime).toISOString()} (${controller.cron}): ${counts}`);
  },
};
