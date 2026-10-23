// Paying a quoted order from the person's wallet: which token pays, what the wallet signs, what goes to the service with
// it, and how each answer ends for the person. The wallet is a key made for the run; nothing reaches a chain.
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { getAddress, recoverTypedDataAddress, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { TOKENS } from '../src/payments/tokens';
import { ORDER_FORM } from '../src/site/copy';
import { chooseToken, PaymentNotConfirmed, payOrder } from '../src/site/pay';
import { PAYER_HEADER, type OrderInput } from '../src/site/quote';

const PAYTO = `0x${'d'.repeat(40)}`;
const INPUT: OrderInput = { url: 'https://tiendita.example/', audio: 'music' };

const required = (amount = '50000'): PaymentRequired => ({
  x402Version: 2,
  resource: { url: 'https://ad-video-agent.example/v1/videos', description: 'Ad video package', mimeType: 'application/json' },
  accepts: (['USDT', 'USDC'] as const).map((symbol) => ({
    scheme: 'exact',
    network: 'eip155:42220',
    amount,
    asset: TOKENS[symbol].address,
    payTo: PAYTO,
    maxTimeoutSeconds: 300,
    extra: { ...TOKENS[symbol].extra },
  })),
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

type Sent = { url: string; method?: string; headers: Headers; body: unknown };

function fakeFetch(answer: () => Response | Promise<Response>): { fetcher: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    sent.push({ url: String(input), method: init?.method, headers: new Headers(init?.headers), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    return answer();
  };
  return { fetcher, sent };
}

const AUTHORIZATION = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

type Authorization = { from: Hex; to: Hex; value: string; validAfter: string; validBefore: string; nonce: Hex };

describe('chooseToken', () => {
  it('chooseToken prefers USDT, falls back to USDC, and is null when neither covers', () => {
    expect(chooseToken({ USDT: 50_000n, USDC: 9_000_000n }, 50_000n)).toBe('USDT');
    expect(chooseToken({ USDT: 49_999n, USDC: 50_000n }, 50_000n)).toBe('USDC');
    expect(chooseToken({ USDT: 0n, USDC: 2_000_000n }, 2_000_000n)).toBe('USDC');
    // Neither covers it alone: the service takes one token per payment.
    expect(chooseToken({ USDT: 30_000n, USDC: 30_000n }, 50_000n)).toBeNull();
    expect(chooseToken({ USDT: 0n, USDC: 0n }, 10_000n)).toBeNull();
  });
});

describe('payOrder', () => {
  it('payOrder signs for the chosen token and sends x-payer', async () => {
    const signer = privateKeyToAccount(generatePrivateKey());
    const { fetcher, sent } = fakeFetch(() => json(202, { orderId: 'ord_abc', statusUrl: 'https://ad-video-agent.example/v1/videos/ord_abc' }));

    expect(await payOrder({ input: INPUT, required: required(), token: 'USDC', signer, maxAmountAtomic: 50_000n, fetcher })).toEqual({ ok: true, orderId: 'ord_abc' });

    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request).toMatchObject({ url: '/v1/videos', method: 'POST', body: INPUT });
    expect(request?.headers.get('content-type')).toBe('application/json');
    expect(request?.headers.get(PAYER_HEADER)).toBe(signer.address);

    const payment = decodePaymentSignatureHeader(request?.headers.get('payment-signature') ?? '');
    expect(payment.accepted).toEqual(required().accepts[1]);
    expect(payment.accepted.asset).toBe(TOKENS.USDC.address);
    const { authorization, signature } = payment.payload as { authorization: Authorization; signature: Hex };
    expect(authorization).toMatchObject({ from: signer.address, to: getAddress(PAYTO), value: '50000' });
    // Signed by the wallet, for USDC on Celo.
    const recovered = await recoverTypedDataAddress({
      domain: { ...TOKENS.USDC.extra, chainId: 42220, verifyingContract: TOKENS.USDC.address },
      types: AUTHORIZATION,
      primaryType: 'TransferWithAuthorization',
      message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
      signature,
    });
    expect(recovered).toBe(signer.address);
  });

  it('payOrder returns the reason of a refusal', async () => {
    const signer = privateKeyToAccount(generatePrivateKey());
    const reason = 'The first-video price is no longer available for this wallet. Ask for a new quote.';
    const gone = fakeFetch(() => json(409, { error: 'promo_unavailable', reason }));
    expect(await payOrder({ input: INPUT, required: required('10000'), token: 'USDT', signer, maxAmountAtomic: 10_000n, fetcher: gone.fetcher })).toEqual({ ok: false, reason });

    const invalid = fakeFetch(() => json(400, { error: 'invalid_request', reason: 'url: Invalid URL' }));
    expect(await payOrder({ input: INPUT, required: required(), token: 'USDT', signer, maxAmountAtomic: 50_000n, fetcher: invalid.fetcher })).toEqual({
      ok: false,
      reason: 'url: Invalid URL',
    });

    // A refusal that says no reason of its own: nothing was charged.
    const silent = fakeFetch(() => json(409, { error: 'promo_unavailable' }));
    expect(await payOrder({ input: INPUT, required: required(), token: 'USDT', signer, maxAmountAtomic: 50_000n, fetcher: silent.fetcher })).toEqual({
      ok: false,
      reason: ORDER_FORM.errors.paymentRefused,
    });
  });

  it('payOrder points at the computer’s clock when the payment could not be checked', async () => {
    const signer = privateKeyToAccount(generatePrivateKey());
    const pay = (answer: () => Response) => payOrder({ input: INPUT, required: required(), token: 'USDT', signer, maxAmountAtomic: 50_000n, fetcher: fakeFetch(answer).fetcher });
    const clock = { ok: false, reason: ORDER_FORM.errors.paymentNotChecked };

    // A clock that runs fast signs a payment valid for longer than the offer asks: the service's reason is not for people.
    const tooLong = 'The payment authorization is valid for too long: validBefore must be at most 360 seconds from now.';
    expect(await pay(() => json(400, { error: 'invalid_payment', reason: tooLong }))).toEqual(clock);
    // One that runs slow signs a payment that has already run out: the service turns it down with a plain 402.
    const turnedDown = () => json(402, { precheck: { thinSite: false }, price: { amount: '0.05', assets: ['USDT', 'USDC'] } }, { 'payment-required': encodePaymentRequiredHeader(required()) });
    expect(await pay(turnedDown)).toEqual(clock);
    // A 402 that gives a reason of its own is shown with it.
    expect(await pay(() => json(402, { reason: 'The payment was for another order.' }))).toEqual({ ok: false, reason: 'The payment was for another order.' });

    expect(ORDER_FORM.errors.paymentNotChecked).toBe(
      'Your payment couldn’t be checked. If your computer’s clock isn’t set automatically, set it and try again. Nothing was charged.',
    );
  });

  it('payOrder lands on the order whenever the answer names one, however its payment ended', async () => {
    const signer = privateKeyToAccount(generatePrivateKey());
    // The settlement failed or ended in doubt after the order was made: the order page says how it ends.
    for (const status of [402, 500, 502]) {
      const { fetcher } = fakeFetch(() => json(status, { error: 'settlement_failed', orderId: 'ord_doubt', statusUrl: 'https://ad-video-agent.example/v1/videos/ord_doubt' }));
      expect(await payOrder({ input: INPUT, required: required(), token: 'USDT', signer, maxAmountAtomic: 50_000n, fetcher }), String(status)).toEqual({ ok: true, orderId: 'ord_doubt' });
    }
    // An error with no order named: the payment may have gone, so nothing is said to have been charged or not.
    const unknown = fakeFetch(() => new Response('<h1>Bad Gateway</h1>', { status: 502 }));
    expect(await payOrder({ input: INPUT, required: required(), token: 'USDT', signer, maxAmountAtomic: 50_000n, fetcher: unknown.fetcher })).toEqual({
      ok: false,
      reason: ORDER_FORM.errors.notConfirmed,
      maybeCharged: true,
    });
  });

  it('payOrder takes the order from Content-Location when the body names none', async () => {
    const signer = privateKeyToAccount(generatePrivateKey());
    const id = 'ord_abcdefghijklmnopqrstuvwx';
    const pay = (answer: () => Response) => payOrder({ input: INPUT, required: required(), token: 'USDT', signer, maxAmountAtomic: 50_000n, fetcher: fakeFetch(answer).fetcher });

    // The order was made and paid, and its body was cut short on the way: the header still says where it is.
    const cutShort = () => new Response('{"orderId":"ord_', { status: 202, headers: { 'content-type': 'application/json', 'content-location': `https://ad-video-agent.example/v1/videos/${id}` } });
    expect(await pay(cutShort)).toEqual({ ok: true, orderId: id });
    // As a path of the page's own address, too.
    expect(await pay(() => new Response(null, { status: 202, headers: { 'content-location': `/v1/videos/${id}` } }))).toEqual({ ok: true, orderId: id });

    // The settlement failed or ended in doubt after the order was made, and the body says nothing of it.
    const doubt = () => json(402, { precheck: { thinSite: false } }, { 'payment-required': encodePaymentRequiredHeader(required()), 'content-location': `https://ad-video-agent.example/v1/videos/${id}` });
    expect(await pay(doubt)).toEqual({ ok: true, orderId: id });
    expect(await pay(() => new Response('', { status: 502, headers: { 'content-location': `https://ad-video-agent.example/v1/videos/${id}` } }))).toEqual({ ok: true, orderId: id });
  });

  it('payOrder takes no Content-Location that does not name an order of the service', async () => {
    const signer = privateKeyToAccount(generatePrivateKey());
    const locations = [
      'https://ad-video-agent.example/v1/videos/ord_short',
      'https://ad-video-agent.example/v1/videos/ord_ABCDEFGHIJKLMNOPQRSTUVWX',
      'https://ad-video-agent.example/v1/videos/ord_abcdefghijklmnopqrstuvw1',
      'https://ad-video-agent.example/v1/videos/ord_abcdefghijklmnopqrstuvwx/files',
      'https://ad-video-agent.example/v1/files/ord_abcdefghijklmnopqrstuvwx',
      'https://ad-video-agent.example/v1/videos/',
      'not a location',
    ];
    for (const location of locations) {
      const { fetcher } = fakeFetch(() => new Response(null, { status: 202, headers: { 'content-location': location } }));
      expect(await payOrder({ input: INPUT, required: required(), token: 'USDT', signer, maxAmountAtomic: 50_000n, fetcher }), location).toEqual({
        ok: false,
        reason: ORDER_FORM.errors.notConfirmed,
        maybeCharged: true,
      });
    }
  });

  it('payOrder says the payment may have been charged when the answer names no order and is no refusal', async () => {
    const signer = privateKeyToAccount(generatePrivateKey());
    const answers: [string, () => Response][] = [
      ['a 500 with no body', () => new Response(null, { status: 500 })],
      ['a 503 an error page gave', () => new Response('<h1>Service Unavailable</h1>', { status: 503 })],
      ['a 500 with a reason of its own', () => json(500, { error: 'internal', reason: 'Something broke.' })],
      ['a 202 with no order in it', () => json(202, {})],
      ['a 200 whose body cannot be read', () => new Response('{"orderId":', { status: 200, headers: { 'content-type': 'application/json' } })],
    ];
    for (const [label, answer] of answers) {
      const { fetcher, sent } = fakeFetch(answer);
      expect(await payOrder({ input: INPUT, required: required(), token: 'USDT', signer, maxAmountAtomic: 50_000n, fetcher }), label).toEqual({
        ok: false,
        reason: ORDER_FORM.errors.notConfirmed,
        maybeCharged: true,
      });
      // Sent once, and never again.
      expect(sent, label).toHaveLength(1);
    }
    // The words of it, for a person: look in the wallet first, and do not pay again if the payment is there.
    expect(ORDER_FORM.errors.notConfirmed).toMatch(/check your wallet for a payment to Ad Video Agent before you try again/i);
    expect(ORDER_FORM.errors.notConfirmed).toMatch(/if it’s there, your video is being made/i);
    expect(ORDER_FORM.errors.notConfirmed).toMatch(/don’t pay again/i);
  });

  it('payOrder says plainly that nothing was charged when the service has made all the videos it can today', async () => {
    const signer = privateKeyToAccount(generatePrivateKey());
    // The service says so before it looks at the payment: a refusal, not a payment in doubt.
    const reason = 'We have made all the videos we can for today. Try again after the time in Retry-After. Nothing was charged.';
    const { fetcher } = fakeFetch(() => json(503, { error: 'at_capacity', reason }, { 'retry-after': '7200' }));
    expect(await payOrder({ input: INPUT, required: required(), token: 'USDT', signer, maxAmountAtomic: 50_000n, fetcher })).toEqual({
      ok: false,
      reason: ORDER_FORM.errors.atCapacity,
    });
  });

  it('payOrder sends nothing when the wallet does not sign', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const rejection = Object.assign(new Error('User rejected the request.'), { code: 4001 });
    const signer = { address: account.address, signTypedData: () => Promise.reject(rejection) };
    const { fetcher, sent } = fakeFetch(() => json(202, { orderId: 'ord_never' }));
    await expect(payOrder({ input: INPUT, required: required(), token: 'USDT', signer, maxAmountAtomic: 50_000n, fetcher })).rejects.toBe(rejection);
    expect(sent).toEqual([]);
  });

  it('payOrder says the payment is not confirmed when its answer never comes back', async () => {
    const signer = privateKeyToAccount(generatePrivateKey());
    const { fetcher, sent } = fakeFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(payOrder({ input: INPUT, required: required(), token: 'USDT', signer, maxAmountAtomic: 50_000n, fetcher })).rejects.toBeInstanceOf(PaymentNotConfirmed);
    // Sent once, and never again.
    expect(sent).toHaveLength(1);
  });

  it('payOrder refuses to sign above the cap it is given', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    let asked = 0;
    const signer = { address: account.address, signTypedData: (typed: Parameters<typeof account.signTypedData>[0]) => ((asked += 1), account.signTypedData(typed)) };
    const { fetcher, sent } = fakeFetch(() => json(202, { orderId: 'ord_dear' }));
    // The button said 0.01; the quote asks 0.05, in either token.
    for (const token of ['USDT', 'USDC'] as const) {
      await expect(payOrder({ input: INPUT, required: required('50000'), token, signer, maxAmountAtomic: 10_000n, fetcher }), token).rejects.toThrow();
    }
    expect(asked).toBe(0);
    expect(sent).toEqual([]);

    // Up to the cap, it signs.
    expect(await payOrder({ input: INPUT, required: required('10000'), token: 'USDT', signer, maxAmountAtomic: 10_000n, fetcher })).toEqual({ ok: true, orderId: 'ord_dear' });
    expect(asked).toBe(1);
  });

  it('payOrder pays the opening price, 2 USDT or USDC, through its spend controls', async () => {
    const signer = privateKeyToAccount(generatePrivateKey());
    // Above x402's own default of $1 a payment, which the page lifts for the chosen token only.
    for (const token of ['USDT', 'USDC'] as const) {
      const { fetcher, sent } = fakeFetch(() => json(202, { orderId: 'ord_opening' }));
      expect(await payOrder({ input: INPUT, required: required('2000000'), token, signer, maxAmountAtomic: 2_000_000n, fetcher }), token).toEqual({ ok: true, orderId: 'ord_opening' });
      expect(sent, token).toHaveLength(1);
      const payment = decodePaymentSignatureHeader(sent[0]?.headers.get('payment-signature') ?? '');
      expect(payment.accepted, token).toMatchObject({ asset: TOKENS[token].address, amount: '2000000' });
      expect((payment.payload as { authorization: Authorization }).authorization.value, token).toBe('2000000');
    }
  });

  it('payOrder never signs for more than the page asks a wallet to pay, whatever cap it is given', async () => {
    const signer = privateKeyToAccount(generatePrivateKey());
    const { fetcher, sent } = fakeFetch(() => json(202, { orderId: 'ord_dear' }));
    // 1000 USDT: no price the page shows comes near it, even with a cap that would allow it.
    await expect(payOrder({ input: INPUT, required: required('1000000000'), token: 'USDT', signer, maxAmountAtomic: 2_000_000_000n, fetcher })).rejects.toThrow();
    expect(sent).toEqual([]);
  });
});
