// The BuyPort as a double, for the tests that run the reconciliation and the flow without the chain. It answers what a
// test says about each authorization (by its nonce), and keeps what it was asked, so a test can check that too.
import type { AuthorizationSettlement, BuyPort } from '../../ports';

type SettlementQuery = Parameters<BuyPort['authorizationSettled']>[0];

export class FakeBuy implements BuyPort {
  /** What `authorizationSettled` was asked, in order. */
  readonly settlementQueries: SettlementQuery[] = [];

  /** The answer for an authorization the test said nothing about: the chain could not be asked. */
  fallback: AuthorizationSettlement = 'unknown';

  private readonly settlements = new Map<string, AuthorizationSettlement | Error>();

  /** Makes the authorization with this nonce settled, unsettled or unknown; an `Error` makes the question fail. */
  settlement(nonce: string, answer: AuthorizationSettlement | Error): void {
    this.settlements.set(nonce.toLowerCase(), answer);
  }

  async authorizationSettled(input: SettlementQuery): Promise<AuthorizationSettlement> {
    this.settlementQueries.push(input);
    const answer = this.settlements.get(input.authorization.nonce.toLowerCase()) ?? this.fallback;
    if (answer instanceof Error) throw answer;
    return answer;
  }
}
