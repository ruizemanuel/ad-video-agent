// A facilitator that never touches a chain: it says every payment is valid and settles it at once, unless a test asks
// it to refuse the payment, to fail the settlement, or to time out while settling (an outcome nobody knows). It
// counts the calls, so a test can say a payment was (or was not) looked at.
import { FacilitatorTimeoutError, type FacilitatorClient } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from '@x402/core/types';

export const FAKE_SETTLE_TX = `0xabc${'0'.repeat(61)}`;

const payerOf = (payload: PaymentPayload): string | undefined => {
  const authorization = (payload.payload as { authorization?: { from?: unknown } }).authorization;
  return typeof authorization?.from === 'string' ? authorization.from : undefined;
};

export class FakeFacilitator implements FacilitatorClient {
  readonly calls = { verify: 0, settle: 0, supported: 0 };
  /** What the next verifications answer. `invalid` is what a reused or forged payment gets from the real one. */
  verification: 'valid' | 'invalid' = 'valid';
  /** What the next settlements do. */
  settlement: 'success' | 'failure' | 'timeout' = 'success';

  async verify(payload: PaymentPayload): Promise<VerifyResponse> {
    this.calls.verify += 1;
    const payer = payerOf(payload);
    if (this.verification === 'invalid') return { isValid: false, invalidReason: 'invalid_exact_evm_payload_authorization_nonce', payer };
    return { isValid: true, payer };
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    this.calls.settle += 1;
    const payer = payerOf(payload);
    if (this.settlement === 'timeout') throw new FacilitatorTimeoutError('settle', 90_000);
    if (this.settlement === 'failure') return { success: false, errorReason: 'insufficient_funds', transaction: '', network: requirements.network, payer };
    return { success: true, transaction: FAKE_SETTLE_TX, network: requirements.network, payer };
  }

  async getSupported(): Promise<SupportedResponse> {
    this.calls.supported += 1;
    return { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:42220' }], extensions: [], signers: {} };
  }
}
