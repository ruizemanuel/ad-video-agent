// The BuyPort as a double, for the tests that run the reconciliation and the flow without the chain. It answers what a
// test says about each authorization (by its nonce), and keeps what it was asked, so a test can check that too.
import type { AuthorizationSettlement, BuyPort } from '../../ports';

type SettlementQuery = Parameters<BuyPort['authorizationSettled']>[0];

/** The transfer that spent a nonce on chain. */
export type Transfer = { to: string; value: bigint };

export class FakeBuy implements BuyPort {
  /** What `authorizationSettled` was asked, in order. */
  readonly settlementQueries: SettlementQuery[] = [];

  /** The answer for an authorization the test said nothing about: the chain could not be asked. */
  fallback: AuthorizationSettlement = 'unknown';

  private readonly answers = new Map<string, AuthorizationSettlement | Error>();
  private readonly transfers = new Map<string, Transfer>();

  /** Makes the authorization with this nonce answer `settled`, `unsettled` or `unknown`, whatever it is asked; an `Error` makes the question fail. */
  settlement(nonce: string, answer: AuthorizationSettlement | Error): void {
    this.answers.set(nonce.toLowerCase(), answer);
  }

  /**
   * Spends the nonce on this transfer, as the chain would. The answer then depends on what is asked: `settled` if the
   * transfer paid at least `value` to `to`, `unsettled` if it was any other transfer (a payer who sends 1 unit to
   * themselves with the nonce of the real payment, say).
   */
  consumed(nonce: string, transfer: Transfer): void {
    this.transfers.set(nonce.toLowerCase(), transfer);
  }

  async authorizationSettled(input: SettlementQuery): Promise<AuthorizationSettlement> {
    this.settlementQueries.push(input);
    const nonce = input.authorization.nonce.toLowerCase();
    const answer = this.answers.get(nonce);
    if (answer instanceof Error) throw answer;
    if (answer !== undefined) return answer;
    const transfer = this.transfers.get(nonce);
    if (transfer !== undefined) {
      return transfer.to.toLowerCase() === input.to.toLowerCase() && transfer.value >= input.value ? 'settled' : 'unsettled';
    }
    return this.fallback;
  }
}
