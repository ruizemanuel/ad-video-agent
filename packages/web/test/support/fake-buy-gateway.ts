// buy's VM endpoint (POST https://usebuy.ai/google/vm) without the network, as a `fetch`. A request without a payment
// gets the x402 v1 402 that usebuy.ai quoted on 17/10 (USDT and USDC, 67011 atomic units, to buy's wallet); a request
// with one has its EIP-3009 signature checked as a facilitator would, and is then answered by `paid`. When it has a
// chain, a valid payment is settled on it before the answer, as the real gateway settles before it serves.
import { recoverTypedDataAddress, type Address, type Hex } from 'viem';
import type { FakeChain } from './fake-chain';

export const BUY_VM_URL = 'https://usebuy.ai/google/vm';
/** The wallet buy's quote names (the one the 17/10 payments went to). */
export const BUY_PAY_TO: Address = '0x20faAca5F980E29639A0FCC6dcA6988E18ed333B';
export const USDT: Address = '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e';
export const USDC: Address = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C';

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** What the paying request carried in X-PAYMENT, once decoded. */
export type SentPayment = {
  x402Version: number;
  scheme: string;
  network: string;
  payload: { signature: Hex; authorization: { from: Address; to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex } };
};

const offer = (asset: Address, amount: number, extra: { name: string; version: string }) => ({
  scheme: 'exact',
  network: 'celo',
  maxAmountRequired: String(amount),
  resource: BUY_VM_URL,
  description: 'Google Cloud VM through buy',
  mimeType: 'application/json',
  payTo: BUY_PAY_TO,
  maxTimeoutSeconds: 300,
  asset,
  extra,
});

const DOMAINS: Record<string, { name: string; version: string }> = {
  [USDT.toLowerCase()]: { name: 'Tether USD', version: '1' },
  [USDC.toLowerCase()]: { name: 'USDC', version: '2' },
};

/** The answer to a valid payment that buy served: the VM, its transaction and where to follow it. */
export const servedVm = (payment: SentPayment, id = 'abc'): Response => {
  const poll = `${BUY_VM_URL}/${id}`;
  return json(
    200,
    { transaction: `0x${'6d'.repeat(32)}`, token: 'USDT', asset: USDT, instance: `cpay-${id}`, zone: 'us-west1-a', machineType: 'e2-medium', spot: false, expiresAt: '2026-10-18T15:57:42.345Z', poll },
    { 'Content-Location': poll, 'X-PAYMENT-RESPONSE': Buffer.from(JSON.stringify({ success: true, transaction: `0x${'6d'.repeat(32)}`, network: 'celo', payer: payment.payload.authorization.from })).toString('base64') },
  );
};

export class FakeBuyGateway {
  /** What the VM costs, in atomic units of either token. */
  quote = 67_011;
  /** How a valid payment is answered. It may throw, as a connection that drops after the payment went out. */
  paid: (payment: SentPayment) => Response | Promise<Response> = (payment) => servedVm(payment);
  /** Whether a valid payment is settled on the chain (when there is one) before `paid` answers. */
  settles = true;
  /** Every request that reached the gateway, paid or not. */
  calls = 0;
  /** The requests that carried a payment, valid or not. */
  paidCalls = 0;
  /** The bodies of every request, parsed. */
  readonly bodies: unknown[] = [];
  /** The payments that arrived, decoded. */
  readonly payments: SentPayment[] = [];

  constructor(private readonly chain?: FakeChain) {}

  /** Forgets the requests seen so far; the settings stay. */
  reset(): void {
    this.calls = 0;
    this.paidCalls = 0;
    this.bodies.length = 0;
    this.payments.length = 0;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    this.calls += 1;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== BUY_VM_URL || init?.method !== 'POST') return json(404, { error: 'not found' });
    const headers = new Headers(init.headers);
    if (headers.get('content-type') !== 'application/json') return json(415, { error: 'unsupported media type' });
    this.bodies.push(JSON.parse(String(init.body)));

    const header = headers.get('X-PAYMENT');
    if (header === null) {
      return json(402, {
        x402Version: 1,
        // USDC first, as usebuy.ai lists it: the service has to pick USDT itself.
        accepts: [offer(USDC, this.quote, DOMAINS[USDC.toLowerCase()]!), offer(USDT, this.quote, DOMAINS[USDT.toLowerCase()]!)],
        error: '',
      });
    }
    this.paidCalls += 1;
    const payment = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as SentPayment;
    this.payments.push(payment);
    if (!(await this.valid(payment))) return json(402, { x402Version: 1, accepts: [], error: 'invalid payment' });
    if (this.settles && this.chain !== undefined) {
      const { from, to, value, nonce } = payment.payload.authorization;
      this.chain.settle({ token: USDT, from, to, value: BigInt(value), nonce });
    }
    return this.paid(payment);
  };

  /** What a facilitator checks: the price, the payee, and that the payer signed exactly this for USDT on Celo. */
  private async valid(payment: SentPayment): Promise<boolean> {
    const { signature, authorization } = payment.payload;
    if (payment.x402Version !== 1 || payment.scheme !== 'exact' || payment.network !== 'celo') return false;
    if (authorization.value !== String(this.quote) || authorization.to.toLowerCase() !== BUY_PAY_TO.toLowerCase()) return false;
    const signer = await recoverTypedDataAddress({
      domain: { ...DOMAINS[USDT.toLowerCase()]!, chainId: 42220, verifyingContract: USDT },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
      signature,
    });
    return signer.toLowerCase() === authorization.from.toLowerCase();
  }
}

/** A gateway; with a chain, the payments it takes are settled on it. */
export const fakeBuyGateway = (chain?: FakeChain): FakeBuyGateway => new FakeBuyGateway(chain);
