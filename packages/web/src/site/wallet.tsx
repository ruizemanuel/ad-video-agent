'use client';
// The person's browser wallet, through wagmi: Celo only, any wallet the browser has (each one that announces itself by
// EIP-6963, and window.ethereum for one that does not), and Celo's public node for every read. What the order form asks
// of the wallet lives here: connect it, move it to Celo, read what it holds of USDT and USDC, and sign as it.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ClientEvmSigner } from '@x402/evm';
import { useState, type ReactNode } from 'react';
import { erc20Abi, type Address } from 'viem';
import { celo } from 'viem/chains';
import { createConfig, http, WagmiProvider, type Config } from 'wagmi';
import { connect, getConnection, getConnectors, readContracts, signTypedData, switchChain } from 'wagmi/actions';
import { injected } from 'wagmi/connectors/injected';
import { TOKENS, type TokenSymbol } from '../payments/tokens';

/** Celo's public node: the page reads the chain from it, never through the wallet. */
export const CELO_RPC = 'https://forno.celo.org';

/** wagmi's connector for window.ethereum, the one wagmi names "injected"; the rest are the wallets found by EIP-6963. */
const WINDOW_ETHEREUM = 'injected';

const walletConfig = (): Config =>
  createConfig({
    chains: [celo],
    connectors: [injected()],
    transports: { [celo.id]: http(CELO_RPC) },
  });

/**
 * wagmi and react-query, for the order form only: the rest of the page knows nothing of a wallet. Each mount makes its
 * own, and only in the browser (the form is not rendered on the server).
 */
export function WalletProviders({ children }: { children: ReactNode }) {
  const [config] = useState(walletConfig);
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}

/**
 * The address of the connected wallet, asking the person to connect one when none is: the first wallet the browser
 * announced by EIP-6963, else window.ethereum. It throws wagmi's ProviderNotFoundError when the browser has no wallet,
 * and the wallet's own error when the person turns it down.
 */
export async function connectWallet(config: Config): Promise<Address> {
  const current = getConnection(config);
  if (current.isConnected && current.address !== undefined) return current.address;
  const connectors = getConnectors(config);
  const connector = connectors.find((candidate) => candidate.id !== WINDOW_ETHEREUM) ?? connectors[0];
  if (connector === undefined) throw new Error('wagmi has no connector.');
  const { accounts } = await connect(config, { connector });
  const [address] = accounts;
  if (address === undefined) throw new Error('The wallet connected with no account.');
  return address;
}

/** Whether the connected wallet is on Celo. */
export const onCelo = (config: Config): boolean => getConnection(config).chainId === celo.id;

/** Moves the connected wallet to Celo when it is on another chain; wagmi adds Celo to the wallet if it does not have it. */
export async function switchToCelo(config: Config): Promise<void> {
  if (!onCelo(config)) await switchChain(config, { chainId: celo.id });
}

/** What `owner` holds of each token, read from Celo's node in one call. */
export async function tokenBalances(config: Config, owner: Address): Promise<Record<TokenSymbol, bigint>> {
  const balanceOf = (symbol: TokenSymbol) => ({ chainId: celo.id, address: TOKENS[symbol].address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }) as const;
  const [USDT, USDC] = await readContracts(config, { allowFailure: false, contracts: [balanceOf('USDT'), balanceOf('USDC')] });
  return { USDT, USDC };
}

type TypedData = Parameters<ClientEvmSigner['signTypedData']>[0];

/** The connected wallet as the signer of a payment: it signs typed data as `address`, asking the person each time. */
export function walletSigner(config: Config, address: Address): ClientEvmSigner {
  return {
    address,
    // x402 hands over the typed data as plain records; the wallet gets it as it is.
    signTypedData: (typed: TypedData) => signTypedData(config, { account: address, ...typed } as Parameters<typeof signTypedData>[1]),
  };
}
