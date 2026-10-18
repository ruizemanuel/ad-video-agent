// Refunds from the refunds' wallet on Celo, with viem. A refund is an ERC-20 transfer of the paid token back to the
// payer, sent as a CIP-64 transaction that pays its gas in that same token through the token's fee-currency adapter (the
// wallet holds no CELO), with the ERC-8021 tag at the end of its data when there is one. It is signed in one call and
// sent in another, as @celo/buy-core's prepareStablecoinTransfer does, so that its hash is kept before anything leaves.
// The chain is reached on CELO_RPC_URL, which may carry a key: no error from it leaves this file as it came, and neither
// the key nor the URL is kept where printing the adapter would show it.
import { toDataSuffix } from '@celo/attribution-tags';
import {
  BaseError,
  concat,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  isAddress,
  keccak256,
  publicActions,
  TransactionReceiptNotFoundError,
  type Hex,
  type Transport,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseTransaction, type CeloTransactionSerializable } from 'viem/celo';
import { celo } from 'viem/chains';
import { FEE_ADAPTER_DECIMALS, FEE_ADAPTERS, TOKENS, tokenSymbol } from '../../payments/tokens';
import { FeeTooHigh, InsufficientBalance, type PreparedRefund, type RefundPort, type RefundReceipt, type RefundRequest } from '../../ports';

export type CeloRefundsSettings = {
  /** REFUND_WALLET_PRIVATE_KEY: the refunds' wallet. */
  refundKey: Hex;
  /** CELO_RPC_URL. */
  rpcUrl: string;
  /** ERC8021_CODE: when it is set, every refund carries it. */
  erc8021Code?: string;
  /** For tests: the chain's side of the wire (a viem transport). */
  transport?: Transport;
};

/** The most a refund may spend on gas, in the token's atomic units (6 decimals): 0.05. A transfer's gas costs a fraction of a cent. */
export const MAX_REFUND_FEE_ATOMIC = 50_000n;

/**
 * How far behind the head `nonceUsed` reads the wallet's nonce (about 30 s on Celo): far enough that a node a little
 * behind agrees, and near enough that a node without archive state (it keeps about 128 blocks) still has it.
 */
export const NONCE_CHECK_BLOCKS_BACK = 30n;

/**
 * What a node answers when it has these bytes already, or its wallet's nonce is past theirs: the hash says the rest.
 * Whole words only: "unknown transaction type" is a refusal.
 */
const ALREADY_SENT = /\b(?:already known|known transaction|nonce too low)\b/i;

const chainClient = (transport: Transport) => createWalletClient({ chain: celo, transport }).extend(publicActions);
type ChainClient = ReturnType<typeof chainClient>;

const same = (a: string | null | undefined, b: string): boolean => a?.toLowerCase() === b.toLowerCase();

/** What a transaction may cost in gas (gas × its fee cap, priced by an 18-decimal adapter), in the token's units, rounded up. */
function feeInToken(gas: bigint, maxFeePerGas: bigint, decimals: number): bigint {
  const scale = 10n ** BigInt(FEE_ADAPTER_DECIMALS - decimals);
  return (gas * maxFeePerGas + scale - 1n) / scale;
}

const URL_LIKE = /[a-z][a-z0-9+.-]*:\/\/\S*/gi;
// Longer than a hash: a signed transaction, a signature, calldata.
const LONG_HEX = /0x[0-9a-f]{65,}/gi;

/**
 * An error from the chain, made safe to show: viem's messages name the RPC URL, and keep the request and its cause. What
 * is kept is what failed, the kind of error and the node's own reason (which says whether to wait or fix something),
 * with anything that looks like a URL, or like a signed transaction, taken out.
 */
function chainError(what: string, error: unknown): Error {
  const kind = error instanceof Error ? error.name : typeof error;
  const details = error instanceof BaseError ? error.details : undefined;
  const reason = details ? ` ${details.replace(URL_LIKE, '[url]').replace(LONG_HEX, '[data]').slice(0, 200)}` : '';
  return new Error(`The refund's ${what} failed on the chain (${kind}).${reason}`);
}

/** The signed bytes read back. viem's parser puts the whole transaction, signature included, in its errors: they stay here. */
function readBack(rawTx: Hex): CeloTransactionSerializable {
  try {
    // Any serialized transaction may come back from the parser.
    return parseTransaction(rawTx) as CeloTransactionSerializable;
  } catch {
    throw new Error('The signed refund could not be read back.');
  }
}

/**
 * The signed bytes are the transfer that was asked for, with its gas in the token, or they are not given back. Its nonce,
 * which RLP leaves out when it is 0.
 */
function checkedNonce(rawTx: Hex, expected: { token: string; feeCurrency: string; data: Hex }): number {
  const tx = readBack(rawTx);
  const isTransfer =
    tx.type === 'cip64' &&
    tx.chainId === celo.id &&
    same(tx.to, expected.token) &&
    same(tx.feeCurrency, expected.feeCurrency) &&
    same(tx.data, expected.data) &&
    (tx.value ?? 0n) === 0n;
  if (!isTransfer) throw new Error('The signed refund is not the transfer it was asked to be: it was not sent.');
  return tx.nonce ?? 0;
}

export class CeloRefunds implements RefundPort {
  // Private (#) so that printing the adapter shows none of them: the account is made from the key only when a refund is
  // signed, and the transport keeps the RPC URL.
  readonly #account: () => ReturnType<typeof privateKeyToAccount>;
  readonly #transport: Transport;
  readonly #chain: ChainClient;
  readonly #suffix: Hex | undefined;

  constructor(settings: CeloRefundsSettings) {
    const { refundKey, erc8021Code } = settings;
    this.#account = () => privateKeyToAccount(refundKey);
    this.#transport = settings.transport ?? http(settings.rpcUrl);
    this.#chain = chainClient(this.#transport);
    this.#suffix = erc8021Code === undefined ? undefined : toDataSuffix(erc8021Code);
  }

  async prepare({ to, asset, amount }: RefundRequest): Promise<PreparedRefund> {
    const symbol = tokenSymbol(asset);
    if (symbol === undefined) throw new Error('A refund is paid in USDT or USDC on Celo, and this token is neither.');
    if (amount <= 0n) throw new Error('A refund moves a positive amount.');
    if (!isAddress(to, { strict: false })) throw new Error('A refund goes to an address, and this is not one.');
    const token = TOKENS[symbol];
    const feeCurrency = FEE_ADAPTERS[symbol];
    const transfer = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [getAddress(to), amount] });
    const data = this.#suffix === undefined ? transfer : concat([transfer, this.#suffix]);

    const account = this.#account();
    const wallet = createWalletClient({ account, chain: celo, transport: this.#transport }).extend(publicActions);
    let rawTx: Hex;
    try {
      const balance = await wallet.readContract({ address: token.address, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
      if (balance < amount) throw new InsufficientBalance(token.address, balance, amount);
      // The gas first, with no fee fields: with them, some of forno's nodes charge the fee at their upper gas bound while
      // estimating, and refuse a transfer close to the balance (buy-core saw it). That check is made below instead.
      const gas = await wallet.estimateGas({ to: token.address, data, feeCurrency, prepare: false });
      // The fees are priced in the fee currency: forno fills them in (eth_fillTransaction), and a node without that is
      // asked eth_gasPrice for the adapter. The chain's serializer makes a transaction with a feeCurrency a CIP-64 one.
      const request = await wallet.prepareTransactionRequest({ to: token.address, data, feeCurrency, gas, parameters: ['chainId', 'nonce', 'fees'] });
      if (request.gas === undefined || request.maxFeePerGas === undefined) throw new Error('The refund was left without its gas or its fee cap.');
      // The node checks that the token covers the fee, not the fee and the amount: a transfer of nearly all of it would be
      // mined, burn its fee and revert. So the most it can cost is checked here, in the token's units.
      const fee = feeInToken(request.gas, request.maxFeePerGas, token.decimals);
      // A fee cap that high is a node's mistake, or a fee spike a refund can wait out: it is not paid.
      if (fee > MAX_REFUND_FEE_ATOMIC) throw new FeeTooHigh(token.address, fee, MAX_REFUND_FEE_ATOMIC);
      if (balance < amount + fee) throw new InsufficientBalance(token.address, balance, amount + fee);
      rawTx = await wallet.signTransaction(request);
    } catch (error) {
      if (error instanceof InsufficientBalance || error instanceof FeeTooHigh) throw error;
      throw chainError('preparation', error);
    }
    const nonce = checkedNonce(rawTx, { token: token.address, feeCurrency, data });
    // The hash is the keccak of the signed bytes: the node reports the same one.
    return { hash: keccak256(rawTx), rawTx, nonce };
  }

  async broadcast(rawTx: Hex): Promise<Hex> {
    try {
      // viem sends a raw transaction once: it never retries this call.
      return await this.#chain.sendRawTransaction({ serializedTransaction: rawTx });
    } catch (error) {
      // The node has them already, or a transaction with their nonce was mined (these bytes, or others): for `receipt`,
      // and the other refunds with that nonce, to tell; not for this call.
      if (error instanceof BaseError && ALREADY_SENT.test(error.details ?? '')) return keccak256(rawTx);
      throw chainError('broadcast', error);
    }
  }

  async receipt(hash: Hex): Promise<RefundReceipt> {
    try {
      const { status } = await this.#chain.getTransactionReceipt({ hash });
      return status === 'success' ? 'success' : 'reverted';
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) return 'pending';
      throw chainError('receipt', error);
    }
  }

  async nonceUsed(nonce: number): Promise<boolean> {
    try {
      const head = await this.#chain.getBlockNumber();
      const used = await this.#chain.getTransactionCount({
        address: this.#account().address,
        blockNumber: head > NONCE_CHECK_BLOCKS_BACK ? head - NONCE_CHECK_BLOCKS_BACK : 0n,
      });
      return used > nonce;
    } catch (error) {
      throw chainError('nonce check', error);
    }
  }

  async minedSafely(hash: Hex): Promise<boolean> {
    try {
      let mined: { from: string; blockNumber: bigint };
      try {
        mined = await this.#chain.getTransactionReceipt({ hash });
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return false;
        throw error;
      }
      if (!same(mined.from, this.#account().address)) return false;
      // The safe head after the receipt: a node further behind can only make the answer more careful.
      const safe = await this.#chain.getBlock({ blockTag: 'safe' });
      return mined.blockNumber <= safe.number;
    } catch (error) {
      throw chainError('safety check', error);
    }
  }
}
