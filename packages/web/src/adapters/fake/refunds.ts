// The RefundPort as a double, for the tests that refund without the chain. It "signs" a transaction that is only the
// request written out (with a random part, as a nonce would be), keeps what it was asked and what it was handed, and
// answers for the chain: a transaction it was handed is mined, one it was not is pending. A test can make it short of
// the token, make a call fail, or say what the chain answers.
import { randomBytes } from 'node:crypto';
import { keccak256, toHex, type Hex } from 'viem';
import { InsufficientBalance, type PreparedRefund, type RefundPort, type RefundReceipt, type RefundRequest } from '../../ports';

export class FakeRefunds implements RefundPort {
  /** How many times `prepare` was asked, whatever came of it. */
  prepareCalls = 0;
  /** What `prepare` was last asked. */
  lastPrepare: RefundRequest | undefined;
  /** What `prepare` last gave back. */
  lastPrepared: PreparedRefund | undefined;
  /** Every raw transaction handed to `broadcast`, in order, even when it then threw. */
  readonly broadcasts: Hex[] = [];
  /** Every hash `receipt` was asked about, in order. */
  readonly receiptQueries: Hex[] = [];

  /** What the wallet holds of every token, in atomic units: a refund of more throws InsufficientBalance. */
  balance = 1_000_000_000n;
  /** Makes `prepare` throw this, as a chain that cannot be read would: nothing is signed. */
  prepareError: Error | undefined;
  /** Makes `broadcast` throw this once it has the bytes, as a node that does not answer: nothing is mined. */
  broadcastError: Error | undefined;
  /** What `receipt` answers (an Error makes it throw); unset, a transaction it was handed is mined, and any other pending. */
  receiptAnswer: RefundReceipt | Error | undefined;

  private readonly mined = new Set<string>();

  async prepare(input: RefundRequest): Promise<PreparedRefund> {
    this.prepareCalls += 1;
    this.lastPrepare = { ...input };
    if (this.prepareError !== undefined) throw this.prepareError;
    if (this.balance < input.amount) throw new InsufficientBalance(input.asset, this.balance, input.amount);
    const rawTx = toHex(JSON.stringify({ to: input.to, asset: input.asset, amount: input.amount.toString(), nonce: randomBytes(8).toString('hex') }));
    const prepared = { hash: keccak256(rawTx), rawTx };
    this.lastPrepared = prepared;
    return prepared;
  }

  async broadcast(rawTx: Hex): Promise<Hex> {
    this.broadcasts.push(rawTx);
    if (this.broadcastError !== undefined) throw this.broadcastError;
    const hash = keccak256(rawTx);
    this.mined.add(hash);
    return hash;
  }

  async receipt(hash: Hex): Promise<RefundReceipt> {
    this.receiptQueries.push(hash);
    const answer = this.receiptAnswer;
    if (answer instanceof Error) throw answer;
    return answer ?? (this.mined.has(hash) ? 'success' : 'pending');
  }
}
