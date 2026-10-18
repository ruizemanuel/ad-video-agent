// Pays a 402 the way an x402 client does: it reads what the answer asks for and signs an EIP-3009 authorization from
// a new random wallet. Nothing reaches a chain; the signature is real, the wallet has no money.
import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

export type PaymentHeaders = { 'PAYMENT-SIGNATURE': string };

export type PayOptions = {
  /** The token to pay with; without it, the client takes the first one offered. */
  asset?: string;
  /**
   * A dishonest client: it signs an authorization for another amount or to another address, and still claims to
   * accept the offer the server made.
   */
  signed?: { amount?: string; payTo?: string };
};

export async function pay(res402: Response, options: PayOptions = {}): Promise<PaymentHeaders> {
  const header = res402.headers.get('PAYMENT-REQUIRED');
  if (header === null) throw new Error(`Expected a 402 with a PAYMENT-REQUIRED header; got ${res402.status}.`);
  const required = decodePaymentRequiredHeader(header);
  const client = new x402Client()
    .register('eip155:42220', new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())))
    // The client's own cap is US$ 1 a payment, and the service costs more.
    .setSpendControls({ maxAmountPerPayment: '$100' });
  const { asset, signed } = options;
  if (asset !== undefined) client.registerPolicy((_version, offers) => offers.filter((offer) => offer.asset.toLowerCase() === asset.toLowerCase()));

  const toSign: PaymentRequired =
    signed === undefined ? required : { ...required, accepts: required.accepts.map((offer) => ({ ...offer, amount: signed.amount ?? offer.amount, payTo: signed.payTo ?? offer.payTo })) };
  const payload = await client.createPaymentPayload(toSign);
  if (signed !== undefined) {
    const offer = required.accepts.find((candidate) => candidate.asset === payload.accepted.asset);
    if (offer === undefined) throw new Error('The signed payment names a token the server did not offer.');
    payload.accepted = offer;
  }
  return { 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(payload) };
}
