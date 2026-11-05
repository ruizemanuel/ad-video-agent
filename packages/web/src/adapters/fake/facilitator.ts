// A facilitator that never touches a chain: it says every payment is valid and settles it at once, unless a test asks
// it to refuse the payment, to fail the settlement, or to time out or leave it pending while settling (outcomes nobody
// knows). It counts the calls, so a test can say a payment was (or was not) looked at. The route's tests hand it over
// themselves; the app takes it when AD_AGENT_ADAPTERS is `fake` (see app/v1/videos/deps.ts), so no payment reaches
// Celo's.
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
  /**
   * What the next settlements do. `failure` is the real one's answer for a payer without the funds, before it sends
   * anything. `pending` is its answer when it sent the transaction but did not see it land: the tokens may still move.
   * `pending_then_used` answers `pending` to a payment the first time, and to the retry that x402 then makes, what an
   * instance of the real one that did not keep the transaction answers once it has landed: the authorization is used.
   */
  settlement: 'success' | 'failure' | 'timeout' | 'pending' | 'pending_then_used' = 'success';
  /** The payments (by authorization nonce) that `pending_then_used` has answered `pending` to. */
  private readonly sentPending = new Set<string>();

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
    const failed = (errorReason: string, transaction = ''): SettleResponse => ({ success: false, errorReason, transaction, network: requirements.network, payer });
    if (this.settlement === 'failure') return failed('invalid_exact_evm_insufficient_balance');
    if (this.settlement === 'pending') return failed('settlement_pending', FAKE_SETTLE_TX);
    if (this.settlement === 'pending_then_used') {
      const nonce = (payload.payload as { authorization?: { nonce?: string } }).authorization?.nonce ?? '';
      if (this.sentPending.delete(nonce)) return failed('invalid_exact_evm_nonce_already_used');
      this.sentPending.add(nonce);
      return failed('settlement_pending', FAKE_SETTLE_TX);
    }
    return { success: true, transaction: FAKE_SETTLE_TX, network: requirements.network, payer };
  }

  async getSupported(): Promise<SupportedResponse> {
    this.calls.supported += 1;
    return { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:42220' }], extensions: [], signers: {} };
  }
}
