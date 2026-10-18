// The RefundPort as a double, for the tests that refund without the chain. It keeps a small chain of its own: each
// wallet's nonce, and the transactions mined with it, one block each. It "signs" a transaction that is only the request
// written out with the wallet that signs and the nonce it takes (the next one that wallet has not used, as a real
// wallet's pending nonce while nothing waits) and a random part. A transaction handed to it is mined when its nonce is its
// wallet's next one; one whose nonce was already used is taken without a word, as a node answers "nonce too low", and is
// never mined. A test can make it short of the token, make a call fail, say what the chain answers, hold the safe head
// back, spend a nonce outside the refunds, or change the wallet's key (`wallet`).
import { randomBytes } from 'node:crypto';
import { hexToString, keccak256, toHex, type Hex } from 'viem';
import { InsufficientBalance, type PreparedRefund, type RefundPort, type RefundReceipt, type RefundRequest } from '../../ports';

/** What the double's signed bytes say. */
type FakeTransaction = { from: string; to: string; asset: string; amount: string; nonce: number; salt: string };

const read = (rawTx: Hex): FakeTransaction => JSON.parse(hexToString(rawTx)) as FakeTransaction;

export class FakeRefunds implements RefundPort {
  /** The refunds' wallet now: a test changes it as a new REFUND_WALLET_PRIVATE_KEY would. */
  wallet = `0x${'a1'.repeat(20)}`;

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
  /** Every nonce `nonceUsed` was asked about, in order: a refund being judged dead. */
  readonly nonceQueries: number[] = [];

  /** What the wallet holds of every token, in atomic units: a refund of more throws InsufficientBalance. */
  balance = 1_000_000_000n;
  /** Makes `prepare` throw this (a chain that cannot be read, a gas fee out of bounds): nothing is signed. */
  prepareError: Error | undefined;
  /** Makes `broadcast` throw this once it has the bytes, as a node that does not answer: nothing is mined. */
  broadcastError: Error | undefined;
  /** What `receipt` answers (an Error makes it throw); unset, what its chain says. A node behind answers 'pending'. */
  receiptAnswer: RefundReceipt | Error | undefined;
  /** Makes `nonceUsed` and `minedSafely` throw this, as a chain that cannot be read. */
  lookupError: Error | undefined;
  /** How many blocks the safe head is behind the latest one. */
  safeBehind = 0;

  /** How many of each wallet's nonces were used: its next transaction takes this one. */
  private readonly used = new Map<string, number>();
  /** The latest block. */
  private head = 0;
  /** Each mined transaction, by hash: its block and who sent it. */
  private readonly mined = new Map<string, { block: number; from: string }>();

  private usedBy(wallet: string): number {
    return this.used.get(wallet) ?? 0;
  }

  /** A transaction of the refunds' wallet that is not one of the refunds (a person using the wallet by hand). */
  spendNonceElsewhere(): void {
    this.used.set(this.wallet, this.usedBy(this.wallet) + 1);
    this.head += 1;
  }

  async prepare(input: RefundRequest): Promise<PreparedRefund> {
    this.prepareCalls += 1;
    this.lastPrepare = { ...input };
    if (this.prepareError !== undefined) throw this.prepareError;
    if (this.balance < input.amount) throw new InsufficientBalance(input.asset, this.balance, input.amount);
    const tx: FakeTransaction = {
      from: this.wallet,
      to: input.to,
      asset: input.asset,
      amount: input.amount.toString(),
      nonce: this.usedBy(this.wallet),
      salt: randomBytes(8).toString('hex'),
    };
    const rawTx = toHex(JSON.stringify(tx));
    const prepared = { hash: keccak256(rawTx), rawTx, nonce: tx.nonce, from: tx.from };
    this.lastPrepared = prepared;
    return prepared;
  }

  async broadcast(rawTx: Hex): Promise<Hex> {
    this.broadcasts.push(rawTx);
    if (this.broadcastError !== undefined) throw this.broadcastError;
    const hash = keccak256(rawTx);
    const { from, nonce } = read(rawTx);
    if (nonce === this.usedBy(from) && !this.mined.has(hash)) {
      this.head += 1;
      this.mined.set(hash, { block: this.head, from });
      this.used.set(from, nonce + 1);
    }
    return hash;
  }

  async receipt(hash: Hex): Promise<RefundReceipt> {
    this.receiptQueries.push(hash);
    const answer = this.receiptAnswer;
    if (answer instanceof Error) throw answer;
    return answer ?? (this.mined.has(hash) ? 'success' : 'pending');
  }

  async nonceUsed(nonce: number): Promise<boolean> {
    this.nonceQueries.push(nonce);
    if (this.lookupError !== undefined) throw this.lookupError;
    return nonce < this.usedBy(this.wallet);
  }

  async minedSafely(hash: Hex): Promise<boolean> {
    if (this.lookupError !== undefined) throw this.lookupError;
    const tx = this.mined.get(hash);
    return tx !== undefined && tx.from === this.wallet && tx.block <= this.head - this.safeBehind;
  }
}
