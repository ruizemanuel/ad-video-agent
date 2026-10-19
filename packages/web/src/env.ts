import { z } from 'zod';

/** An empty value counts as missing, so a copied .env.example (`NAME=`) behaves like one without the line. */
const blank = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === '' ? undefined : value), schema);

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be 0x followed by 40 hex characters');
const privateKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be 0x followed by 64 hex characters');
const httpUrl = z.url({ protocol: /^https?$/ });
const secret = z.string().min(32, 'must have at least 32 characters');
const positive = z.coerce.number().positive();

// Atomic units of the payment tokens, which have 6 decimals: 5000000 is 5 USDT.
const PRICE_DEFAULT = 5_000_000n;
// From this price (1 USDT) up, a run is not a development run: DEV_MODE refuses it.
const DEV_PRICE_LIMIT = 1_000_000n;

// Needed when the adapters are the real ones: what the doubles replace.
const REQUIRED_WITH_REAL_ADAPTERS = [
  'DATABASE_URL',
  'BLOB_READ_WRITE_TOKEN',
  'X402_API_KEY',
  'SPEND_WALLET_PRIVATE_KEY',
  'REFUND_WALLET_PRIVATE_KEY',
  'GEMINI_API_KEY',
  'PUBLIC_BASE_URL',
  'GITHUB_REPO',
] as const;

const schema = z
  .object({
    /** Neon's URL (Marketplace). "memory" or "pglite:<folder>" for tests and local runs. */
    DATABASE_URL: blank(z.string().min(1).optional()),
    BLOB_READ_WRITE_TOKEN: blank(z.string().min(1).optional()),
    /** Made by a person at x402.celo.org. */
    X402_API_KEY: blank(z.string().min(1).optional()),
    /** The cold wallet that gets paid. */
    PAYTO_ADDRESS: address,
    PRICE_ATOMIC: blank(
      z
        .string()
        .regex(/^[0-9]+$/, 'must be a whole number of atomic units')
        .transform((value) => BigInt(value))
        .pipe(z.bigint().positive())
        .default(PRICE_DEFAULT),
    ),
    /** The agent's wallet, which pays buy. A person loads it. */
    SPEND_WALLET_PRIVATE_KEY: blank(privateKey.optional()),
    /** The refunds' wallet. A person loads it. */
    REFUND_WALLET_PRIVATE_KEY: blank(privateKey.optional()),
    GEMINI_API_KEY: blank(z.string().min(1).optional()),
    LINK_SIGNING_SECRET: secret,
    CRON_SECRET: secret,
    /** Where the service lives, with no trailing slash: it builds the status and the delivery links. */
    PUBLIC_BASE_URL: blank(
      httpUrl
        .transform((url) => url.replace(/\/+$/, ''))
        .optional(),
    ),
    /** `owner/name`. The VM downloads the code from codeload.github.com at VERCEL_GIT_COMMIT_SHA (or VM_CODE_REF). */
    GITHUB_REPO: blank(
      z
        .string()
        .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'must look like owner/name')
        .optional(),
    ),
    SPEND_CAP_PER_ORDER_USD: blank(positive.default(2.5)),
    BUY_DAILY_CAP_USD: blank(positive.default(2)),
    REFUND_DAILY_CAP_USD: blank(positive.default(10)),
    /**
     * What the free pre-check's model calls may cost in a UTC day, every quote together: anyone can ask for one. A small
     * model's verdict costs well under a tenth of a cent, so the default is thousands of new sites a day.
     */
    PRECHECK_DAILY_CAP_USD: blank(positive.default(2)),
    CELO_RPC_URL: blank(httpUrl.default('https://forno.celo.org')),
    /**
     * The ERC-8021 tag. The hackathon assigns it, so it is optional: without it, nothing is tagged. Its format is the
     * one the x402 builder-code extension and @celo/attribution-tags both accept.
     */
    ERC8021_CODE: blank(
      z
        .string()
        .regex(/^[a-z0-9_]{1,32}$/, 'must be 1 to 32 lowercase letters, digits or underscores')
        .optional(),
    ),
    /** `real` for the service; `fake` only in tests. */
    AD_AGENT_ADAPTERS: blank(z.enum(['real', 'fake']).default('real')),
    /** The folder the fake adapters keep their files in: the tests make a temporary one. */
    FAKE_DIR: blank(z.string().min(1).optional()),
    /** Only for the refund run: a cheap price and a forced failure. */
    DEV_MODE: blank(
      z
        .enum(['0', '1'])
        .default('0')
        .transform((value) => value === '1'),
    ),
    // New fail points are added here, so a typo does not silently skip the failure being tested.
    FORCE_FAIL_AT: blank(z.enum(['before-vm']).optional()),
    // Set by Vercel on its deployments.
    VERCEL_ENV: blank(z.string().optional()),
    VERCEL_GIT_COMMIT_SHA: blank(z.string().optional()),
    /** The commit the VM downloads, when it is not the deployment's. */
    VM_CODE_REF: blank(z.string().optional()),
  })
  .superRefine((settings, ctx) => {
    const issue = (name: string, message: string) => ctx.addIssue({ code: 'custom', path: [name], message });

    if (settings.AD_AGENT_ADAPTERS === 'real') {
      for (const name of REQUIRED_WITH_REAL_ADAPTERS) {
        if (settings[name] === undefined) issue(name, 'Required when AD_AGENT_ADAPTERS is real');
      }
    }
    if (settings.VERCEL_ENV === 'production') {
      if (settings.AD_AGENT_ADAPTERS === 'fake') issue('AD_AGENT_ADAPTERS', 'The fake adapters are for tests and cannot run in production');
      // Without it every paid order would be refunded before its VM (vm_not_configured): the service refuses to take
      // payments instead. The flow keeps its own check, in case.
      if (settings.AD_AGENT_ADAPTERS === 'real' && settings.VERCEL_GIT_COMMIT_SHA === undefined && settings.VM_CODE_REF === undefined) {
        issue('VM_CODE_REF', 'Required in production when VERCEL_GIT_COMMIT_SHA is not set: it is the commit the VM downloads');
      }
      const database = settings.DATABASE_URL;
      if (database !== undefined && (database === 'memory' || database.startsWith('pglite:'))) {
        issue('DATABASE_URL', 'A database that lives in memory or on a local disk cannot run in production');
      }
    }
    if (settings.DEV_MODE && settings.PRICE_ATOMIC >= DEV_PRICE_LIMIT) {
      issue('DEV_MODE', `DEV_MODE needs a development PRICE_ATOMIC below ${DEV_PRICE_LIMIT}`);
    }
    if (settings.FORCE_FAIL_AT !== undefined && !settings.DEV_MODE) {
      issue('FORCE_FAIL_AT', 'FORCE_FAIL_AT needs DEV_MODE=1');
    }
  });

export type Env = z.infer<typeof schema>;

/** Checks a set of variables. A bad value names the variable and what is wrong with it, never its content. */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => `${issue.path.join('.') || '(env)'}: ${issue.message}`);
  throw new Error(`Invalid environment. ${problems.join('; ')}`);
}

let cached: Env | undefined;

/** The server's settings, checked once. */
export function env(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
