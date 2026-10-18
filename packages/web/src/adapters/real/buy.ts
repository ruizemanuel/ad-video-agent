// buy on Celo, through @celo/buy-core (pinned to an exact version: it is beta, and its API lives only in its .d.ts).
// The VM is paid with x402 from the agent's spend wallet, and a paid request goes out once, whatever comes back. The
// chain is read with viem on CELO_RPC_URL, which may carry a key: no error from it leaves this file, and neither the
// key nor the URL is kept where printing the adapter would show it.
import { authorizationSettlement, isBuyError, x402, type PaymentRequirements, type SettlementReader } from '@celo/buy-core';
import { createPublicClient, decodeEventLog, erc20Abi, http, parseAbi, type Address, type Hex, type Log, type Transport } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { celo } from 'viem/chains';
import { TOKENS } from '../../payments/tokens';
import { VM_URL } from '../../payments/vm-payment';
import type { AuthorizationSettlement, BuyPort, RentVmInput, RentVmResult, SignedVmPayment, VmPaymentOutcome, VmPoll } from '../../ports';

/** A GET to buy's tracking URL is free; this is how long it may take. */
export const POLL_TIMEOUT_MS = 10_000;

const EIP3009 = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)',
]);
const AUTHORIZATION_CANCELED = EIP3009[2];

export type CeloBuySettings = {
  /** SPEND_WALLET_PRIVATE_KEY: the agent's wallet, which pays buy. */
  spendKey: Hex;
  /** CELO_RPC_URL. */
  rpcUrl: string;
  /** For tests: buy's side of the wire (fetch) and the chain's (a viem transport). */
  fetch?: typeof fetch;
  transport?: Transport;
};

const chainClient = (transport: Transport) => createPublicClient({ chain: celo, transport });
type ChainClient = ReturnType<typeof chainClient>;

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/** A buy error's stable code, or the start of any other error's message. */
const reasonOf = (error: unknown): string =>
  isBuyError(error) ? error.code : (error instanceof Error ? error.message : String(error)).slice(0, 200);

const field = (body: unknown, name: string): string | undefined => {
  const value = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : undefined;
  return typeof value === 'string' ? value : undefined;
};

async function readJson(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text());
  } catch {
    return undefined;
  }
}

/** The event a log is, when it is one of the token's EIP-3009 events. */
function eventOf(log: Pick<Log, 'data' | 'topics'>) {
  try {
    return decodeEventLog({ abi: EIP3009, data: log.data, topics: log.topics, strict: true });
  } catch {
    return undefined;
  }
}

export class CeloBuy implements BuyPort {
  // Private (#) so that printing the adapter shows none of them: the account is made from the key only when a payment
  // is signed, and the client keeps the RPC URL.
  readonly #account: () => Promise<ReturnType<typeof privateKeyToAccount>>;
  readonly #chain: ChainClient;
  readonly #fetch: typeof fetch;

  constructor(settings: CeloBuySettings) {
    const { spendKey } = settings;
    this.#account = async () => privateKeyToAccount(spendKey);
    this.#chain = chainClient(settings.transport ?? http(settings.rpcUrl));
    this.#fetch = settings.fetch ?? ((input, init) => fetch(input, init));
  }

  async rentVm({ body, maxAtomic, beforePayment, onPayment }: RentVmInput): Promise<RentVmResult> {
    let quote: PaymentRequirements | undefined;
    // Set once the payment is on its way, and the authorization written down.
    let signed: SignedVmPayment | undefined;
    let answered: x402.OnPaymentInfo | undefined;

    // payingFetch signs the payment and sends it in one go. Its requests come through here, which is where the signed
    // authorization can be seen and handed to `beforePayment` before it leaves.
    const fetchImpl: typeof fetch = async (request, init) => {
      const headers = new Headers(init?.headers);
      const header = headers.get(x402.PAYMENT_HEADER) ?? headers.get(x402.V2_PAYMENT_HEADER);
      if (header !== null) {
        if (quote === undefined) throw new Error('A payment was about to go out without its quote.');
        const payment = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as x402.PaymentPayload;
        const pending: SignedVmPayment = {
          asset: quote.asset,
          amount: BigInt(payment.payload.authorization.value),
          payTo: payment.payload.authorization.to,
          authorization: x402.signedAuthorization(payment),
        };
        // buy-core checks these itself; this is in case a later one does not. Throwing here sends nothing.
        if (pending.amount > maxAtomic) throw new Error('amount-above-cap');
        if (!same(pending.asset, TOKENS.USDT.address)) throw new Error('asset-not-usdt');
        if (!same(pending.payTo, quote.payTo)) throw new Error('payee-not-quoted');
        await beforePayment(pending);
        signed = pending;
      }
      return this.#fetch(request, init);
    };

    let response: Response;
    try {
      response = await x402.payingFetch(
        // USDT only: the wallet holds it, and the costs count it as dollars (6 decimals).
        { account: this.#account, network: 'celo', preferredToken: 'USDT', readBalance: (args) => this.#balance(args.token, args.owner), fetchImpl },
        VM_URL,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          maxAmount: maxAtomic,
          // One payment at most (payingFetch never sends a paid request twice); the free quote may be asked twice.
          maxRetries: 1,
          onBeforePayment: (requirements) => {
            quote = requirements;
          },
          onPayment: (info) => {
            answered = info;
          },
        },
      );
    } catch (error) {
      if (signed === undefined) return { outcome: 'not_paid', reason: reasonOf(error) };
      // The payment went out and no answer came back: it may have settled.
      const { asset, amount, payTo, authorization } = signed;
      await onPayment({ asset, amount, payTo, authorization, outcome: 'ambiguous', timestamp: new Date().toISOString() });
      return { outcome: 'ambiguous', reason: `no answer from buy: ${reasonOf(error)}` };
    }

    const info: x402.OnPaymentInfo | undefined = answered;
    // buy-core calls onPayment only after a paid request. Without `signed`, that request went out some way this adapter
    // does not see (a later buy-core): it may have settled, and what buy-core said of it is all there is to go on.
    const sent: (Omit<SignedVmPayment, 'payTo'> & { payTo?: string }) | undefined =
      signed ?? (info && { asset: info.asset, amount: BigInt(info.amount), payTo: quote?.payTo, authorization: info.authorization });
    if (sent === undefined) {
      await response.body?.cancel().catch(() => undefined);
      return { outcome: 'not_paid', reason: `buy answered ${response.status} without asking for a payment` };
    }
    // Every answer to a payment reaches onPayment but a second 402: buy did not take it, and it may still have settled.
    const outcome: VmPaymentOutcome = signed === undefined ? 'ambiguous' : (info?.outcome ?? 'rejected');
    const reply = await readJson(response);
    // Content-Location first; the body's `poll` only when it is on buy's own origin too.
    const poll = info?.poll ?? x402.followUpUrl(field(reply, 'poll'), VM_URL);
    const txHash = [info?.txHash, field(reply, 'transaction')].find((hash) => hash !== undefined && TX_HASH.test(hash));
    const { asset, amount, payTo, authorization } = sent;
    await onPayment({
      asset,
      amount,
      authorization,
      outcome,
      timestamp: info?.timestamp ?? new Date().toISOString(),
      ...(payTo !== undefined && { payTo }),
      ...(txHash !== undefined && { txHash }),
      ...(poll !== undefined && { poll }),
    });
    if (signed === undefined) return { outcome, reason: `buy answered ${response.status} to a payment sent without the check before it` };
    return outcome === 'confirmed' ? { outcome } : { outcome, reason: `buy answered ${response.status}` };
  }

  async pollVm(url: string): Promise<VmPoll> {
    if (!onVmOrigin(url)) throw new Error("A VM's tracking URL has to be on buy's own origin.");
    const response = await this.#fetch(url, { method: 'GET', signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
    if (response.status === 404) return { gone: true };
    // The message leaves out the URL: whoever holds it can follow the VM.
    if (!response.ok) throw new Error(`buy answered ${response.status} when asked about the VM.`);
    const body = await readJson(response);
    const text = (name: string) => field(body, name) ?? null;
    return { gone: false, vmStatus: text('vmStatus'), scriptStatus: text('scriptStatus'), expiresAt: text('expiresAt') };
  }

  async authorizationSettled(input: Parameters<BuyPort['authorizationSettled']>[0]): Promise<AuthorizationSettlement> {
    try {
      return await this.#settled(input);
    } catch {
      // Anything the chain could not answer. Its errors stay here: viem's name the RPC URL.
      return 'unknown';
    }
  }

  async #settled({ asset, authorization, to, value }: Parameters<BuyPort['authorizationSettled']>[0]): Promise<AuthorizationSettlement> {
    const token = asset as Address;
    const from = authorization.from as Address;
    const nonce = authorization.nonce as Hex;
    const chain = this.#chain;

    // buy-core reads whether the nonce is spent and which transaction spent it with a transfer. What it read is
    // watched, for what it cannot tell: a nonce spent without a transfer.
    const watched: { spent?: boolean; searched?: { fromBlock: bigint; toBlock: bigint } } = {};
    const reader: SettlementReader = {
      readContract: async (args) => (watched.spent = await chain.readContract(args)),
      getBlock: () => chain.getBlock(),
      getLogs: async (args) => {
        const logs = await chain.getLogs(args);
        watched.searched = { fromBlock: args.fromBlock, toBlock: args.toBlock };
        return logs;
      },
    };
    const found = await authorizationSettlement({
      network: 'celo',
      asset: token,
      authorization: { from, nonce, validAfter: authorization.validAfter, validBefore: authorization.validBefore },
      // It looks for the transfer in the hour before the earlier of validBefore and this: so it also finds one made now
      // with an authorization that is valid for a long time yet.
      timestamp: new Date().toISOString(),
      client: reader,
    });
    switch (found.state) {
      // Not spent: not yet, or never (past validBefore).
      case 'pending':
      case 'not_settled':
        return 'unsettled';
      case 'settled':
        return this.#paid(found.txHash, { token, from, nonce, to, value });
      case 'unknown': {
        // Spent, and no transfer with it where buy-core looked. A cancellation there spent it without moving money.
        if (watched.spent !== true || watched.searched === undefined) return 'unknown';
        const cancelled = await chain.getLogs({ address: token, event: AUTHORIZATION_CANCELED, args: { authorizer: from, nonce }, ...watched.searched });
        return cancelled.length > 0 ? 'unsettled' : 'unknown';
      }
    }
  }

  /**
   * Whether the transfer the authorization made in this transaction paid at least `value` of `token` from `from` to
   * `to`. That transfer is the log right after the token's AuthorizationUsed: Celo's USDT emits them in that order (seen
   * on the 17/10 VM payments), as FiatToken's USDC does. Another transfer in the same transaction, even to `to`, is not
   * this authorization's.
   */
  async #paid(hash: Hex, p: { token: Address; from: Address; nonce: Hex; to: string; value: bigint }): Promise<AuthorizationSettlement> {
    const { logs } = await this.#chain.getTransactionReceipt({ hash });
    const at = logs.findIndex((log) => {
      const event = eventOf(log);
      return same(log.address, p.token) && event?.eventName === 'AuthorizationUsed' && same(event.args.authorizer, p.from) && same(event.args.nonce, p.nonce);
    });
    // The node found the log but its receipt does not have it.
    if (at === -1) return 'unknown';
    const next = logs[at + 1];
    const transfer = next === undefined ? undefined : eventOf(next);
    if (next === undefined || transfer?.eventName !== 'Transfer' || !same(next.address, p.token)) return 'unsettled';
    const { from, to, value } = transfer.args;
    return same(from, p.from) && same(to, p.to) && value >= p.value ? 'settled' : 'unsettled';
  }

  #balance(token: Address, owner: Address): Promise<bigint> {
    return this.#chain.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
  }
}

function onVmOrigin(url: string): boolean {
  try {
    const target = new URL(url);
    return target.origin === new URL(VM_URL).origin && target.username === '' && target.password === '';
  } catch {
    return false;
  }
}
