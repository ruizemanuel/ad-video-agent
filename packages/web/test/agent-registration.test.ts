import { describe, expect, it } from 'vitest';
import { agentRegistration } from '../src/agent/registration';

const BASE = 'https://ad-video-agent.example.com';

// Everything the file says, in the order it says it: a registration file is read by other agents and by explorers.
const withoutId = {
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
  name: 'Ad Video Agent',
  description:
    "Turns a website URL into a vertical video ad built from the site's real product and its own claims, with the source of every claim. Paid per order over x402 in USDT or USDC on Celo; an order it cannot deliver is refunded automatically.",
  services: [
    { name: 'web', endpoint: BASE },
    { name: 'x402', endpoint: `${BASE}/v1/videos` },
  ],
  x402Support: true,
  active: true,
  registrations: [] as unknown[],
  supportedTrust: ['reputation'],
};

describe('agentRegistration', () => {
  it('describes the agent with no registration while there is no agent id', () => {
    const file = agentRegistration({ PUBLIC_BASE_URL: BASE, AGENT_ID: undefined });
    expect(JSON.stringify(file)).toBe(JSON.stringify(withoutId));
  });

  it('lists the registration, with the id as a JSON number, once the agent has an id', () => {
    const file = agentRegistration({ PUBLIC_BASE_URL: BASE, AGENT_ID: 42n });
    expect(JSON.stringify(file)).toBe(
      JSON.stringify({
        ...withoutId,
        registrations: [{ agentId: 42, agentRegistry: 'eip155:42220:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' }],
      }),
    );
    expect(JSON.stringify(file)).toContain('"agentId":42,');
  });

  it('joins its URLs to the base without a double slash, whatever the base ends with', () => {
    for (const base of [BASE, `${BASE}/`, `${BASE}///`]) {
      const { services } = agentRegistration({ PUBLIC_BASE_URL: base, AGENT_ID: undefined });
      expect(services).toEqual([
        { name: 'web', endpoint: BASE },
        { name: 'x402', endpoint: `${BASE}/v1/videos` },
      ]);
    }
  });

  it('writes the largest id a JSON number holds exactly', () => {
    const file = agentRegistration({ PUBLIC_BASE_URL: BASE, AGENT_ID: BigInt(Number.MAX_SAFE_INTEGER) });
    expect(JSON.stringify(file)).toContain('"agentId":9007199254740991,');
  });

  it('throws instead of writing an id a JSON number would round', () => {
    expect(() => agentRegistration({ PUBLIC_BASE_URL: BASE, AGENT_ID: BigInt(Number.MAX_SAFE_INTEGER) + 1n })).toThrow(RangeError);
    expect(() => agentRegistration({ PUBLIC_BASE_URL: BASE, AGENT_ID: BigInt(Number.MAX_SAFE_INTEGER) + 1n })).toThrow('AGENT_ID');
  });
});
