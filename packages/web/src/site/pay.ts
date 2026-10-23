// Paying a quoted order from the person's wallet, the way any x402 client pays the service: the wallet signs one
// payment in the token chosen for it (a signature, no gas), and the order goes again with that payment and the wallet's
// address. The payment is sent once: whatever its answer, it is never sent again.
import { x402Client } from '@x402/core/client';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import type { ClientEvmSigner } from '@x402/evm';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { celo } from 'viem/chains';
import { TOKENS, type TokenSymbol } from '../payments/tokens';
import { ORDER_FORM } from './copy';
import { jsonBody, ORDER_PATH, PAYER_HEADER, type OrderInput } from './quote';

/** Celo mainnet, as x402 names it. */
const CELO_NETWORK = `eip155:${celo.id}` as const;

/**
 * The most the page lets a wallet sign for in one payment, in atomic units of either token: 10 USDT or USDC, a ceiling
 * against a price gone wrong, well above any the service asks (2 USDT at opening). x402's own default, $1, is below it.
 */
const MAX_PAYMENT_ATOMIC = 10_000_000n;

export type PayResult = { ok: true; orderId: string } | { ok: false; reason: string };

/** The signed payment was sent and no answer came back: it may have gone through or not. */
export class PaymentNotConfirmed extends Error {
  constructor(cause: unknown) {
    super('The payment was sent and its answer never came back.', { cause });
    this.name = 'PaymentNotConfirmed';
  }
}

/** The token to pay `amountAtomic` with: USDT if the wallet holds enough of it, else USDC, else none. */
export function chooseToken(balances: { USDT: bigint; USDC: bigint }, amountAtomic: bigint): TokenSymbol | null {
  if (balances.USDT >= amountAtomic) return 'USDT';
  if (balances.USDC >= amountAtomic) return 'USDC';
  return null;
}

/**
 * Has `signer` sign the payment `required` asks for, in `token` only and for no more than `maxAmountAtomic` (the price
 * the person was shown), and sends the order with it. Asked for more, the x402 client itself refuses: it throws before
 * the wallet is asked, and nothing is sent. Any answer that names an order is that order: one whose payment then failed
 * or ended in doubt is still the person's, and its page says how it ends. An answer that names none is a refusal, with
 * the service's reason. A wallet that does not sign throws its own error, and nothing is sent; a payment whose answer
 * never comes back throws PaymentNotConfirmed.
 */
export async function payOrder({
  input,
  required,
  token,
  signer,
  maxAmountAtomic,
  fetcher = fetch,
}: {
  input: OrderInput;
  required: PaymentRequired;
  token: TokenSymbol;
  signer: ClientEvmSigner;
  maxAmountAtomic: bigint;
  fetcher?: typeof fetch;
}): Promise<PayResult> {
  const asset = TOKENS[token].address;
  const cap = maxAmountAtomic < MAX_PAYMENT_ATOMIC ? maxAmountAtomic : MAX_PAYMENT_ATOMIC;
  const client = new x402Client()
    .register(CELO_NETWORK, new ExactEvmScheme(signer))
    // The chosen token's own cap, in its atomic units; the other token is left out by the policy below.
    .setSpendControls({ maxAmountPerPayment: false, allowedAssets: [{ network: CELO_NETWORK, asset, maxAmountPerPayment: cap.toString() }] })
    .registerPolicy((_version, offers) => offers.filter((offer) => offer.asset.toLowerCase() === asset.toLowerCase()));
  // The wallet is asked here; if it does not sign, this throws and nothing has left the page.
  const payment = await client.createPaymentPayload(required);

  let res: Response;
  let body: Record<string, unknown>;
  try {
    res = await fetcher(ORDER_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'payment-signature': encodePaymentSignatureHeader(payment), [PAYER_HEADER]: signer.address },
      body: JSON.stringify(input),
      cache: 'no-store',
    });
    body = await jsonBody(res);
  } catch (error) {
    throw new PaymentNotConfirmed(error);
  }

  if (typeof body.orderId === 'string' && body.orderId !== '') return { ok: true, orderId: body.orderId };
  const reason = typeof body.reason === 'string' && body.reason !== '' ? body.reason : undefined;
  // A refusal (4xx) comes before the payment is taken. Any other answer that names no order may come after it was.
  const refused = res.status >= 400 && res.status < 500;
  return { ok: false, reason: reason ?? (refused ? ORDER_FORM.errors.paymentRefused : ORDER_FORM.errors.notConfirmed) };
}
