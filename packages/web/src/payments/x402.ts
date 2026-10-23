// How the service is paid: x402 on Celo, in USDT or USDC, through Celo's own facilitator. The client signs an
// EIP-3009 authorization; the facilitator checks it, and after the order is made it moves the tokens straight from
// the client to PAYTO_ADDRESS (it never holds them).
import { HTTPFacilitatorClient, x402ResourceServer, type FacilitatorClient, type HTTPAdapter, type HTTPRequestContext, type RouteConfig } from '@x402/core/server';
import type { DeepReadonly, PaymentPayload } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { BUILDER_CODE, declareBuilderCodeExtension } from '@x402/extensions/builder-code';
import { z } from 'zod';
import type { Env } from '../env';
import type { OrderStore } from '../ports';
import { TOKENS, type TokenSymbol } from './tokens';

/** Celo mainnet. */
export const CELO = 'eip155:42220';
export const FACILITATOR_URL = 'https://api.x402.celo.org';

// The tokens live in tokens.ts, which loads nothing of x402; they are named here too, where the payments are.
export { TOKENS, type TokenSymbol } from './tokens';

const SYMBOLS = Object.keys(TOKENS) as TokenSymbol[];

/** How long a signed payment may wait to be settled: the offer's maxTimeoutSeconds. */
export const MAX_TIMEOUT_SECONDS = 300;

/**
 * How far ahead of this server's clock a client's may run. x402 clients sign validBefore as their now plus the offer's
 * maxTimeoutSeconds, so one up to this much later is still an honest client's.
 */
export const CLIENT_CLOCK_SKEW_SECONDS = 60;

/**
 * How far in the future validAfter may be: not at all. The facilitator refuses an authorization whose validAfter is past
 * its clock (@x402/evm 2.28.0, exact scheme: no skew), and x402 clients sign 0 or a moment in the past.
 */
export const VALID_AFTER_SKEW_SECONDS = 0;

/** Atomic units of a 6-decimal token as a plain amount: 5000000 is "5", 50000 is "0.05". */
export function formatPrice(atomic: bigint): string {
  const units = atomic / 1_000_000n;
  const fraction = (atomic % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction === '' ? units.toString() : `${units}.${fraction}`;
}

/** What a wallet's first video costs while it has a promo slot to take, in atomic units: 0.01 USDT or USDC. */
export const PROMO_PRICE_ATOMIC = 10_000n;

/**
 * The header a client names its wallet in, to be offered the first-video price. It is only a hint: an order at that
 * price must be paid by the wallet it names.
 */
export const PAYER_HINT_HEADER = 'x-payer';

/** Whether the wallet a request names (in lowercase, or null for none) is offered the first-video price. */
export type PromoGate = { eligible(hint: string | null): Promise<boolean> };

/** The wallet an `x-payer` header names, in lowercase; null for no header, or for one that is not an address. */
export function payerHint(header: string | null | undefined): string | null {
  return header !== null && header !== undefined && /^0x[0-9a-fA-F]{40}$/.test(header) ? header.toLowerCase() : null;
}

/**
 * The promo as the settings and the store say it: a wallet is offered the first-video price while the promo is on
 * (PROMO_SLOTS above 0), it is not one of TEAM_WALLETS, it has no video, and a slot is free.
 */
export function promoGate(settings: Pick<Env, 'PROMO_SLOTS' | 'TEAM_WALLETS'>, store: Pick<OrderStore, 'hasVideo' | 'promoSlotsUsed'>): PromoGate {
  return {
    async eligible(hint) {
      if (hint === null || settings.PROMO_SLOTS === 0) return false;
      const wallet = hint.toLowerCase();
      if (settings.TEAM_WALLETS.includes(wallet) || (await store.hasVideo(wallet))) return false;
      return (await store.promoSlotsUsed()) < settings.PROMO_SLOTS;
    },
  };
}

/**
 * The price offered to a request: the first-video price when it names a wallet the promo takes, the full one otherwise.
 * A promo check that fails never fails the quote: the price is then the full one.
 */
async function offeredPrice(context: HTTPRequestContext, fullPrice: bigint, promo: PromoGate): Promise<bigint> {
  const hint = payerHint(context.adapter.getHeader(PAYER_HINT_HEADER));
  if (hint === null) return fullPrice;
  try {
    return (await promo.eligible(hint)) ? PROMO_PRICE_ATOMIC : fullPrice;
  } catch (error) {
    console.error('[promo_check_failed]', error instanceof Error ? error.message : String(error));
    return fullPrice;
  }
}

/**
 * What `withX402` asks for on POST /v1/videos: the price offered to the request (see `offeredPrice`) in each token, to
 * the service wallet, on Celo. It is worked out again for the paying request, so a payment at the first-video price
 * matches the offer only while that request is still offered it.
 */
export function routeConfig(settings: Pick<Env, 'PAYTO_ADDRESS' | 'PRICE_ATOMIC' | 'ERC8021_CODE'>, promo: PromoGate): RouteConfig {
  const code = settings.ERC8021_CODE;
  // x402 asks each token for its price: one answer per request (its adapter), so both tokens are offered the same one.
  const prices = new WeakMap<HTTPAdapter, Promise<bigint>>();
  const priceFor = (context: HTTPRequestContext): Promise<bigint> => {
    let price = prices.get(context.adapter);
    if (price === undefined) {
      price = offeredPrice(context, settings.PRICE_ATOMIC, promo);
      prices.set(context.adapter, price);
    }
    return price;
  };
  return {
    // A price in dollars ("$5") would quietly become USDC only: each token gets its own price, in its own units.
    accepts: SYMBOLS.map((symbol) => ({
      scheme: 'exact',
      network: CELO,
      payTo: settings.PAYTO_ADDRESS,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      price: async (context: HTTPRequestContext) => ({
        amount: (await priceFor(context)).toString(),
        asset: TOKENS[symbol].address,
        extra: { ...TOKENS[symbol].extra },
      }),
    })),
    description: `Ad video package from a website URL. Costs ${formatPrice(settings.PRICE_ATOMIC)} USDT or USDC on Celo. x402 clients with a default $1 per-payment cap must raise it.`,
    mimeType: 'application/json',
    ...(code !== undefined && { extensions: { [BUILDER_CODE]: declareBuilderCodeExtension(code) } }),
  };
}

/** What a paying request signed, read from its x402 payload: an EIP-3009 authorization for one of TOKENS on Celo. */
export type SignedPayment = {
  network: string;
  /** The token's address as TOKENS writes it, whatever the case it came in. */
  asset: string;
  payer: string;
  amount: bigint;
  nonce: string;
  validAfter: bigint;
  validBefore: bigint;
};

const hex = (length: number) => z.string().regex(new RegExp(`^0x[0-9a-fA-F]{${length}}$`));
const uint = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);

const PaymentSchema = z.object({
  x402Version: z.literal(2),
  accepted: z.object({ network: z.literal(CELO), asset: z.string(), amount: uint, payTo: hex(40) }),
  payload: z.object({
    authorization: z.object({ from: hex(40), to: hex(40), value: uint, validAfter: uint, validBefore: uint, nonce: hex(64) }),
  }),
});

/**
 * Null for anything else: another network, another token, another way of paying, a payload that is not whole, or an
 * authorization that does not pay exactly the offer it claims to accept (another amount, or to another address). The
 * facilitator checks this too; the service does not count on it.
 */
export function readSignedPayment(payment: PaymentPayload | DeepReadonly<PaymentPayload>): SignedPayment | null {
  const parsed = PaymentSchema.safeParse(payment);
  if (!parsed.success) return null;
  const { accepted, payload } = parsed.data;
  const symbol = SYMBOLS.find((s) => TOKENS[s].address.toLowerCase() === accepted.asset.toLowerCase());
  if (symbol === undefined) return null;
  const { from, to, value, validAfter, validBefore, nonce } = payload.authorization;
  // Both amounts are whole numbers written without leading zeros, so equal text is an equal amount.
  if (value !== accepted.amount || to.toLowerCase() !== accepted.payTo.toLowerCase()) return null;
  return {
    network: accepted.network,
    asset: TOKENS[symbol].address,
    payer: from,
    amount: BigInt(value),
    nonce,
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
  };
}

/**
 * Why the authorization's time window is not one the service takes, for the client, or null. It has to be valid now and
 * for no longer than the offer asks: an authorization that lives long could still settle long after the order was made,
 * past where the reconciliation looks for its settlement (the hour before the earlier of validBefore and now), and keep
 * it asking the chain about it until then.
 */
export function authorizationWindowProblem(payment: Pick<SignedPayment, 'validAfter' | 'validBefore'>, nowSeconds: number): string | null {
  const now = BigInt(Math.floor(nowSeconds));
  if (payment.validAfter > now + BigInt(VALID_AFTER_SKEW_SECONDS)) return 'The payment authorization is not valid yet: its validAfter is in the future.';
  if (payment.validBefore > now + BigInt(MAX_TIMEOUT_SECONDS + CLIENT_CLOCK_SKEW_SECONDS)) {
    return `The payment authorization is valid for too long: its validBefore may be at most ${MAX_TIMEOUT_SECONDS} seconds (maxTimeoutSeconds) from now.`;
  }
  return null;
}

/** A payment the facilitator settled: what finds its order, and the transaction that moved the tokens. */
export type SettledPayment = { asset: string; payer: string; nonce: string; txHash: string };

/**
 * The x402 server of the service, on Celo's facilitator unless a test gives it another one. `onSettled` runs after
 * each settlement that went through; if it throws, the payer still gets their answer and the reconciliation picks the
 * order up later.
 */
export function createResourceServer(
  settings: Pick<Env, 'X402_API_KEY'>,
  facilitator?: FacilitatorClient,
  onSettled?: (payment: SettledPayment) => Promise<unknown>,
): x402ResourceServer {
  const key = settings.X402_API_KEY;
  const client =
    facilitator ??
    new HTTPFacilitatorClient({
      url: FACILITATOR_URL,
      createAuthHeaders: async () => {
        const headers: Record<string, string> = key === undefined ? {} : { 'X-API-Key': key };
        return { verify: headers, settle: headers, supported: headers };
      },
    });
  const server = new x402ResourceServer(client).register(CELO, new ExactEvmScheme());
  if (onSettled !== undefined) {
    server.onAfterSettle(async ({ paymentPayload, result }) => {
      const payment = readSignedPayment(paymentPayload);
      // The route refuses any other payment before it can be settled.
      if (payment === null) return;
      await onSettled({ asset: payment.asset, payer: payment.payer, nonce: payment.nonce, txHash: result.transaction });
    });
  }
  return server;
}
