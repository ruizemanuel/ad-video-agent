// POST /v1/videos: order an ad video for a website. Without a payment it is a free quote: the body is checked, the
// site goes through the pre-check, and the answer is a 402 with the price (or a 400/422 that asks for nothing). With
// an x402 payment that the facilitator verifies, the order is made and the answer is 202 with where to follow it;
// only then is the payment settled, and only a settled payment starts the order's run.
import { OrderRequestSchema } from '@app/core';
import { decodePaymentSignatureHeader } from '@x402/core/http';
import { withX402 } from '@x402/next';
import { NextRequest, NextResponse } from 'next/server';
import { env, type Env } from '../../../env';
import { markPaidAndStart, serviceBase } from '../../../payments/orders';
import { createResourceServer, formatPrice, readSignedPayment, routeConfig, type SignedPayment } from '../../../payments/x402';
import { precheck } from '../../../precheck/precheck';
import type { OrderRequest } from '../../../ports';
import { videosDeps, type VideosDeps } from './deps';

const ROUTE = '/v1/videos';
const THIN_HINT = 'Your site shows little of the product. Adding up to 3 public pages of the app as extraUrls makes a better video.';

const NO_STORE = { 'cache-control': 'no-store' };
const refuse = (status: number, error: string, reason: string): Response => Response.json({ error, reason }, { status, headers: NO_STORE });

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

/**
 * Makes the order of a verified payment. The same payment always gives the same order, so a client that sends it
 * again gets the order it already has. An answer of 400 or more cancels the settlement, so nothing is charged.
 */
const createOrder =
  (deps: VideosDeps, settings: Env) =>
  async (request: NextRequest): Promise<NextResponse> => {
    const payment = signedPayment(request);
    if (payment === null) {
      return NextResponse.json({ error: 'invalid_payment', reason: 'The payment must be a USDT or USDC authorization on Celo.' }, { status: 400, headers: NO_STORE });
    }
    const body = await readBody(request);
    if (!body.ok) return NextResponse.json({ error: 'invalid_request', reason: body.reason }, { status: 400, headers: NO_STORE });
    const { order } = await deps.store.createOrder({ request: body.order, ...payment });
    const statusUrl = `${serviceBase(settings, request)}${ROUTE}/${order.id}`;
    return NextResponse.json({ orderId: order.id, statusUrl }, { status: 202, headers: { ...NO_STORE, 'content-location': statusUrl } });
  };

type PaidHandler = (request: NextRequest) => Promise<NextResponse>;

// Built once per set of dependencies: making it asks the facilitator what it supports.
let paid: { deps: VideosDeps; handler: PaidHandler } | undefined;

function paidHandler(deps: VideosDeps, settings: Env): PaidHandler {
  if (paid?.deps !== deps) {
    const server = createResourceServer(settings, deps.facilitator, (payment) => markPaidAndStart(payment, { store: deps.store }));
    paid = { deps, handler: withX402(createOrder(deps, settings), { [ROUTE]: routeConfig(settings) }, server) };
  }
  return paid.handler;
}

export async function POST(req: Request): Promise<Response> {
  const request = req instanceof NextRequest ? req : new NextRequest(req);
  const settings = env();

  const body = await readBody(request);
  if (!body.ok) return refuse(400, 'invalid_request', body.reason);
  if (body.order.audio === 'voice') return refuse(400, 'voice_not_available_yet', 'Voice-over is not available yet. Ask for audio "music" or "none".');

  // Before any payment is looked at: a site that fails the check is never charged.
  const deps = await videosDeps();
  const check = await precheck(body.order.url, { store: deps.store, llm: deps.llm, fetchPage: deps.fetchPage });
  if (!check.ok) return refuse(422, check.code, check.reason);

  const res = await paidHandler(deps, settings)(request);
  if (res.status !== 402) return res;

  // The price is in the PAYMENT-REQUIRED header, for x402 clients. The body says it for whoever reads it.
  const headers = new Headers(res.headers);
  headers.set('content-type', 'application/json');
  headers.delete('content-length');
  const quote = {
    precheck: { thinSite: check.thin, ...(check.thin === true && { hint: THIN_HINT }) },
    termsUrl: `${serviceBase(settings, request)}/terms`,
    price: { amount: formatPrice(settings.PRICE_ATOMIC), assets: ['USDT', 'USDC'] },
  };
  return Response.json(quote, { status: 402, headers });
}
