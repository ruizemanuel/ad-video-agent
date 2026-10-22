// GET /.well-known/agent-registration.json: the agent's ERC-8004 registration file, which the agentURI of the Identity
// Registry points at (see agent/registration.ts). Public, and open to any agent or explorer that wants to read it.
import { agentRegistration } from '../../../agent/registration';
import { env } from '../../../env';
import { serviceBase } from '../../../payments/orders';

// Five minutes, so listing the agent id after it is registered shows up soon.
const HEADERS = { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' };

export function GET(req: Request): Response {
  const settings = env();
  return Response.json(agentRegistration({ AGENT_ID: settings.AGENT_ID, PUBLIC_BASE_URL: serviceBase(settings, req) }), { headers: HEADERS });
}
