// POST /v1/videos: order an ad video for a website. Without a payment it is a free quote: the body is checked, the
// site and each of its extra pages go through the pre-check, and the answer is a 402 with the price (or a 400/422 that
// asks for nothing, or a 503 when the check cannot be made now). Before the pre-check, with a payment or without, an
// order today's VMs have no room for is refused with a 503 (`at_capacity`) until the next UTC day, so it is never
// charged. The price is the full one, or the first-video price
// for a wallet the promo takes that the request names in its x-payer header. With an x402 payment that the facilitator
// verifies, the order is made and the answer is 202 with where to follow it; only then is the payment settled, and only
// a settled payment starts the order's run.
import { OrderRequestSchema } from '@app/core';
import { decodePaymentRequiredHeader, decodePaymentSignatureHeader } from '@x402/core/http';
import { withX402 } from '@x402/next';
import { NextResponse, type NextRequest } from 'next/server';
import { env, type Env } from '../../../env';
import { markPaidAndStart, serviceBase } from '../../../payments/orders';
import { hasVmCapacity, secondsToNextUtcDay } from '../../../payments/vm-payment';
import {
  authorizationWindowProblem,
  createResourceServer,
  formatPrice,
  PAYER_HINT_HEADER,
  payerHint,
  PROMO_PRICE_ATOMIC,
  promoGate,
  readSignedPayment,
  routeConfig,
  type SettledPayment,
  type SignedPayment,
} from '../../../payments/x402';
import { precheck, PrecheckCapReached, type PrecheckDeps } from '../../../precheck/precheck';
import { ModelCallFailed, ModelOutputInvalid, type Order, type OrderRequest, type PrecheckResult } from '../../../ports';
import { videosDeps, type VideosDeps } from './deps';

const ROUTE = '/v1/videos';
const THIN_HINT = 'Your site shows little of the product. Adding up to 3 public pages of the app as extraUrls makes a better video.';
/** When to ask again after the classifier failed: a minute. */
const MODEL_RETRY_AFTER_SECONDS = 60;

const NO_STORE = { 'cache-control': 'no-store' };
const PROMO_PAYER_REASON =
  'The first-video price must be paid by the wallet that asked for it: name that wallet in the x-payer header, and sign the payment with it.';
const PROMO_GONE_REASON = 'The first-video price is no longer available for this wallet. Ask for a new quote.';
const AT_CAPACITY_REASON = 'We have made all the videos we can for today. Try again after the time in Retry-After. Nothing was charged.';
const refuse = (status: number, error: string, reason: string, headers: Record<string, string> = {}): Response =>
  Response.json({ error, reason }, { status, headers: { ...NO_STORE, ...headers } });

/** The 503 for a check that cannot be made now, with when to try again; null for an error that is not one of those. */
function checkUnavailable(error: unknown): Response | null {
  if (error instanceof PrecheckCapReached) {
    const reason = 'The free site check has reached its limit for today. Try again after the time in Retry-After.';
    return refuse(503, 'precheck_unavailable', reason, { 'retry-after': String(error.retryAfterSeconds) });
  }
  // The classifier answered with something that did not fit, or did not answer: there is no verdict, so no price yet.
  if (error instanceof ModelOutputInvalid || error instanceof ModelCallFailed) {
    return refuse(503, 'precheck_unavailable', 'The site could not be checked right now. Try again in a minute.', { 'retry-after': String(MODEL_RETRY_AFTER_SECONDS) });
  }
  return null;
}

/**
 * The site and then each of its extra pages through the pre-check (each kept a day, as the site is), until one fails.
 * The site's own result, or the answer that refuses the order: a 422 that names the page that failed, or a 503.
 */
async function checkPages(order: OrderRequest, deps: PrecheckDeps): Promise<{ ok: true; site: Extract<PrecheckResult, { ok: true }> } | { ok: false; answer: Response }> {
  const pages = [order.url, ...(order.extraUrls ?? [])];
  let site: Extract<PrecheckResult, { ok: true }> | undefined;
  for (const [index, url] of pages.entries()) {
    let check: PrecheckResult;
    try {
      check = await precheck(url, deps);
    } catch (error) {
      const answer = checkUnavailable(error);
      if (answer === null) throw error;
      return { ok: false, answer };
    }
    // The reasons are written for the client; an extra page's says which one it is.
    if (!check.ok) return { ok: false, answer: refuse(422, check.code, index === 0 ? check.reason : `extraUrls[${index - 1}] (${url}): ${check.reason}`) };
    site ??= check;
  }
  if (site === undefined) throw new Error('The order has no site to check.');
  return { ok: true, site };
}

type ParsedBody = { ok: true; order: OrderRequest } | { ok: false; reason: string };

/** The body, checked. It is read from a copy, so the request can still be read further on. */
async function readBody(request: Request): Promise<ParsedBody> {
  let raw: unknown;
  try {
    raw = await request.clone().json();
  } catch {
    return { ok: false, reason: 'The body must be JSON.' };
  }
  const parsed = OrderRequestSchema.safeParse(raw);
  if (parsed.success) return { ok: true, order: parsed.data };
  return { ok: false, reason: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ') };
}

/** Reads the payment that `withX402` has just verified: it is the same header. */
function signedPayment(request: Request): SignedPayment | null {
  const header = request.headers.get('payment-signature');
  if (header === null) return null;
  try {
    return readSignedPayment(decodePaymentSignatureHeader(header));
  } catch {
    return null;
  }
}

type OrderLink = { orderId: string; statusUrl: string };

// The order each request's own verified payment made (or found), kept until its answer is written: if the settlement
// then fails or ends in doubt, the answer still tells the payer where the order is.
const ordersOfRequests = new WeakMap<Request, OrderLink>();

/**
 * Makes the order of a verified payment. The same payment always gives the same order, so a client that sends it
 * again gets the order it already has. An answer of 400 or more cancels the settlement, so nothing is charged: a payment
 * that is not one the service takes, or whose authorization is not valid yet or is valid for longer than the offer asks,
 * makes no order. Nor does a payment at the first-video price that the wallet named in x-payer did not sign, or one that
 * finds no promo slot left for its wallet when its order is made.
 */
const createOrder =
  (deps: VideosDeps, settings: Env) =>
  async (request: NextRequest): Promise<NextResponse> => {
    const payment = signedPayment(request);
    if (payment === null) {
      const reason = 'The payment must be a USDT or USDC authorization on Celo for the price the quote names, to the address it names.';
      return NextResponse.json({ error: 'invalid_payment', reason }, { status: 400, headers: NO_STORE });
    }
    const window = authorizationWindowProblem(payment, Date.now() / 1000);
    if (window !== null) return NextResponse.json({ error: 'invalid_payment', reason: window }, { status: 400, headers: NO_STORE });
    const body = await readBody(request);
    if (!body.ok) return NextResponse.json({ error: 'invalid_request', reason: body.reason }, { status: 400, headers: NO_STORE });

    let order: Order;
    if (payment.amount === PROMO_PRICE_ATOMIC && PROMO_PRICE_ATOMIC !== settings.PRICE_ATOMIC) {
      // The offer was the first-video price because the request named a wallet: that wallet must be the one that pays.
      if (payerHint(request.headers.get(PAYER_HINT_HEADER)) !== payment.payer.toLowerCase()) {
        return NextResponse.json({ error: 'invalid_payment', reason: PROMO_PAYER_REASON }, { status: 400, headers: NO_STORE });
      }
      const promo = await deps.store.createPromoOrder({ request: body.order, ...payment }, settings.PROMO_SLOTS);
      if ('refused' in promo) return NextResponse.json({ error: 'promo_unavailable', reason: PROMO_GONE_REASON }, { status: 409, headers: NO_STORE });
      order = promo.order;
    } else {
      order = (await deps.store.createOrder({ request: body.order, ...payment })).order;
    }
    const link = { orderId: order.id, statusUrl: `${serviceBase(settings, request)}${ROUTE}/${order.id}` };
    ordersOfRequests.set(request, link);
    return NextResponse.json(link, { status: 202, headers: { ...NO_STORE, 'content-location': link.statusUrl } });
  };

/** Runs after each settlement that went through. A settled payment with no order is money with nowhere to go: say so. */
async function paymentSettled(payment: SettledPayment, deps: VideosDeps): Promise<void> {
  if ((await markPaidAndStart(payment, { store: deps.store })) === 'unknown') {
    console.error('[settled_without_order]', payment.asset, payment.payer, payment.nonce);
  }
}

type PaidHandler = (request: NextRequest) => Promise<NextResponse>;

// Built once per set of dependencies: making it asks the facilitator what it supports. The price each request is
// offered is worked out from that set's store.
let paid: { deps: VideosDeps; handler: PaidHandler } | undefined;

function paidHandler(deps: VideosDeps, settings: Env): PaidHandler {
  if (paid?.deps !== deps) {
    const server = createResourceServer(settings, deps.facilitator, (payment) => paymentSettled(payment, deps));
    const routes = { [ROUTE]: routeConfig(settings, promoGate(settings, deps.store)) };
    paid = { deps, handler: withX402(createOrder(deps, settings), routes, server) };
  }
  return paid.handler;
}

/**
 * What a 402 asks to be paid, in atomic units: the offer in its PAYMENT-REQUIRED header, the price this request was
 * offered. A 402 for a settlement that failed has no such header; its payment matched the offer, so it says the price.
 */
function askedPrice(res: Response, request: Request, fullPrice: bigint): bigint {
  const header = res.headers.get('payment-required');
  if (header !== null) {
    try {
      const amount = decodePaymentRequiredHeader(header).accepts[0]?.amount;
      if (amount !== undefined) return BigInt(amount);
    } catch {
      // Not one this service wrote: the price below.
    }
  }
  return signedPayment(request)?.amount ?? fullPrice;
}

/** A JSON body as an object, or an empty one when it is not. */
async function jsonObject(res: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await res.json();
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// The request is used as Next hands it over, never copied into a new one: Next makes it with another NextRequest class
// than the one this file would import, and wraps it in a Proxy that a new Request cannot be made from.
export async function POST(request: NextRequest): Promise<Response> {
  const settings = env();

  const body = await readBody(request);
  if (!body.ok) return refuse(400, 'invalid_request', body.reason);
  if (body.order.audio === 'voice') return refuse(400, 'voice_not_available_yet', 'Voice-over is not available yet. Ask for audio "music" or "none".');

  const deps = await videosDeps();
  // Before the check and any payment: an order whose VM today's buy cap has no room for is never taken, nor charged.
  const now = new Date();
  if (!(await hasVmCapacity({ store: deps.store, dailyCapUsd: settings.BUY_DAILY_CAP_USD }, now))) {
    return refuse(503, 'at_capacity', AT_CAPACITY_REASON, { 'retry-after': String(secondsToNextUtcDay(now)) });
  }

  // Before any payment is looked at: a site, or an extra page, that fails the check is never charged.
  const checked = await checkPages(body.order, { store: deps.store, llm: deps.llm, fetchPage: deps.fetchPage, dailyCapUsd: settings.PRECHECK_DAILY_CAP_USD });
  if (!checked.ok) return checked.answer;
  const check = checked.site;

  const res = await paidHandler(deps, settings)(request);
  // Only this request's own verified payment made an order: a payment the facilitator refused never got this far.
  const made = ordersOfRequests.get(request);
  if (res.status < 400 || (res.status !== 402 && made === undefined)) return res;

  // The status and the x402 headers stay as they are. The price is in the PAYMENT-REQUIRED header, for x402 clients;
  // the body says the same price for whoever reads it. When the settlement failed or ended in doubt (a facilitator
  // timeout) after the order was made, the body and Content-Location also say where the order is: it starts if the
  // payment reaches the chain, and is given up as unpaid if it never does.
  const headers = new Headers(res.headers);
  headers.set('content-type', 'application/json');
  headers.set('cache-control', 'no-store');
  headers.delete('content-length');
  const answer =
    res.status === 402
      ? {
          precheck: { thinSite: check.thin, ...(check.thin === true && { hint: THIN_HINT }) },
          termsUrl: `${serviceBase(settings, request)}/terms`,
          price: { amount: formatPrice(askedPrice(res, request, settings.PRICE_ATOMIC)), assets: ['USDT', 'USDC'] },
        }
      : await jsonObject(res);
  if (made !== undefined) headers.set('content-location', made.statusUrl);
  return Response.json({ ...answer, ...made }, { status: res.status, headers });
}
