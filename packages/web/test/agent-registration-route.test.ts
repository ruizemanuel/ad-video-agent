import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentRegistration } from '../src/agent/registration';

const BASE = 'https://ad-video-agent.example.com';
const URL_PATH = '/.well-known/agent-registration.json';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** The route with the settings the service would read from its environment; env() keeps what it first reads, so each test starts afresh. */
async function route(settings: Record<string, string> = {}) {
  const stubs = {
    AD_AGENT_ADAPTERS: 'fake',
    PAYTO_ADDRESS: `0x${'1'.repeat(40)}`,
    LINK_SIGNING_SECRET: 's'.repeat(40),
    CRON_SECRET: 'c'.repeat(40),
    PUBLIC_BASE_URL: BASE,
    ...settings,
  };
  for (const [name, value] of Object.entries(stubs)) vi.stubEnv(name, value);
  return import('../src/app/.well-known/agent-registration.json/route');
}

describe('GET /.well-known/agent-registration.json', () => {
  it('answers 200 with the registration file, readable by any agent or explorer and cached for five minutes', async () => {
    const { GET } = await route();
    const res = await GET(new Request(`${BASE}${URL_PATH}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(agentRegistration({ PUBLIC_BASE_URL: BASE, AGENT_ID: undefined }))));
  });

  it('lists the registration once AGENT_ID is set', async () => {
    const { GET } = await route({ AGENT_ID: '7' });
    const file = (await (await GET(new Request(`${BASE}${URL_PATH}`))).json()) as { registrations: unknown[] };
    expect(file.registrations).toEqual([{ agentId: 7, agentRegistry: 'eip155:42220:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' }]);
  });

  it('uses the address it was asked at where PUBLIC_BASE_URL is not set, as the other routes do in local runs', async () => {
    const { GET } = await route({ PUBLIC_BASE_URL: '' });
    const file = (await (await GET(new Request(`http://localhost:3000${URL_PATH}`))).json()) as { services: { endpoint: string }[] };
    expect(file.services.map((service) => service.endpoint)).toEqual(['http://localhost:3000', 'http://localhost:3000/v1/videos']);
  });

  it('answers GET only', async () => {
    const handlers = await route();
    expect(Object.keys(handlers)).toEqual(['GET']);
  });
});
