import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import clock from "../src/index";

const URL_OF_ROUTE = "https://service.example/api/cron/reconcile";
const SECRET = "s3cret-value-of-the-cron";
const SCHEDULED_AT = Date.UTC(2026, 9, 19, 12, 13, 0);
const CRON = "3,13,23,33,43,53 * * * *";
const controller = { scheduledTime: SCHEDULED_AT, cron: CRON };
const env = { RECONCILE_URL: URL_OF_ROUTE, CRON_SECRET: SECRET };
// What the route answers (ReconcileResult in packages/web): the ids of the orders it dealt with. An order id is enough to
// read the order's status and its delivery links, so no id may reach the log.
const IDS = ["ord_2n7q1ghtv5k3m8aacdkx9p4w", "ord_7c0e8r2u4b6y1d5j3f9s8g2h", "ord_5w9t3k1m7p2x6z4v8n0q5r3e"];
const SUMMARY = JSON.stringify({ started: [IDS[0]], unpaid: [], refundFailed: [IDS[1], IDS[2]], runLost: [] });

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(SUMMARY, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the reconcile clock", () => {
  it("calls the reconcile route with GET and the cron secret as a bearer token", async () => {
    await clock.scheduled(controller, env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(URL_OF_ROUTE);
    expect(init?.method).toBe("GET");
    // Exactly what the route compares (packages/web/src/app/api/cron/auth.ts): `Bearer <CRON_SECRET>`.
    expect(init?.headers).toEqual({ authorization: `Bearer ${SECRET}`, "user-agent": "ad-video-reconcile-clock" });
  });

  it("gives the call a time limit just above Vercel's default 300 s on this plan (the route sets no maxDuration)", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");

    await clock.scheduled(controller, env);

    expect(timeout).toHaveBeenCalledExactlyOnceWith(310_000);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([undefined, ""])("refuses to run without the secret (%j) and sends nothing", async (secret) => {
    await expect(clock.scheduled(controller, { RECONCILE_URL: URL_OF_ROUTE, CRON_SECRET: secret })).rejects.toThrow("CRON_SECRET is not set");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
  });

  it("throws when the route does not answer 2xx, with the status and the start of the body", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));

    await expect(clock.scheduled(controller, env)).rejects.toThrow('The reconcile answered 401: {"error":"unauthorized"}');
    expect(console.log).not.toHaveBeenCalled();
  });

  it("keeps at most 200 characters of an error body", async () => {
    fetchMock.mockResolvedValue(new Response("x".repeat(500), { status: 500 }));

    const error = await clock.scheduled(controller, env).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(`The reconcile answered 500: ${"x".repeat(200)}`);
  });

  it("lets a failed call (no answer, or the time limit) fail the run", async () => {
    fetchMock.mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));

    await expect(clock.scheduled(controller, env)).rejects.toThrow("timeout");
    expect(console.log).not.toHaveBeenCalled();
  });

  it("logs one line with the scheduled time, the cron and how many orders each list holds", async () => {
    await expect(clock.scheduled(controller, env)).resolves.toBeUndefined();

    expect(console.log).toHaveBeenCalledExactlyOnceWith(`reconcile for 2026-10-19T12:13:00.000Z (${CRON}): started=1 unpaid=0 refundFailed=2 runLost=0`);
  });

  it("never logs an order id or the secret", async () => {
    await clock.scheduled(controller, env);

    const line = String(vi.mocked(console.log).mock.calls[0]?.[0]);
    for (const id of IDS) expect(line).not.toContain(id);
    expect(line).not.toContain("ord_");
    expect(line).not.toContain(SECRET);
  });

  it.each([
    ["not JSON", "<html>Bad gateway from somewhere</html>"],
    ["an empty body", ""],
    ["JSON that is not an object", '"started"'],
    ["null", "null"],
    ["a list missing", JSON.stringify({ started: [], unpaid: [], refundFailed: [] })],
    ["a list that is not a list", JSON.stringify({ started: 3, unpaid: [], refundFailed: [], runLost: [] })],
    ["a list that is an object", JSON.stringify({ started: {}, unpaid: [], refundFailed: [], runLost: [] })],
  ])("fails the run when a 2xx answer is %s, without quoting the body", async (_name, body) => {
    fetchMock.mockResolvedValue(new Response(body, { status: 200 }));

    const error = await clock.scheduled(controller, env).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("The reconcile answered 200 with something other than its summary of four lists");
    expect(console.log).not.toHaveBeenCalled();
  });
});
