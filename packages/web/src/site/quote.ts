// What the order form asks the service before any money is involved, through the same API agents use: what an order
// costs now (GET /v1/offer), and the free quote of this order (POST /v1/videos with no payment), which checks the site
// and names the price. A quote that names the wallet that will pay gets that wallet's own price. It runs in the browser,
// so it loads nothing of the x402 server: only the header decoder.
import { decodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { formatUnits } from 'viem';
import { ORDER_FORM } from './copy';

export const ORDER_PATH = '/v1/videos';
export const OFFER_PATH = '/v1/offer';
/** The header that names the wallet that will pay: the service's PAYER_HINT_HEADER (payments/x402.ts). */
export const PAYER_HEADER = 'x-payer';
/**
 * The error of the service's 503 once it has made all the videos it can today. It comes before the order's payment is
 * looked at, to a quote and to a paying request alike: nothing was charged.
 */
export const AT_CAPACITY = 'at_capacity';

/** The order as POST /v1/videos takes it. Parts the person left empty are left out. */
export type OrderInput = { url: string; brief?: string; extraUrls?: string[]; audio: 'music' | 'none' };

export type Quote =
  /**
   * The site passed the check and the order has a price. `amountAtomic` is what the wallet would sign for (the
   * PAYMENT-REQUIRED header's, the same in USDT and USDC); `price` is the same amount as the service writes it, to show.
   */
  | { kind: 'priced'; required: PaymentRequired; amountAtomic: bigint; price: string; thin: boolean; hint?: string; termsUrl: string }
  /** The service will not take this order (400 or 422), and says why. */
  | { kind: 'refused'; reason: string }
  /** The check cannot be made now (503). */
  | { kind: 'unavailable'; retryAfterSeconds: number }
  /** The service has made all the videos it can today (503 `at_capacity`): nothing is taken until the next day. */
  | { kind: 'at_capacity' };

/** What an order costs now, and the first-video promo while it is on. */
export type Offer = { price: string; promo: { price: string; left: number } | null };

/** When a 503 does not say when to try again. */
const DEFAULT_RETRY_AFTER_SECONDS = 60;
/** The tokens' decimals: both have 6. */
const DECIMALS = 6;

type JsonObject = Record<string, unknown>;

/** The answer's JSON body as an object, or an empty one when it has none (an error page, a body cut short). */
export async function jsonBody(res: Response): Promise<JsonObject> {
  try {
    const value: unknown = await res.json();
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
  } catch {
    return {};
  }
}

const field = (value: unknown, key: string): unknown => (value !== null && typeof value === 'object' ? (value as JsonObject)[key] : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** Retry-After in seconds, whether it comes as seconds or as a date. */
function retryAfter(header: string | null): number {
  if (header === null || header.trim() === '') return DEFAULT_RETRY_AFTER_SECONDS;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const at = Date.parse(header);
  return Number.isNaN(at) ? DEFAULT_RETRY_AFTER_SECONDS : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/** The one amount a 402 asks for, the same in every token it offers; it throws for an offer the page cannot pay. */
function askedAmount(required: PaymentRequired): bigint {
  const amounts = new Set(required.accepts.map((offer) => offer.amount));
  const [amount] = amounts;
  if (amounts.size !== 1 || amount === undefined || !/^[1-9][0-9]*$/.test(amount)) {
    throw new Error(`The quote asks for ${[...amounts].join(', ') || 'no amount'}: not one amount the page can pay.`);
  }
  return BigInt(amount);
}

/**
 * The free quote of `input`: POST /v1/videos with no payment, naming `payer` in x-payer when given. It throws for an
 * answer that is none of a quote's (another status, or a 402 with no price to pay), and when the service cannot be
 * reached.
 */
export async function requestQuote(input: OrderInput, payer?: string, fetcher: typeof fetch = fetch): Promise<Quote> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (payer !== undefined) headers[PAYER_HEADER] = payer;
  const res = await fetcher(ORDER_PATH, { method: 'POST', headers, body: JSON.stringify(input), cache: 'no-store' });
  const body = await jsonBody(res);

  if (res.status === 402) {
    const header = res.headers.get('payment-required');
    if (header === null) throw new Error('The quote has no price to pay.');
    const required = decodePaymentRequiredHeader(header);
    const amountAtomic = askedAmount(required);
    const precheck = field(body, 'precheck');
    const hint = text(field(precheck, 'hint'));
    return {
      kind: 'priced',
      required,
      amountAtomic,
      price: text(field(field(body, 'price'), 'amount')) ?? formatUnits(amountAtomic, DECIMALS),
      thin: field(precheck, 'thinSite') === true,
      ...(hint !== undefined && { hint }),
      termsUrl: text(field(body, 'termsUrl')) ?? '/terms',
    };
  }
  if (res.status === 400 || res.status === 422) {
    return { kind: 'refused', reason: text(field(body, 'reason')) ?? ORDER_FORM.errors.refused };
  }
  if (res.status === 503) {
    if (field(body, 'error') === AT_CAPACITY) return { kind: 'at_capacity' };
    return { kind: 'unavailable', retryAfterSeconds: retryAfter(res.headers.get('retry-after')) };
  }
  throw new Error(`The quote answered ${res.status}.`);
}

/** GET /v1/offer: the price of an order and the promo. It throws for any other answer. */
export async function requestOffer(fetcher: typeof fetch = fetch): Promise<Offer> {
  const res = await fetcher(OFFER_PATH, { cache: 'no-store' });
  if (!res.ok) throw new Error(`The offer answered ${res.status}.`);
  const body = await jsonBody(res);
  const price = text(body.price);
  if (price === undefined) throw new Error('The offer has no price.');
  const promoPrice = text(field(body.promo, 'price'));
  const left = field(body.promo, 'left');
  return { price, promo: promoPrice !== undefined && typeof left === 'number' ? { price: promoPrice, left } : null };
}

/**
 * The site's address as the service takes it: an http(s) URL with a host, written whole. What the person typed may
 * leave out the scheme (https:// is added); anything else, or an address with a user name or password in it, is null.
 */
export function normalizeUrl(typed: string): string | null {
  const trimmed = typed.trim();
  if (trimmed === '' || /\s/.test(trimmed)) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.hostname === '' || url.username !== '' || url.password !== '') return null;
  return url.href;
}
