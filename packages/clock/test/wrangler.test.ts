import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// wrangler.toml is read as text: there is no TOML parser here, and these few lines are all that is pinned.
const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const wrangler = read("../wrangler.toml");
const setting = (name: string): string | undefined => new RegExp(String.raw`^${name}\s*=\s*(.+?)\s*$`, "m").exec(wrangler)?.[1];

describe("wrangler.toml", () => {
  it("runs on a schedule only: no public URL, no preview URLs", () => {
    expect(setting("workers_dev")).toBe("false");
    expect(setting("preview_urls")).toBe("false");
    expect(wrangler).toMatch(/^\[observability\]\s*\nenabled = true$/m);
  });

  it("fires every 10 minutes, off the top of the hour", () => {
    expect(setting("crons")).toBe('["3,13,23,33,43,53 * * * *"]');
  });

  it("calls a reconcile route that exists", () => {
    const url = new URL(setting("RECONCILE_URL")?.replaceAll('"', "") ?? "");
    expect(url.protocol).toBe("https:");
    expect(url.pathname).toBe("/api/cron/reconcile");
    expect(existsSync(fileURLToPath(new URL(`../../web/src/app${url.pathname}/route.ts`, import.meta.url)))).toBe(true);
  });

  it("never holds the secret", () => {
    expect(wrangler).not.toMatch(/^CRON_SECRET\s*=/m);
  });
});
