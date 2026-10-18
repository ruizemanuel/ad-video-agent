// The refund adapter signs real Celo transactions: a CIP-64 transfer of the paid token back to the payer, with its gas
// paid in that same token through the token's fee-currency adapter, and the ERC-8021 tag when there is one. It runs
// against a node that never leaves the test (a viem `custom` transport), with a random wallet: only the wire is fake.
import { inspect } from 'node:util';
import { fromDataSuffix, toDataSuffix } from '@celo/attribution-tags';
import {
  concat,
  custom,
  decodeFunctionData,
  encodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  fromRlp,
  getAddress,
  keccak256,
  numberToHex,
  recoverAddress,
  sliceHex,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { parseTransaction, serializeTransaction, type TransactionSerializableCIP64 } from 'viem/celo';
import { beforeEach, describe, expect, it } from 'vitest';
import { CeloRefunds, type CeloRefundsSettings } from '../src/adapters/real/refunds';
import { FEE_ADAPTERS, TOKENS } from '../src/payments/tokens';
import { InsufficientBalance } from '../src/ports';

const RPC_URL = 'https://celo-mainnet.example/v1/secret-rpc-key';
const KEY = generatePrivateKey();
const WALLET = privateKeyToAccount(KEY).address;
// Mixed case that is not a checksum, as an order may keep a payer's address.
const PAYER: Address = '0x1234567890AbcdEF1234567890aBcdef12345678';
// The adapters are 18-decimal views of the 6-decimal tokens: a fee priced through them is 10^12 atomic units' worth.
const ADAPTER_SCALE = 10n ** 12n;

/** A Celo node that answers what viem asks to prepare, sign and send a transaction, and keeps what it was asked. */
class FakeNode {
  /** What `balanceOf` answers, for every token and owner. */
  balance = 1_000_000_000n;
  gas = 120_000n;
  /** What eth_gasPrice and eth_maxPriorityFeePerGas answer for a fee currency: in the adapter's units (18 decimals). */
  gasPrice = 10_000_000_000n;
  tip = 1_000_000_000n;
  /** Whether it fills transactions (eth_fillTransaction), as forno does; this is what it quotes then. */
  fill: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | undefined;
  /** Every call fails, with an error that names the URL and its key, as viem's do. */
  down = false;
  /** Only eth_sendRawTransaction fails. */
  sendFails = false;
  /** The mined transactions, by hash. */
  readonly receipts = new Map<string, 'success' | 'reverted'>();
  readonly calls: { method: string; params: unknown[] }[] = [];
  readonly sent: Hex[] = [];

  readonly transport = custom({ request: ({ method, params }) => this.request(method, (params ?? []) as unknown[]) });

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }

  private async request(method: string, params: unknown[]): Promise<unknown> {
    this.calls.push({ method, params });
    if (this.down) throw new Error(`HTTP request failed. URL: ${RPC_URL}`);
    switch (method) {
      case 'eth_chainId':
        return numberToHex(42220);
      case 'eth_call': {
        const { data } = params[0] as { data: Hex };
        decodeFunctionData({ abi: erc20Abi, data });
        return encodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', result: this.balance });
      }
      case 'eth_estimateGas':
        return numberToHex(this.gas);
      case 'eth_fillTransaction':
        return this.filled(params[0] as Record<string, string>);
      case 'eth_getTransactionCount':
        return '0x7';
      case 'eth_getBlockByNumber':
        return { number: '0x4c4b400', hash: `0x${'22'.repeat(32)}`, timestamp: '0x6700', baseFeePerGas: '0x5d21dba00', transactions: [] };
      // Asked without a fee currency, these would price the gas in CELO, which the wallet does not hold.
      case 'eth_gasPrice':
        return this.inFeeCurrency(params, this.gasPrice);
      case 'eth_maxPriorityFeePerGas':
        return this.inFeeCurrency(params, this.tip);
      case 'eth_sendRawTransaction': {
        const raw = params[0] as Hex;
        this.sent.push(raw);
        if (this.sendFails) throw new Error(`HTTP request failed. URL: ${RPC_URL}`);
        return keccak256(raw);
      }
      case 'eth_getTransactionReceipt':
        return this.receipt(params[0] as Hex);
      default:
        throw new Error(`The fake node does not answer ${method}.`);
    }
  }

  private inFeeCurrency(params: unknown[], value: bigint): Hex {
    if (typeof params[0] !== 'string') throw new Error('The gas was priced in CELO, not in the fee currency.');
    return numberToHex(value);
  }

  private filled(request: Record<string, string>) {
    // As a node without the method answers.
    if (this.fill === undefined) throw Object.assign(new Error('the method eth_fillTransaction does not exist/is not available'), { code: -32601 });
    return {
      raw: '0x',
      tx: {
        type: '0x7b',
        chainId: numberToHex(42220),
        from: request.from,
        to: request.to,
        input: request.data ?? request.input,
        value: '0x0',
        nonce: '0x7',
        gas: numberToHex(this.gas),
        maxFeePerGas: numberToHex(this.fill.maxFeePerGas),
        maxPriorityFeePerGas: numberToHex(this.fill.maxPriorityFeePerGas),
        feeCurrency: request.feeCurrency,
      },
    };
  }

  private receipt(hash: Hex) {
    const status = this.receipts.get(hash.toLowerCase());
    if (status === undefined) return null;
    return {
      transactionHash: hash,
      transactionIndex: '0x0',
      blockHash: `0x${'33'.repeat(32)}`,
      blockNumber: '0x4c4b401',
      from: WALLET,
      to: TOKENS.USDT.address,
      cumulativeGasUsed: '0x1',
      gasUsed: '0x1',
      effectiveGasPrice: '0x1',
      contractAddress: null,
      logs: [],
      logsBloom: `0x${'0'.repeat(512)}`,
      status: status === 'success' ? '0x1' : '0x0',
      type: '0x7b',
    };
  }
}

let node: FakeNode;
beforeEach(() => {
  node = new FakeNode();
});

const adapter = (settings: Partial<CeloRefundsSettings> = {}) =>
  new CeloRefunds({ refundKey: KEY, rpcUrl: RPC_URL, transport: node.transport, ...settings });

const transfer = (to: Address, amount: bigint): Hex => encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [getAddress(to), amount] });

/** The signed transaction, which has to be a CIP-64 one. */
function parseCip64(rawTx: Hex): TransactionSerializableCIP64 {
  const tx = parseTransaction(rawTx);
  expect(tx.type).toBe('cip64');
  return tx as TransactionSerializableCIP64;
}

/** Who signed a CIP-64 transaction: viem's parser leaves the signature out, so it is read from the RLP list's end. */
async function signerOf(rawTx: Hex): Promise<Address> {
  const fields = fromRlp(sliceHex(rawTx, 1)) as Hex[];
  const [yParity, r, s] = fields.slice(-3) as [Hex, Hex, Hex];
  const unsigned = serializeTransaction(parseCip64(rawTx));
  return recoverAddress({ hash: keccak256(unsigned), signature: { r, s, yParity: yParity === '0x' ? 0 : 1 } });
}

/** What the signed transaction may cost in gas, in the token's atomic units (6 decimals), rounded up. */
const feeOf = (tx: TransactionSerializableCIP64): bigint => ((tx.gas ?? 0n) * (tx.maxFeePerGas ?? 0n) + ADAPTER_SCALE - 1n) / ADAPTER_SCALE;

const same = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();

describe('the fee-currency adapters', () => {
  it('are the CIP-64 adapters of Celo USDT and USDC', () => {
    expect(FEE_ADAPTERS).toEqual({ USDT: '0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72', USDC: '0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B' });
  });
});

describe('CeloRefunds.prepare', () => {
  it('signs a CIP-64 USDT transfer paying gas in USDT, with the ERC-8021 suffix when configured', async () => {
    const { rawTx } = await adapter({ erc8021Code: 'celo_test' }).prepare({ to: PAYER, asset: TOKENS.USDT.address, amount: 50_000n });
    const tx = parseCip64(rawTx);
    expect(same(tx.to ?? undefined, TOKENS.USDT.address)).toBe(true);
    expect(same(tx.feeCurrency, FEE_ADAPTERS.USDT)).toBe(true);
    expect(tx.chainId).toBe(42220);
    expect(tx.value ?? 0n).toBe(0n);
    expect(fromDataSuffix(tx.data!)).toMatchObject({ codes: ['celo_test'] });
    expect(tx.data).toBe(concat([transfer(PAYER, 50_000n), toDataSuffix('celo_test')]));
  });

  it('leaves the transfer untagged without a code', async () => {
    const { rawTx } = await adapter().prepare({ to: PAYER, asset: TOKENS.USDT.address, amount: 50_000n });
    const tx = parseCip64(rawTx);
    expect(tx.data).toBe(transfer(PAYER, 50_000n));
    expect(fromDataSuffix(tx.data!)).toBeNull();
  });

  it('refunds USDC in USDC, with its gas paid through the USDC adapter', async () => {
    const { rawTx } = await adapter().prepare({ to: PAYER, asset: TOKENS.USDC.address, amount: 5_000_000n });
    const tx = parseCip64(rawTx);
    expect(same(tx.to ?? undefined, TOKENS.USDC.address)).toBe(true);
    expect(same(tx.feeCurrency, FEE_ADAPTERS.USDC)).toBe(true);
    expect(decodeFunctionData({ abi: erc20Abi, data: tx.data! })).toEqual({ functionName: 'transfer', args: [getAddress(PAYER), 5_000_000n] });
  });

  it('takes the token in any case of the hex', async () => {
    const { rawTx } = await adapter().prepare({ to: PAYER, asset: TOKENS.USDT.address.toLowerCase(), amount: 50_000n });
    expect(same(parseCip64(rawTx).feeCurrency, FEE_ADAPTERS.USDT)).toBe(true);
  });

  it('is signed by the refund wallet, and its hash is the one the chain will give it', async () => {
    const { hash, rawTx } = await adapter().prepare({ to: PAYER, asset: TOKENS.USDT.address, amount: 50_000n });
    expect(hash).toBe(keccak256(rawTx));
    expect(await signerOf(rawTx)).toBe(WALLET);
    expect(parseCip64(rawTx).nonce).toBe(7);
  });

  it('estimates the gas and prices it in the fee currency, never in CELO', async () => {
    const { rawTx } = await adapter().prepare({ to: PAYER, asset: TOKENS.USDT.address, amount: 50_000n });
    const tx = parseCip64(rawTx);
    expect(tx.gas).toBe(node.gas);
    // viem's default margin on the base fee: (price - tip) * 1.2 + tip.
    expect(tx.maxFeePerGas).toBe(((node.gasPrice - node.tip) * 12n) / 10n + node.tip);
    expect(tx.maxPriorityFeePerGas).toBe(node.tip);
    const estimate = node.calls.find((call) => call.method === 'eth_estimateGas');
    expect(same((estimate?.params[0] as { feeCurrency?: string }).feeCurrency, FEE_ADAPTERS.USDT)).toBe(true);
    const priced = node.calls.filter((call) => call.method === 'eth_gasPrice' || call.method === 'eth_maxPriorityFeePerGas');
    expect(priced.map((call) => (call.params[0] as string).toLowerCase())).toEqual([FEE_ADAPTERS.USDT.toLowerCase(), FEE_ADAPTERS.USDT.toLowerCase()]);
  });

  it('prices the gas with what the node fills in, as forno does', async () => {
    node.fill = { maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n };
    const { rawTx } = await adapter().prepare({ to: PAYER, asset: TOKENS.USDT.address, amount: 50_000n });
    const tx = parseCip64(rawTx);
    expect(same(tx.feeCurrency, FEE_ADAPTERS.USDT)).toBe(true);
    expect(tx.gas).toBe(node.gas);
    // viem puts its margin on a filled fee cap too.
    expect(tx.maxFeePerGas).toBe(24_000_000_000n);
    expect(node.methods()).not.toContain('eth_gasPrice');
  });

  it('throws InsufficientBalance, before signing, when the wallet holds less than the refund', async () => {
    node.balance = 49_999n;
    const refused = adapter().prepare({ to: PAYER, asset: TOKENS.USDT.address, amount: 50_000n });
    await expect(refused).rejects.toBeInstanceOf(InsufficientBalance);
    await expect(refused).rejects.toMatchObject({ asset: TOKENS.USDT.address, balance: 49_999n, needed: 50_000n });
    expect(node.methods()).not.toContain('eth_estimateGas');
  });

  it('counts the most the gas can cost, in the token and not in its 18-decimal adapter', async () => {
    // What the gas may cost here, from what the node answers: a little over a thousand atomic units, a tenth of a cent.
    const fee = feeOf(parseCip64((await adapter().prepare({ to: PAYER, asset: TOKENS.USDT.address, amount: 50_000n })).rawTx));
    expect(fee).toBeGreaterThan(1_000n);
    expect(fee).toBeLessThan(2_000n);

    node.balance = 50_000n + fee - 1n;
    await expect(adapter().prepare({ to: PAYER, asset: TOKENS.USDT.address, amount: 50_000n })).rejects.toMatchObject({
      name: 'InsufficientBalance',
      balance: 50_000n + fee - 1n,
      needed: 50_000n + fee,
    });
    node.balance = 50_000n + fee;
    expect(await adapter().prepare({ to: PAYER, asset: TOKENS.USDT.address, amount: 50_000n })).toMatchObject({ hash: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
  });

  it('refuses any token but USDT and USDC, the fee adapters included, before anything is asked', async () => {
    for (const asset of [FEE_ADAPTERS.USDT, '0x765DE816845861e75A25fCA122bb6898B8B1282a']) {
      await expect(adapter().prepare({ to: PAYER, asset, amount: 50_000n })).rejects.toThrow('USDT or USDC');
    }
    expect(node.calls).toEqual([]);
  });

  it('refuses an amount that is not positive, and a payee that is not an address', async () => {
    await expect(adapter().prepare({ to: PAYER, asset: TOKENS.USDT.address, amount: 0n })).rejects.toThrow('positive');
    await expect(adapter().prepare({ to: '0x1234', asset: TOKENS.USDT.address, amount: 50_000n })).rejects.toThrow('address');
    expect(node.calls).toEqual([]);
  });

  it('sends nothing', async () => {
    await adapter().prepare({ to: PAYER, asset: TOKENS.USDT.address, amount: 50_000n });
    expect(node.methods()).not.toContain('eth_sendRawTransaction');
  });
});

describe('CeloRefunds.broadcast', () => {
  it('hands the signed bytes to the node once, and gives back their hash', async () => {
    const refunds = adapter();
    const { hash, rawTx } = await refunds.prepare({ to: PAYER, asset: TOKENS.USDT.address, amount: 50_000n });
    expect(await refunds.broadcast(rawTx)).toBe(hash);
    expect(node.sent).toEqual([rawTx]);
  });

  it('does not send them again when the node does not answer', async () => {
    const refunds = adapter();
    const { rawTx } = await refunds.prepare({ to: PAYER, asset: TOKENS.USDT.address, amount: 50_000n });
    node.sendFails = true;
    await expect(refunds.broadcast(rawTx)).rejects.toThrow();
    expect(node.sent).toEqual([rawTx]);
  });
});

describe('CeloRefunds.receipt', () => {
  it('says whether the transaction was mined, and how it went', async () => {
    const refunds = adapter();
    const { hash, rawTx } = await refunds.prepare({ to: PAYER, asset: TOKENS.USDT.address, amount: 50_000n });
    expect(await refunds.receipt(hash)).toBe('pending');
    await refunds.broadcast(rawTx);
    node.receipts.set(hash.toLowerCase(), 'success');
    expect(await refunds.receipt(hash)).toBe('success');
    node.receipts.set(hash.toLowerCase(), 'reverted');
    expect(await refunds.receipt(hash)).toBe('reverted');
  });
});

describe('CeloRefunds keeps its key and the RPC URL to itself', () => {
  it('shows neither when it is printed', () => {
    const printed = inspect(adapter({ transport: undefined, erc8021Code: 'celo_test' }), { depth: 10, showHidden: true });
    expect(printed).not.toContain(KEY.slice(2));
    expect(printed).not.toContain('secret-rpc-key');
  });

  it('leaves the URL out of every error from the chain', async () => {
    const refunds = adapter();
    const { hash, rawTx } = await refunds.prepare({ to: PAYER, asset: TOKENS.USDT.address, amount: 50_000n });
    node.down = true;
    const errors = await Promise.all([
      refunds.prepare({ to: PAYER, asset: TOKENS.USDT.address, amount: 50_000n }).catch((error: unknown) => error),
      refunds.broadcast(rawTx).catch((error: unknown) => error),
      refunds.receipt(hash).catch((error: unknown) => error),
    ]);
    for (const error of errors) {
      expect(error).toBeInstanceOf(Error);
      expect(inspect(error, { depth: 10, showHidden: true })).not.toContain('secret-rpc-key');
      expect(inspect(error, { depth: 10, showHidden: true })).not.toContain(KEY.slice(2));
    }
  });
});
