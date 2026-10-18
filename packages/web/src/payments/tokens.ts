// The tokens the service is paid in and refunds in: Celo's USDT and USDC. Apart from x402.ts, so that what only needs
// their addresses (the buy and refund adapters) does not load the x402 server with them.

/**
 * The tokens the service takes, both with 6 decimals. `extra` is the EIP-712 domain each one signs with: USDT signs
 * as "Tether USD", not as its symbol. Never quote against USDT's fee-currency adapter (0x0E2A…6f72): it answers with
 * the same name and symbol but has 18 decimals, so a price there is off by 10^12.
 */
export const TOKENS = {
  USDT: { address: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e', decimals: 6, extra: { name: 'Tether USD', version: '1' } },
  USDC: { address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', decimals: 6, extra: { name: 'USDC', version: '2' } },
} as const;

export type TokenSymbol = keyof typeof TOKENS;

/**
 * Each token's CIP-64 fee-currency adapter: what a transaction names as its `feeCurrency` to pay its gas in that token
 * (both listed by Celo's FeeCurrencyDirectory, as @celo/buy-core 0.8.3 verified on 25/09). An adapter is an 18-decimal
 * view of its 6-decimal token, so a fee priced through it is in units 10^12 times smaller than the token's. They take
 * gas, never payments.
 */
export const FEE_ADAPTERS = {
  USDT: '0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72',
  USDC: '0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B',
} as const satisfies Record<TokenSymbol, string>;

/** The decimals the fee-currency adapters price gas in. */
export const FEE_ADAPTER_DECIMALS = 18;

/** Which of TOKENS is at this address, whatever the case of the hex; undefined for any other (an adapter included). */
export function tokenSymbol(address: string): TokenSymbol | undefined {
  return (Object.keys(TOKENS) as TokenSymbol[]).find((symbol) => TOKENS[symbol].address.toLowerCase() === address.toLowerCase());
}
