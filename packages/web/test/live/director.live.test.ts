// Opt-in (`pnpm --filter @app/web test:live`): the real director, through the AI Gateway, on the shop of the core tests.
// One call to Opus, about US$ 0.15 on the card. It needs the gateway's credentials in the environment: VERCEL_OIDC_TOKEN
// (from `vercel env pull`) or AI_GATEWAY_API_KEY. It never runs in `pnpm test` or in CI.
import { describe, expect, it } from 'vitest';
import { EdlSchema, validateEdl } from '@app/core';
import { GatewayLlm } from '../../src/adapters/real/llm';
import { siteShop } from '../support/shop';

describe('the director, live', () => {
  it('writes an edit list for the shop that fits the EDL schema', async () => {
    if (!process.env.VERCEL_OIDC_TOKEN && !process.env.AI_GATEWAY_API_KEY) {
      throw new Error('The live tests need the AI Gateway credentials: VERCEL_OIDC_TOKEN (vercel env pull) or AI_GATEWAY_API_KEY.');
    }
    const site = siteShop();
    const { edl, usd } = await new GatewayLlm().writeEdl({ site, images: [] });
    expect(EdlSchema.parse(edl)).toEqual(edl);
    expect(usd).toBeGreaterThan(0);
    // For whoever runs it: what the code checks would send to the corrector (rules and places only, not the copy).
    const problems = validateEdl(edl, site).map((p) => `${p.rule} at ${p.where}`);
    console.info(`director: US$ ${usd.toFixed(4)}, ${edl.hooks.length} hooks, ${edl.body.length} body scenes, problems: ${problems.join('; ') || 'none'}`);
  });
});
