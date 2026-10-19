import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// Vercel's own reconcile cron is the backstop for this Worker (packages/web/vercel.ts). The Worker fires every 10 minutes;
// the backstop fires once a day, and is kept off the Worker's minutes so that, when it can, it does not run at the same
// moment as one of the Worker's calls. Best effort only: on the Hobby plan Vercel runs a cron anywhere inside its hour.
const worker = readFileSync(fileURLToPath(new URL("../wrangler.toml", import.meta.url)), "utf8");
const workerSchedule = /^crons\s*=\s*\["([^"]+)"\]/m.exec(worker)?.[1] ?? "";
const workerMinutes = (workerSchedule.split(" ")[0] ?? "").split(",");

// The config object itself, not its text. A variable path keeps the type checker from following it into packages/web,
// whose dependencies this package does not have.
const vercelConfig = pathToFileURL(fileURLToPath(new URL("../../web/vercel.ts", import.meta.url))).href;
const { config } = (await import(/* @vite-ignore */ vercelConfig)) as { config: { crons?: { path: string; schedule: string }[] } };
const backstop = config.crons?.find((cron) => cron.path === "/api/cron/reconcile");

describe("Vercel's daily backstop for the Worker", () => {
  it("is a cron that calls the reconcile route once a day", () => {
    expect(backstop, "a reconcile cron in packages/web/vercel.ts").toBeDefined();
    expect(backstop?.schedule).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);
  });

  it("does not fire on one of the Worker's minutes", () => {
    expect(workerMinutes).toHaveLength(6);
    expect(workerMinutes).not.toContain(backstop?.schedule.split(" ")[0]);
  });
});
