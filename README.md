# ad-video-agent

A service that turns a website into a short ad video. An agent (or any x402 client) pays on Celo, sends a URL, and receives signed links to the main 9:16 hook with music, a muted version, the list of claims with the quotes from the site that back each one, and the credits for the music. If an order cannot be delivered, it is refunded automatically.

## Status

Stage 2a: the x402 service and the whole chain end to end. Work in progress; nothing is deployed yet.

## Packages

| Package | What it holds |
| --- | --- |
| `packages/core` (`@app/core`) | Plain TypeScript shared by the others: the edit decision list (EDL) the video is built from, its timing and brand rules, claim validation, music analysis, quality checks and the protocol of the rented machine. |
| `packages/web` (`@app/web`) | The Next.js app on Vercel: the free quote and the x402 payment (`POST /v1/videos`), order status and delivery links, the API the rented machine takes its tasks from, a durable workflow per order (Vercel Workflow), and the crons that reconcile payments and refunds and expire old orders. |
| `packages/vm` (`@app/vm`) | The worker that runs on the rented machine: site capture, key frames, render and mix. |
| `packages/clock` (`@app/clock`) | A Cloudflare Worker that is the reconcile clock: its Cron Trigger calls the reconcile route every 10 minutes. |

## Tests

Requires Node 24 and pnpm 12.14.0 (the `packageManager` field in `package.json` selects it).

```sh
pnpm install
pnpm typecheck
pnpm test                # unit tests of every package
pnpm test:integration    # the order workflow on the Workflow runtime, and the payment route built and served by next start, with fake adapters
pnpm --filter @app/core test
pnpm --filter @app/vm test:browser   # opt-in: a real Chrome (downloaded on the first run) against a local site, and the real ffmpeg
```

Tests that spend money (paid VMs, models, music) are opt-in and never run in CI.

## Operations

- An order whose refund could not be paid stays `refund_failed`, and the reconciliation logs it as `[refund_failed]` every 10 minutes; once the cause is fixed, `pnpm --filter @app/web refund:retry <orderId>`, run with the production settings in the environment, moves it back to `refunding` and signs and sends its refund in one go (the reconciliation then confirms it).

### Reconcile clock

The Vercel project is on the Hobby plan, whose crons run once a day at most, so the reconciliation (`GET /api/cron/reconcile`) is called every 10 minutes by the Cloudflare Worker in `packages/clock` (its Cron Trigger, at minutes 3, 13, 23, 33, 43 and 53). Vercel's own cron still calls the same route once a day (`packages/web/vercel.ts`) as a backstop, should the Worker stop. Both send `Authorization: Bearer <CRON_SECRET>`, which is what the route checks.

To deploy the Worker, from the repository's root (wrangler is not a dependency; this is the version checked on 19/10/2026):

```sh
pnpm dlx wrangler@4.151.2 deploy --config packages/clock/wrangler.toml
pnpm dlx wrangler@4.151.2 secret put CRON_SECRET --config packages/clock/wrangler.toml   # the same value as Vercel's CRON_SECRET
```

`RECONCILE_URL` in `packages/clock/wrangler.toml` must match `PUBLIC_BASE_URL`. Each run's line in the Worker's logs (Workers Logs on the Cloudflare dashboard) says how many orders it started, gave up on, found `refund_failed` and refunded as lost (`started=1 unpaid=0 refundFailed=0 runLost=0`), never their ids: an order id lets whoever has it read the order's status and delivery links. A run that gets anything but a 2xx, or a body that is not that summary, shows as failed there. A green run does not mean a clean pass: what went wrong with one order is in Vercel's logs, as `[reconcile_error]`, `[order_stuck]` and `[refund_failed]`.

Two passes at once (an overlap with Vercel's daily run, or a slow pass running into the next tick) cannot pay an order twice: every status change is a conditional update that only one caller wins, an order keeps one refund whose signed bytes are the only ones ever sent, and a second run started for the same order ends as a duplicate before it spends anything. The run id a pass writes is kept only if the order has none, so a duplicate run's id never takes the place of the run that holds the order (which would have the reconciliation take that run for lost). They can repeat work: reads of the chain, a duplicate run, the same log lines. Several refunds of different orders at the same moment can pass the daily refund cap by one refund.

## License

All rights reserved. No license is granted.
