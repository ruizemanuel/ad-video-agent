// A browser wallet for the page's tests, which a person's wallet extension stands for: an EIP-1193 provider put in the
// page before any script of it runs, announced by EIP-6963 and as window.ethereum. The page holds only that shell; what
// the wallet answers is worked out here, in the test's process, which the shell reaches through a function the test
// exposes to the page (see launchPage in app.ts). It signs typed data with a key made for the run, and answers the
// chain's reads (the balances of USDT and USDC above all) from what the test gives it: launchPage answers the page's own
// calls to Celo's node with these same reads.
import { randomUUID } from 'node:crypto';
import {
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  multicall3Abi,
  numberToHex,
  type Address,
  type Hex,
  type TypedDataDefinition,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { tokenSymbol } from '../../../src/payments/tokens';

/** Celo mainnet, the chain the wallet starts on unless a test says otherwise. */
export const CELO_CHAIN_ID = 42_220;
/** Ethereum mainnet, which the wallet knows from the start, as a real one does. */
const ETHEREUM_CHAIN_ID = 1;
/** Multicall3, at the address it has on every chain: viem (and wagmi) read several contracts at once through it. */
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
/** The block every read is answered at. */
const BLOCK_NUMBER = 50_000_000n;

export type WalletOptions = {
  /** The chain the wallet is on when the page opens: Celo (42220) when left out. */
  chainId?: number;
  /** What the wallet holds of each token, in atomic units: none when left out. */
  balances?: { USDT?: bigint; USDC?: bigint };
  /** The person turns down every request to sign. */
  rejectSignature?: boolean;
};

export type StubWallet = {
  /** The wallet's address, checksummed: that of a key made for this page. */
  readonly address: Address;
  /** How many times the page asked it to sign, whatever the person answered. */
  signatureRequests(): number;
  /** From now on the person turns down every request to sign (true), or signs (false). */
  setRejectSignature(reject: boolean): void;
};

/** The EIP-1193 provider the page sees, for typing the code a test runs in the page. */
export type Eip1193Provider = {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on(event: string, listener: (data: unknown) => void): Eip1193Provider;
  removeListener(event: string, listener: (data: unknown) => void): Eip1193Provider;
};

/** What a request gets: its result and the events the wallet emits with it, or an EIP-1193 (or JSON-RPC) error. */
export type RpcAnswer = { result: unknown; events?: { event: string; data: unknown }[] } | { error: { code: number; message: string } };

const hexChain = (chainId: number): Hex => numberToHex(chainId);
const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const userRejected = { error: { code: 4001, message: 'User rejected the request.' } } as const;

/** A method nobody taught the stub yet: it says so in the test's output, and answers with an error. */
function notAnswered(what: string, code = -32601): RpcAnswer {
  console.warn(`[stub-wallet] no answer for ${what}: teach it in test/browser/support/wallet.ts`);
  return { error: { code, message: `The stub wallet does not answer ${what}.` } };
}

/**
 * The answers to the reads of Celo's state, for the wallet and for Celo's node alike: the chain id, the block number, no
 * CELO, and `balanceOf` on USDT and USDC (`owner` holds `balances`, anyone else nothing), on its own or in a Multicall3
 * `aggregate3`. Anything else is an error, logged.
 */
export function chainReads(owner: Address, balances: WalletOptions['balances'] = {}): (method: string, params: unknown) => RpcAnswer {
  const call = (to: string, data: Hex): RpcAnswer => {
    try {
      const symbol = tokenSymbol(to);
      if (sameAddress(to, MULTICALL3)) {
        const { functionName, args } = decodeFunctionData({ abi: multicall3Abi, data });
        if (functionName === 'aggregate3') {
          const results = args[0].map(({ target, callData }) => {
            const answer = call(target, callData);
            return 'result' in answer ? { success: true, returnData: answer.result as Hex } : { success: false, returnData: '0x' as Hex };
          });
          return { result: encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: results }) };
        }
      } else if (symbol !== undefined) {
        const decoded = decodeFunctionData({ abi: erc20Abi, data });
        if (decoded.functionName === 'balanceOf') {
          const held = sameAddress(decoded.args[0], owner) ? (balances[symbol] ?? 0n) : 0n;
          return { result: encodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', result: held }) };
        }
      }
    } catch {
      // Data that is no call of these contracts: not answered, as any other call.
    }
    return notAnswered(`eth_call to ${to} of ${data.slice(0, 10)}`, -32000);
  };

  return (method, params) => {
    switch (method) {
      case 'eth_chainId':
        return { result: hexChain(CELO_CHAIN_ID) };
      case 'net_version':
        return { result: String(CELO_CHAIN_ID) };
      case 'eth_blockNumber':
        return { result: numberToHex(BLOCK_NUMBER) };
      case 'eth_getBalance':
        return { result: '0x0' };
      case 'eth_call': {
        const [request] = params as [{ to?: string; data?: Hex; input?: Hex }];
        const data = request.data ?? request.input;
        if (request.to === undefined || data === undefined) return notAnswered('eth_call with no contract or no data', -32602);
        return call(request.to, data);
      }
      default:
        return notAnswered(method);
    }
  };
}

/**
 * A wallet for one page: a new key, the chain it starts on, the chains it knows (Ethereum and that one), and whether the
 * page has connected to it. `answer` is what the page's requests get; `read` answers the chain's reads, as `answer` does
 * for every method that is not the wallet's own.
 */
export function stubWallet(options: WalletOptions = {}): { wallet: StubWallet; answer(method: string, params: unknown): Promise<RpcAnswer>; read(method: string, params: unknown): RpcAnswer } {
  const account = privateKeyToAccount(generatePrivateKey());
  const read = chainReads(account.address, options.balances);
  let chainId = options.chainId ?? CELO_CHAIN_ID;
  const known = new Set([ETHEREUM_CHAIN_ID, chainId]);
  let connected = false;
  let signatureRequests = 0;
  let rejectSignature = options.rejectSignature === true;

  const switchTo = (next: number): RpcAnswer => {
    if (next === chainId) return { result: null };
    chainId = next;
    return { result: null, events: [{ event: 'chainChanged', data: hexChain(next) }] };
  };

  const answerOrThrow = async (method: string, params: unknown): Promise<RpcAnswer> => {
    const list = Array.isArray(params) ? (params as unknown[]) : [];
    switch (method) {
      case 'eth_requestAccounts':
        connected = true;
        return { result: [account.address] };
      case 'wallet_requestPermissions':
        // As MetaMask answers it (wagmi asks it first when it connects): the person picks the account, which the page
        // may read from then on.
        connected = true;
        return { result: [{ parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: [account.address] }] }] };
      case 'eth_accounts':
        return { result: connected ? [account.address] : [] };
      case 'eth_chainId':
        return { result: hexChain(chainId) };
      case 'wallet_switchEthereumChain': {
        const next = Number((list[0] as { chainId: string }).chainId);
        if (!known.has(next)) return { error: { code: 4902, message: `Unrecognized chain ID "${hexChain(next)}". Try adding the chain using wallet_addEthereumChain first.` } };
        return switchTo(next);
      }
      case 'wallet_addEthereumChain': {
        // As MetaMask does, the wallet moves to the chain it has just added.
        const next = Number((list[0] as { chainId: string }).chainId);
        known.add(next);
        return switchTo(next);
      }
      case 'eth_signTypedData_v4': {
        signatureRequests += 1;
        if (rejectSignature) return userRejected;
        const [signer, raw] = list as [string, unknown];
        if (!sameAddress(signer, account.address)) return { error: { code: 4100, message: 'The requested account has not been authorized by the user.' } };
        // The typed data comes as JSON, with its numbers as text: viem reads them back as numbers.
        const typed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as TypedDataDefinition;
        return { result: await account.signTypedData(typed) };
      }
      default:
        return read(method, params);
    }
  };
  // What the page sends that the wallet cannot make sense of is an internal error, as a real wallet answers it.
  const answer = (method: string, params: unknown): Promise<RpcAnswer> =>
    answerOrThrow(method, params).catch((error: unknown) => ({ error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }));

  const wallet: StubWallet = {
    address: account.address,
    signatureRequests: () => signatureRequests,
    setRejectSignature: (reject) => {
      rejectSignature = reject;
    },
  };
  return { wallet, answer, read };
}

/**
 * The wallet in the page: runs there, before any script of the page, so it is sent as source and uses nothing from
 * here. Each request goes to `binding`, the function the test exposed, and comes back as its result, or as an error with
 * an EIP-1193 code; the events that come with it are emitted before the request resolves. It is announced by EIP-6963
 * (and again on each `eip6963:requestProvider`) and set as window.ethereum.
 */
export function inPageWallet(binding: string, info: { uuid: string; name: string; rdns: string; icon: string }): void {
  type Answer = { result: unknown; events?: { event: string; data: unknown }[] } | { error: { code: number; message: string } };
  const page = window as unknown as Record<string, unknown>;
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const provider = {
    async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
      const answer = await (page[binding] as (method: string, params: unknown) => Promise<Answer>)(method, params ?? []);
      if ('error' in answer) throw Object.assign(new Error(answer.error.message), { code: answer.error.code });
      for (const { event, data } of answer.events ?? []) for (const listener of listeners.get(event) ?? []) listener(data);
      return answer.result;
    },
    on(event: string, listener: (data: unknown) => void) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return provider;
    },
    removeListener(event: string, listener: (data: unknown) => void) {
      listeners.get(event)?.delete(listener);
      return provider;
    },
  };
  page.ethereum = provider;
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
}

/** What the page learns of a wallet by EIP-6963: a uuid of its own, a name, a reverse domain and an icon. */
export const walletInfo = (): { uuid: string; name: string; rdns: string; icon: string } => ({
  uuid: randomUUID(),
  name: 'Stub Wallet',
  rdns: 'test.stub-wallet',
  icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'><rect width='1' height='1'/></svg>",
});
