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

## Tests

Requires Node 24 and pnpm 12.14.0 (the `packageManager` field in `package.json` selects it).

```sh
pnpm install
pnpm typecheck
pnpm test                # unit tests of every package
pnpm test:integration    # the order workflow on the Workflow runtime, with fake adapters
pnpm --filter @app/core test
pnpm --filter @app/vm test:browser   # opt-in: a real Chrome (downloaded on the first run) against a local site, and the real ffmpeg
```

Tests that spend money (paid VMs, models, music) are opt-in and never run in CI.

## Operations

- An order whose refund could not be paid stays `refund_failed`, and the reconciliation logs it as `[refund_failed]` every 10 minutes; once the cause is fixed, `pnpm --filter @app/web refund:retry <orderId>`, run with the production settings in the environment, moves it back to `refunding` and signs and sends its refund in one go (the reconciliation then confirms it).

## License

All rights reserved. No license is granted.
