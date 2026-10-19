// The BuyPort as a double, for the tests that run the reconciliation and the flow without buy or the chain. It answers
// what a test says about each authorization (by its nonce), and keeps what it was asked, so a test can check that too.
// What renting a VM does, and what the chain says about an authorization nobody spoke of, come from FAKE_SCENARIO (JSON
// such as {"buy":"ambiguous","settled":"unsettled"}), read at each call so a test can change it between runs.
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AuthorizationSettlement, BuyPort, RentVmInput, RentVmResult, SignedVmPayment, VmPoll, VmRequest } from '../../ports';

type SettlementQuery = Parameters<BuyPort['authorizationSettled']>[0];

/** The transfer that spent a nonce on chain. */
export type Transfer = { to: string; value: bigint };

// What the real buy quoted on 17/10: 67011 atomic units of Celo's USDT, to its wallet.
const FAKE_VM_QUOTE = 67_011n;
const USDT = '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e';
const FAKE_BUY_PAY_TO = '0x20faAca5F980E29639A0FCC6dcA6988E18ed333B';
/** The wallet the fake signs as. */
const FAKE_SPEND_WALLET = `0x${'fa'.repeat(20)}`;
const VALID_SECONDS = 300;

// Other keys of FAKE_SCENARIO belong to other doubles, and are let through.
const BuyScenario = z.object({
  /** `paid` (the default): buy serves the VM. `ambiguous`: the payment goes out and no clear answer comes back. `rejected`: buy refuses before anything is paid. */
  buy: z.enum(['paid', 'ambiguous', 'rejected']).optional(),
  /** What the chain says about an authorization the test said nothing about. */
  settled: z.enum(['settled', 'unsettled', 'pending', 'unknown']).optional(),
});

function scenario(): z.infer<typeof BuyScenario> {
  const raw = process.env.FAKE_SCENARIO;
  if (raw === undefined || raw === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('FAKE_SCENARIO has to be JSON, such as {"buy":"ambiguous","settled":"unsettled"}.');
  }
  const result = BuyScenario.safeParse(parsed);
  if (!result.success) throw new Error(`FAKE_SCENARIO says something buy cannot do: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return result.data;
}

export class FakeBuy implements BuyPort {
  /** What `authorizationSettled` was asked, in order. */
  readonly settlementQueries: SettlementQuery[] = [];
  /** Every VM it was asked to rent, in order, paid or not. */
  readonly vmRentals: VmRequest[] = [];

  /** The answer for an authorization the test (and FAKE_SCENARIO) said nothing about: the chain could not be asked. */
  fallback: AuthorizationSettlement = 'unknown';

  private readonly answers = new Map<string, AuthorizationSettlement | Error>();
  private readonly transfers = new Map<string, Transfer>();
  private readonly rented = new Set<string>();

  /** Makes the authorization with this nonce answer `settled`, `pending`, `unsettled` or `unknown`, whatever it is asked; an `Error` makes the question fail. */
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
    return scenario().settled ?? this.fallback;
  }

  /** As the real one does: a dearer quote than `maxAtomic` is refused, and the hooks run in the same order. */
  async rentVm({ body, maxAtomic, beforePayment, onPayment }: RentVmInput): Promise<RentVmResult> {
    const behaviour = scenario().buy ?? 'paid';
    this.vmRentals.push(body);
    if (behaviour === 'rejected') return { outcome: 'not_paid', reason: 'buy refused the VM (FAKE_SCENARIO)' };
    if (FAKE_VM_QUOTE > maxAtomic) return { outcome: 'not_paid', reason: 'amount_exceeds_max' };

    const payment: SignedVmPayment = {
      asset: USDT,
      amount: FAKE_VM_QUOTE,
      payTo: FAKE_BUY_PAY_TO,
      authorization: {
        from: FAKE_SPEND_WALLET,
        nonce: `0x${randomBytes(32).toString('hex')}`,
        validAfter: '0',
        validBefore: String(Math.floor(Date.now() / 1000) + VALID_SECONDS),
      },
    };
    try {
      await beforePayment(payment);
    } catch (error) {
      return { outcome: 'not_paid', reason: error instanceof Error ? error.message : String(error) };
    }
    const { asset, amount, payTo, authorization } = payment;
    const timestamp = new Date().toISOString();
    if (behaviour === 'ambiguous') {
      await onPayment({ asset, amount, payTo, authorization, outcome: 'ambiguous', timestamp });
      return { outcome: 'ambiguous', reason: 'buy answered 502 (FAKE_SCENARIO)' };
    }
    // Paid: the chain has the transfer to buy, and buy knows the VM.
    this.consumed(authorization.nonce, { to: FAKE_BUY_PAY_TO, value: amount });
    const poll = `https://usebuy.ai/google/vm/fake-${authorization.nonce.slice(2, 18)}`;
    this.rented.add(poll);
    await onPayment({ asset, amount, payTo, authorization, outcome: 'confirmed', timestamp, poll, txHash: `0x${randomBytes(32).toString('hex')}` });
    return { outcome: 'confirmed' };
  }

  /** A VM it rented runs; any other is gone. */
  async pollVm(url: string): Promise<VmPoll> {
    if (!this.rented.has(url)) return { gone: true };
    return { gone: false, vmStatus: 'RUNNING', scriptStatus: 'running', expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() };
  }
}
