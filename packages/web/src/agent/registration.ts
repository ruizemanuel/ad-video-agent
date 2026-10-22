// The agent's ERC-8004 registration file. `register(agentURI)` on the Identity Registry points at it, and it is served at
// /.well-known/agent-registration.json, the path the EIP uses to verify an endpoint's domain, so one file is both the
// agentURI and the proof. The agent id is known only once the registration is mined: it then goes in AGENT_ID and the
// same URL starts listing it, with no second transaction.
import type { Env } from '../env';

/** The Identity Registry on Celo mainnet, as the EIP names a registry: `eip155:<chain id>:<address>`. */
const IDENTITY_REGISTRY = 'eip155:42220:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

export type AgentRegistration = {
  type: string;
  name: string;
  description: string;
  services: { name: string; endpoint: string }[];
  x402Support: boolean;
  active: boolean;
  registrations: { agentId: number; agentRegistry: string }[];
  supportedTrust: string[];
};

/**
 * The registration file, key by key in the order the EIP's example gives. `agentId` is a JSON number: an id from this
 * registry is small, and one a number would round is refused instead of written wrong. No `image` yet: the product has
 * no logo.
 */
export function agentRegistration(settings: Pick<Env, 'AGENT_ID'> & { PUBLIC_BASE_URL: string }): AgentRegistration {
  const base = settings.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const id = settings.AGENT_ID;
  if (id !== undefined && id > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('AGENT_ID is too large to be written as a JSON number without rounding it.');
  }
  return {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: 'Ad Video Agent',
    description:
      "Turns a website URL into a vertical video ad built from the site's real product and its own claims, with the source of every claim. Paid per order over x402 in USDT or USDC on Celo; an order it cannot deliver is refunded automatically.",
    services: [
      { name: 'web', endpoint: base },
      { name: 'x402', endpoint: `${base}/v1/videos` },
    ],
    x402Support: true,
    active: true,
    registrations: id === undefined ? [] : [{ agentId: Number(id), agentRegistry: IDENTITY_REGISTRY }],
    supportedTrust: ['reputation'],
  };
}
