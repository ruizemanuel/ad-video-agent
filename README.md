# ad-video-agent

A service that turns a website into a short ad video. An agent (or any x402 client) pays on Celo, sends a URL, and receives signed links to the main 9:16 hook with music, a muted version, the list of claims with the quotes from the site that back each one, and the credits for the music. If an order cannot be delivered, it is refunded automatically.

## Status

Stage 2b: the x402 service and the whole chain run end to end (stage 2a), and people order from a page with a browser wallet (stage 2b). An order is paid in USDT or USDC on Celo (x402), by an agent or by a person from the page. The service then rents a machine through buy to capture the site and render the video, a director model writes the script, a review model checks the key frames, Lyria makes the music, and the result is delivered as signed links. If any step fails, the order is refunded automatically, in the token it was paid in.

[The service](#the-service) describes the page and the API, and [Deployment](#deployment) and [Environment variables](#environment-variables) how the service is deployed and configured.

## The service

The page and the API are one deployment, and the page is a client of the API like any other.

- **The page, `/`:** a person pastes their site's address, connects a browser wallet and pays with one signature, in USDT or USDC on Celo, with no gas and no account. They land on `/o/<id>`, the order's page, which follows the order to its end and then shows the video, where each of its lines comes from, and the question "Did you post it?". That address is the order's link: whoever has it can open the order.
- **`POST /v1/videos`:** without a payment, the free quote. The body (`url`, and optionally a `brief`, up to 3 `extraUrls` and `audio`) is checked, the site and its extra pages go through a free check, and the answer is a `402` with the price in its `PAYMENT-REQUIRED` header and in the body, or a `400` or `422` that says why the order is refused. The same request with an x402 payment in `PAYMENT-SIGNATURE` places the order: a `202` with its `orderId` and `statusUrl`, which `Content-Location` names too.
- **`GET /v1/videos/<id>`:** the order's status, free: its steps and, once it is delivered, signed links to its files for 30 days.
- **`POST /v1/videos/<id>/feedback`:** the answer to "Did you post it?" for a delivered order, free: `answer` (`as_is`, `with_changes` or `not_yet`) and, optionally, `postUrl` (an `https` link to the post, with no user name or password in it) and `mayShow` (whether the post may be shown as an example). A new answer replaces the one before; the status shows it.
- **`GET /v1/offer`:** what an order costs now, free: `price` and `assets`, and `promo` (its `price` and how many slots are `left`) while the first-video promo is on, or `null`.
- **The `x-payer` header:** a quote that names the paying wallet in it is offered that wallet's own price: the first-video price, while the promo has a slot for it. The paying request must carry the same header, and its payment must be signed by that wallet. A client that sends no `x-payer` gets the full price, as always.
- **`503`:** it comes in two kinds, and says when to try again in `Retry-After`. `precheck_unavailable`: the free check cannot be made now (its model did not answer, or `PRECHECK_DAILY_CAP_USD` was reached for the day). `at_capacity`: the service has made all the videos it can today. What buy was paid since the UTC day began, plus 0.07 USDT (the most a machine is paid) for each order paid today whose machine is not paid yet and for one more order, would pass `BUY_DAILY_CAP_USD`. It comes before the free check and before any payment is looked at, for a quote and a paying request alike, so nothing is charged; its `Retry-After` is the seconds until the next UTC day.

## Packages

| Package | What it holds |
| --- | --- |
| `packages/core` (`@app/core`) | Plain TypeScript shared by the others: the edit decision list (EDL) the video is built from, its timing and brand rules, claim validation, music analysis, quality checks and the protocol of the rented machine. |
| `packages/web` (`@app/web`) | The Next.js app on Vercel: the page where people order and pay from a browser wallet (`/`) and follow their order (`/o/<id>`), the free quote and the x402 payment (`POST /v1/videos`), what an order costs now (`GET /v1/offer`), order status and delivery links, the free answer to "did you post it?" for a delivered order (`POST /v1/videos/<id>/feedback`), the API the rented machine takes its tasks from, a durable workflow per order (Vercel Workflow), and the crons that reconcile payments and refunds and expire old orders. |
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
pnpm --filter @app/web test:browser  # opt-in, on its own: the page in Chrome with a stub wallet, against next dev on fake adapters; nothing leaves the machine
```

Tests that spend money (paid VMs, models, music) are opt-in and never run in CI.

## Deployment

The service runs on Vercel. This is what it depends on.

### The Vercel project

- **Root directory:** `packages/web`.
- **System environment variables:** turn on "Enable access to System Environment Variables" in the project's settings. Workflow reads variables that Vercel sets (`VERCEL_DEPLOYMENT_ID`, `VERCEL_PROJECT_ID`, `VERCEL_ENV`) and fails without them, and the service itself needs `VERCEL_ENV` and `VERCEL_GIT_COMMIT_SHA`.
- **Git connection:** connect the GitHub repository. Each push to `main` deploys Production, and the crons in `packages/web/vercel.ts` (the reconciliation and the clean-up, once a day each) come with it.
- **The code the rented machine runs:** the machine has no copy of the repository. Its start-up script downloads it from `codeload.github.com` at the commit of the deployment (`VERCEL_GIT_COMMIT_SHA`), or at `VM_CODE_REF` when the deployment has none. The download sends no credentials, so `GITHUB_REPO` (`owner/name`) must be a public repository that has that commit. In production the service refuses to run with neither a commit nor `VM_CODE_REF`.
- **No Deployment Protection on Production.** The rented machine calls the service's task API (`/api/vm/tasks/...`) with only its order's permit, which lasts 75 minutes, and paying clients and their delivery links work without a Vercel login. A protection page in front of the service would stop all of them. The routes guard themselves: with the payment, the order's permit, a signed link, the cron secret or the order's id.
- **The agent's registration file:** the service serves its ERC-8004 registration file at `/.well-known/agent-registration.json`, the `agentURI` to register on the Identity Registry; once it is mined, set `AGENT_ID` and redeploy, and the same URL lists the id.
- **The models need no key.** The calls to Claude go through the Vercel AI Gateway, which signs in with the deployment's own token and bills your Vercel account. Only the music (Lyria, through the Gemini API) has a key: `GEMINI_API_KEY`.

### Database

Neon Postgres, added from the Vercel Marketplace (`vercel integration add neon`), which sets `DATABASE_URL`. It has to be Neon: the service talks to it over HTTP. Create the tables from the repository's root, with the database's URL in the environment (`DATABASE_URL_UNPOOLED` is used first when it is set):

```sh
pnpm install
pnpm --filter @app/web db:migrate
```

Run it again whenever a change adds a file to `packages/web/drizzle`.

### Storage

A private Vercel Blob store, connected to the project (it sets `BLOB_READ_WRITE_TOKEN`). Every file is written private and read through short-lived signed links. The rented machine uploads through signed links that each write one path once, so it never holds the store's token.

### Wallets

Three addresses on Celo, each with one job:

| Setting | What it does | What it needs to hold |
| --- | --- | --- |
| `PAYTO_ADDRESS` | Receives the payments. The tokens go from the client straight to it. Only the address is configured: keep it cold, the service never has its key. | Nothing. |
| `SPEND_WALLET_PRIVATE_KEY` | The spend wallet. It pays buy for each order's rented machine, in USDT. | USDT. A machine is paid at most 0.07 USDT (a limit in the code), and `BUY_DAILY_CAP_USD` limits what it spends in a UTC day. |
| `REFUND_WALLET_PRIVATE_KEY` | The refund wallet. It sends each refund back to the payer in the token that was paid. | USDT and USDC, as much as a day's refunds may need (`REFUND_DAILY_CAP_USD`). It pays its gas in that same token, up to 0.05 per refund, so it needs no CELO. |

The two keys are Sensitive environment variables in Vercel and live nowhere else in the project. Keep both wallets small: they are working balances. A refund the wallet cannot pay (no balance, gas too high or the daily cap) leaves the order `refund_failed`; see Operations.

### Firewall

Add a rate-limit rule to the project's Firewall in the Vercel dashboard: `POST /v1/videos`, 30 requests per minute per IP, fixed window, answering 429. The route runs a free site check with a model before any payment, so anyone can cause that cost (`PRECHECK_DAILY_CAP_USD` stops it for the day). The rule is set by hand because Vercel's API cannot create a project's first firewall configuration.

### The clock

The 10-minute reconciliation runs on a Cloudflare Worker, deployed apart from Vercel: see [Reconcile clock](#reconcile-clock).

## Environment variables

Set them in the Vercel project, for Production. `packages/web/src/env.ts` checks them the first time the service needs them and refuses to run on a missing or malformed one; the error names the variable, never its value. A secret is a value that must never be committed or printed: set it as a Sensitive variable where Vercel lets you.

| Name | Needed | Secret | What it is for |
| --- | --- | --- | --- |
| `PAYTO_ADDRESS` | Yes | No | The address that receives the payments. |
| `PRICE_ATOMIC` | No, default `5000000` | No | The price of an order in the smallest unit of USDT and USDC, which have 6 decimals: `5000000` is 5. |
| `PROMO_SLOTS` | No, default `0` | No | How many wallets get their first video at 0.01 USDT or USDC; `0` turns the promo off. A wallet is offered that price when the quote names it in the `x-payer` header and it has no video yet; the paying request must carry the same header, and the payment must come from that wallet. Its order holds a slot while its video is on the way or delivered, and gives it back if the order ends unpaid or refunded. `GET /v1/offer` says how many are left. |
| `TEAM_WALLETS` | No | No | The team's wallets, separated by commas (`0x` and 40 hex characters each): they are never offered the first-video price. |
| `X402_API_KEY` | Yes | Yes | The key for Celo's x402 facilitator, which checks and settles the payments. A person makes it at x402.celo.org. |
| `SPEND_WALLET_PRIVATE_KEY` | Yes | Yes | The spend wallet's key (`0x` and 64 hex characters). |
| `REFUND_WALLET_PRIVATE_KEY` | Yes | Yes | The refund wallet's key (`0x` and 64 hex characters). |
| `CELO_RPC_URL` | No, default `https://forno.celo.org` | If it carries a key | The Celo node the service reads and sends transactions through. |
| `ERC8021_CODE` | No | No | The builder-code tag a hackathon assigns (1 to 32 lowercase letters, digits or underscores). When set, it goes in the payment offer and at the end of every refund; without it, nothing is tagged. |
| `AGENT_ID` | No | No | The ERC-8004 agent id, set after registering; the file at `/.well-known/agent-registration.json` lists it. A positive whole number in decimal. |
| `DATABASE_URL` | Yes | Yes | The Neon connection URL. |
| `DATABASE_URL_UNPOOLED` | No | Yes | Used only by `db:migrate`, in place of `DATABASE_URL`. |
| `BLOB_READ_WRITE_TOKEN` | Yes | Yes | The token of the private Blob store. |
| `GEMINI_API_KEY` | Yes | Yes | The Gemini API key, for the music. |
| `LINK_SIGNING_SECRET` | Yes | Yes | Signs the delivery links, at least 32 characters. Changing it ends every link already given. |
| `CRON_SECRET` | Yes | Yes | At least 32 characters. The cron routes accept only a request that carries it as a bearer token: Vercel's cron and the Cloudflare clock send it. |
| `PUBLIC_BASE_URL` | Yes | No | Where the service lives, with no trailing slash. It builds the status and delivery links and is the address the rented machine calls (the machine's script takes `https` only). The clock's `RECONCILE_URL` must match it. |
| `GITHUB_REPO` | Yes | No | `owner/name` of the public repository the rented machine downloads its code from. |
| `VM_CODE_REF` | Only without `VERCEL_GIT_COMMIT_SHA` | No | A commit or tag for the machine to download when the deployment has no commit of its own. |
| `SPEND_CAP_PER_ORDER_USD` | No, default `2.5` | No | The most an order may spend on model and music calls. A call that only improves the video (a correction, the review, a third music track) is not made if it would pass the cap. |
| `BUY_DAILY_CAP_USD` | No, default `2` | No | The most the service may pay buy for machines in a UTC day, every order together. When what was paid today, plus 0.07 for each order paid today whose machine is not paid yet and for one more order, would pass it, `POST /v1/videos` answers `503 at_capacity` until the next UTC day, before any payment. |
| `REFUND_DAILY_CAP_USD` | No, default `10` | No | The most it may refund in a UTC day, every order together. |
| `PRECHECK_DAILY_CAP_USD` | No, default `2` | No | The most the free site check's model calls may cost in a UTC day, every quote together. Past it, a site that was not checked in the last 24 hours gets a 503 until the next UTC day. |
| `VERCEL_ENV` | Set by Vercel | No | `production` turns on the checks that keep a test setup out of production: no fake adapters, no in-memory or local database, and a commit for the machine. |
| `VERCEL_GIT_COMMIT_SHA` | Set by Vercel | No | The deployed commit, which the machine downloads. Needs the system variables turned on. |

Limits that live in the code and have no variable: a machine is paid at most 0.07 USDT (`VM_MAX_ATOMIC` in `packages/web/src/payments/vm-payment.ts`), and a refund spends at most 0.05 on gas (`MAX_REFUND_FEE_ATOMIC` in `packages/web/src/adapters/real/refunds.ts`).

Only for tests and for the refund run, never for a normal deployment:

| Name | What it is for |
| --- | --- |
| `AD_AGENT_ADAPTERS` | `real` (the default) or `fake`, the doubles the tests use. Production refuses `fake`. |
| `FAKE_DIR`, `FAKE_SCENARIO` | The folder the fake adapters keep their files in, and the scenario they play. |
| `DEV_MODE` | `1` is for a paid run of the refund path: it needs a cheap `PRICE_ATOMIC` (below `1000000`) and refuses a real price. |
| `FORCE_FAIL_AT` | `before-vm`, with `DEV_MODE=1`: the order is refunded before it rents a machine. Take both out once the run is done. |

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

MIT. See [LICENSE](LICENSE).
