// A Celo node that never leaves the test: the JSON-RPC calls the buy adapter makes (a token's authorizationState and
// balanceOf, the latest block, logs and receipts) answered from the transactions a test mines into it. It is plugged
// in as a viem `custom` transport, so the adapter's viem client is the real one and only the wire is fake.
import {
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  numberToHex,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from 'viem';

const abi = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)',
]);

/** One event a transaction emitted: the contract that emitted it, its topics and its data. */
export type ChainLog = { address: Address; topics: Hex[]; data: Hex };

export const transferLog = (token: Address, from: Address, to: Address, value: bigint): ChainLog => ({
  address: token,
  topics: encodeEventTopics({ abi, eventName: 'Transfer', args: { from, to } }) as Hex[],
  data: encodeAbiParameters([{ type: 'uint256' }], [value]),
});

export const authorizationUsedLog = (token: Address, authorizer: Address, nonce: Hex): ChainLog => ({
  address: token,
  topics: encodeEventTopics({ abi, eventName: 'AuthorizationUsed', args: { authorizer, nonce } }) as Hex[],
  data: '0x',
});

export const authorizationCanceledLog = (token: Address, authorizer: Address, nonce: Hex): ChainLog => ({
  address: token,
  topics: encodeEventTopics({ abi, eventName: 'AuthorizationCanceled', args: { authorizer, nonce } }) as Hex[],
  data: '0x',
});

type Mined = { hash: Hex; block: bigint; logs: ChainLog[] };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A topic filter position: null takes anything, a value must be equal, a list takes any of its values. */
const topicMatches = (filter: Hex | Hex[] | null | undefined, topic: Hex | undefined) =>
  filter === null || filter === undefined || (topic !== undefined && (Array.isArray(filter) ? filter.some((f) => same(f, topic)) : same(filter, topic)));

export class FakeChain {
  /** The latest block. Its timestamp starts at the real time: the tests that move the clock move this too. */
  head = { number: 80_000_000n, timestamp: BigInt(Math.floor(Date.now() / 1000)) };
  /** Every call fails, as a node that does not answer would; the error names a URL with a key in it, as viem's do. */
  down = false;
  /** Only receipts fail: the node found the transaction's log but cannot hand over its receipt. */
  receiptsDown = false;
  /** What `balanceOf` answers for every token and owner. */
  balance = 1_000_000_000n;
  /** The JSON-RPC methods asked, in order. */
  readonly methods: string[] = [];

  private readonly mined: Mined[] = [];

  readonly transport = custom({ request: ({ method, params }) => this.request(method, params as unknown[]) });

  /** A transaction in `block` (the head, unless the test says otherwise) that left these logs, in this order. */
  mine(logs: ChainLog[], block = this.head.number): Hex {
    const hash = keccak256(toHex(`tx-${this.mined.length}-${Math.random()}`));
    this.mined.push({ hash, block, logs });
    return hash;
  }

  /** What transferWithAuthorization leaves: AuthorizationUsed, then the Transfer it authorized (as Celo's USDT does). */
  settle(p: { token: Address; from: Address; to: Address; value: bigint; nonce: Hex }, block?: bigint): Hex {
    return this.mine([authorizationUsedLog(p.token, p.from, p.nonce), transferLog(p.token, p.from, p.to, p.value)], block);
  }

  /** What cancelAuthorization leaves: the nonce is spent and no money moves. */
  cancel(p: { token: Address; from: Address; nonce: Hex }, block?: bigint): Hex {
    return this.mine([authorizationCanceledLog(p.token, p.from, p.nonce)], block);
  }

  private async request(method: string, params: unknown[]): Promise<unknown> {
    this.methods.push(method);
    if (this.down) throw new Error('HTTP request failed. URL: https://celo-mainnet.example/v1/secret-rpc-key');
    switch (method) {
      case 'eth_chainId':
        return numberToHex(42220);
      case 'eth_blockNumber':
        return numberToHex(this.head.number);
      case 'eth_getBlockByNumber':
        return { number: numberToHex(this.head.number), timestamp: numberToHex(this.head.timestamp), hash: keccak256(numberToHex(this.head.number)), transactions: [] };
      case 'eth_call':
        return this.call(params[0] as { to: Address; data: Hex });
      case 'eth_getLogs':
        return this.logs(params[0] as { address?: Address | Address[]; topics?: (Hex | Hex[] | null)[]; fromBlock: Hex; toBlock: Hex });
      case 'eth_getTransactionReceipt':
        return this.receipt(params[0] as Hex);
      default:
        throw new Error(`The fake chain does not answer ${method}.`);
    }
  }

  private call({ to, data }: { to: Address; data: Hex }): Hex {
    const call = decodeFunctionData({ abi, data });
    if (call.functionName === 'balanceOf') return encodeFunctionResult({ abi, functionName: 'balanceOf', result: this.balance });
    const [authorizer, nonce] = call.args;
    // A token marks a nonce spent when an authorization with it transfers, and when one is cancelled.
    const used = authorizationUsedLog(to, authorizer, nonce).topics;
    const canceled = authorizationCanceledLog(to, authorizer, nonce).topics;
    const isEither = (log: ChainLog) =>
      same(log.address, to) && [used, canceled].some((topics) => topics.every((topic, i) => same(topic, log.topics[i] ?? '0x')));
    const spent = this.mined.some(({ logs }) => logs.some(isEither));
    return encodeFunctionResult({ abi, functionName: 'authorizationState', result: spent });
  }

  /** Every log of a mined transaction, in the shape a node answers with. */
  private rpcLogs({ hash, block, logs }: Mined) {
    return logs.map((log, index) => ({
      ...log,
      blockNumber: numberToHex(block),
      blockHash: keccak256(numberToHex(block)),
      transactionHash: hash,
      transactionIndex: '0x0',
      logIndex: numberToHex(index),
      removed: false,
    }));
  }

  private logs(filter: { address?: Address | Address[]; topics?: (Hex | Hex[] | null)[]; fromBlock: Hex; toBlock: Hex }) {
    const from = BigInt(filter.fromBlock);
    const to = BigInt(filter.toBlock);
    // As a node does: a range that ends before it starts is an error, not an empty answer.
    if (from > to) throw new Error('invalid block range params');
    const addresses = filter.address === undefined ? undefined : [filter.address].flat();
    return this.mined
      .filter(({ block }) => block >= from && block <= to)
      .flatMap((tx) => this.rpcLogs(tx))
      .filter((log) => addresses === undefined || addresses.some((a) => same(a, log.address)))
      .filter((log) => (filter.topics ?? []).every((topic, i) => topicMatches(topic, log.topics[i])));
  }

  private receipt(hash: Hex) {
    if (this.receiptsDown) throw new Error('HTTP request failed. URL: https://celo-mainnet.example/v1/secret-rpc-key');
    const tx = this.mined.find((m) => same(m.hash, hash));
    if (tx === undefined) return null;
    return {
      transactionHash: tx.hash,
      transactionIndex: '0x0',
      blockHash: keccak256(numberToHex(tx.block)),
      blockNumber: numberToHex(tx.block),
      from: `0x${'9'.repeat(40)}`,
      to: tx.logs[0]?.address ?? null,
      cumulativeGasUsed: '0x1',
      gasUsed: '0x1',
      effectiveGasPrice: '0x1',
      contractAddress: null,
      logs: this.rpcLogs(tx),
      logsBloom: `0x${'0'.repeat(512)}`,
      status: '0x1',
      type: '0x2',
    };
  }
}
