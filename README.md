# ad-video-agent

A service that turns a website into a short ad video. An agent (or any x402 client) pays on Celo, sends a URL, and receives signed links to the main 9:16 hook with music, a muted version, the list of claims with the quotes from the site that back each one, and the credits for the music. If an order cannot be delivered, it is refunded automatically.

## Status

Stage 2a: the x402 service and the whole chain end to end. Work in progress; nothing is deployed yet.

## Packages

| Package | What it holds |
| --- | --- |
| `packages/core` (`@app/core`) | Plain TypeScript shared by the others: the edit decision list (EDL) the video is built from, its timing and brand rules, claim validation, music analysis, quality checks and the protocol of the rented machine. |
| `packages/web` | The Next.js app on Vercel: x402 payments, order state, delivery, the API for the rented machine, and a durable workflow per order. |
| `packages/vm` | The worker that runs on the rented machine: site capture, key frames, render and mix. |

Only `packages/core` exists so far.

## Tests

Requires Node 24 and pnpm 12.14.0 (the `packageManager` field in `package.json` selects it).

```sh
pnpm install
pnpm typecheck
pnpm test                # unit tests of every package
pnpm test:integration    # workflow integration tests (none yet)
pnpm --filter @app/core test
pnpm --filter @app/vm test:browser   # opt-in: drives a real Chrome (downloaded on the first run) against a local site
```

Tests that spend money (paid VMs, models, music) are opt-in and never run in CI.

## License

All rights reserved. No license is granted.
