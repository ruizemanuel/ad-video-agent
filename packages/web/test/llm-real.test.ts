// The real LlmPort over the AI Gateway, run against the AI SDK's mock model: no network and no money. It checks what each
// call asks which model, what it sends, how it reads the answer and how it counts the cost.
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { judgeItems, type Problem } from '@app/core';
import { GatewayLlm, MODELS } from '../src/adapters/real/llm';
import { DIRECTOR_SYSTEM } from '../src/prompts/director';
import { JUDGE_SYSTEM } from '../src/prompts/judge';
import { PATCH_SYSTEM } from '../src/prompts/patch';
import { CLASSIFY_SYSTEM } from '../src/prompts/classify';
import { ModelOutputInvalid } from '../src/ports';
import { captureShop, edlShop, siteShop } from './support/shop';

type Generated = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
type CallOptions = MockLanguageModelV4['doGenerateCalls'][number];

// An answer of 1000 tokens in and 500 out, `cached` of them read from the cache.
const answer = (text: string, extra: Partial<Generated> = {}, cached = 0): Generated => ({
  content: [{ type: 'text', text }],
  finishReason: { unified: 'stop', raw: undefined },
  usage: {
    inputTokens: { total: 1000, noCache: 1000 - cached, cacheRead: cached, cacheWrite: undefined },
    outputTokens: { total: 500, text: 500, reasoning: undefined },
  },
  warnings: [],
  ...extra,
});
const billed = (cost: string): Partial<Generated> => ({ providerMetadata: { gateway: { cost } } });

// The adapter with every model id resolved to one mock, which records what it was asked.
const adapter = (reply: Generated) => {
  const model = new MockLanguageModelV4({ doGenerate: async () => reply });
  const asked: string[] = [];
  const llm = new GatewayLlm((id) => {
    asked.push(id);
    return model;
  });
  const call = (): CallOptions => {
    const first = model.doGenerateCalls[0];
    if (!first) throw new Error('the model was not called');
    return first;
  };
  return { llm, asked, call };
};

const userParts = (call: CallOptions) => {
  const user = call.prompt.find((m) => m.role === 'user');
  if (!user || typeof user.content === 'string') throw new Error('no user message with parts');
  return user.content;
};
const systemText = (call: CallOptions) => call.prompt.find((m) => m.role === 'system')?.content;

describe('GatewayLlm.writeEdl', () => {
  const input = { site: siteShop(), images: captureShop().directorImages, brief: 'Para emprendedores' };

  it('asks the director model for an edit list, with the director prompt', async () => {
    const { llm, asked, call } = adapter(answer(JSON.stringify(edlShop()), billed('0.18472')));
    await llm.writeEdl(input);
    expect(asked).toEqual([MODELS.director]);
    expect(MODELS.director).toBe('anthropic/claude-opus-5.5');
    expect(systemText(call())).toBe(DIRECTOR_SYSTEM);
    expect(call().responseFormat).toMatchObject({ type: 'json', name: 'edl' });
  });

  it('sends the site and the brief as text, and each phone picture as a JPEG file after its label', async () => {
    const { llm, call } = adapter(answer(JSON.stringify(edlShop())));
    await llm.writeEdl(input);
    const parts = userParts(call());
    expect(parts[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Para emprendedores') });
    expect(parts.slice(1).map((p) => (p.type === 'text' ? p.text : p.mediaType))).toEqual([
      'Screenshot s1-mobile (phone, section s1):',
      'image/jpeg',
      'Screenshot s4-mobile (phone, section s4):',
      'image/jpeg',
    ]);
  });

  it('returns the edit list and what the gateway billed for it', async () => {
    const { llm } = adapter(answer(JSON.stringify(edlShop()), billed('0.18472')));
    expect(await llm.writeEdl(input)).toEqual({ edl: edlShop(), usd: 0.18472 });
  });

  it('prices the call from its tokens when the gateway does not say what it billed', async () => {
    // Opus: US$ 4 per million tokens in, 20 out.
    const { llm } = adapter(answer(JSON.stringify(edlShop())));
    expect((await llm.writeEdl(input)).usd).toBeCloseTo((1000 * 4 + 500 * 20) / 1e6, 9);
  });

  it('prices cached input at a tenth', async () => {
    const { llm } = adapter(answer(JSON.stringify(edlShop()), {}, 800));
    expect((await llm.writeEdl(input)).usd).toBeCloseTo((200 * 4 + 800 * 0.4 + 500 * 20) / 1e6, 9);
  });

  it('throws ModelOutputInvalid, with what the call cost, when the answer is not an edit list', async () => {
    const { llm } = adapter(answer('Here is your ad: "Vendé por WhatsApp"'));
    const failure = await llm.writeEdl(input).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModelOutputInvalid);
    expect((failure as ModelOutputInvalid).usd).toBeCloseTo((1000 * 4 + 500 * 20) / 1e6, 9);
    // What the model wrote can hold the site's text: it stays out of the error.
    expect((failure as Error).message).not.toContain('Vendé');
  });

  it('lets a failure that is not about the answer through as it is', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('The gateway is down.');
      },
    });
    const llm = new GatewayLlm(() => model);
    await expect(llm.writeEdl(input)).rejects.toThrow('The gateway is down.');
  });
});

describe('GatewayLlm.patchEdl', () => {
  const problem: Problem = { where: 'body[1].lines[0]', rule: 'number-mismatch', detail: '"99" is not in the quote of c3' };
  const fix = { patches: [{ path: 'body[1]', scene: edlShop().body[1] }], claimFixes: [edlShop().claims[2]] };

  it('asks the director model with the corrector prompt, the edit list and the problems, and no pictures', async () => {
    const { llm, asked, call } = adapter(answer(JSON.stringify(fix)));
    await llm.patchEdl({ edl: edlShop(), problems: [problem], site: siteShop() });
    expect(asked).toEqual([MODELS.patch]);
    expect(MODELS.patch).toBe(MODELS.director);
    expect(systemText(call())).toBe(PATCH_SYSTEM);
    const parts = userParts(call());
    expect(parts.every((p) => p.type === 'text')).toBe(true);
    expect(parts.map((p) => (p.type === 'text' ? p.text : '')).join('')).toContain('[number-mismatch] body[1].lines[0]');
  });

  it('returns the patched scenes, the corrected claims and the cost', async () => {
    const { llm } = adapter(answer(JSON.stringify(fix), billed('0.031')));
    expect(await llm.patchEdl({ edl: edlShop(), problems: [problem], site: siteShop() })).toEqual({ ...fix, usd: 0.031 });
  });
});

describe('GatewayLlm.judge', () => {
  const items = judgeItems(edlShop());
  const verdicts = {
    verdicts: items.claims.map((c) => ({ id: c.id, equivalent: true, reason: 'Same thing.' })),
    framing: items.framing.map((f) => ({ id: f.id, assertsProductFact: false, reason: 'A question.' })),
  };

  it('asks the judge model with the judge prompt and the items', async () => {
    const { llm, asked, call } = adapter(answer(JSON.stringify(verdicts)));
    await llm.judge(items);
    expect(asked).toEqual([MODELS.judge]);
    expect(MODELS.judge).toBe('anthropic/claude-sonnet-5.5');
    expect(systemText(call())).toBe(JUDGE_SYSTEM);
  });

  it('returns both lists of verdicts and the cost', async () => {
    const { llm } = adapter(answer(JSON.stringify(verdicts), billed('0.0102')));
    expect(await llm.judge(items)).toEqual({ ...verdicts, usd: 0.0102 });
  });
});

describe('GatewayLlm.classifySite', () => {
  const page = { url: 'https://tiendita.example/', title: 'Tiendita', text: 'Vendé por WhatsApp sin comisiones.' };

  it('asks the small model with the classifier prompt', async () => {
    const { llm, asked, call } = adapter(answer(JSON.stringify({ admissible: true, reason: 'An online shop builder.' })));
    await llm.classifySite(page);
    expect(asked).toEqual([MODELS.classify]);
    expect(MODELS.classify).toBe('anthropic/claude-haiku-5.5');
    expect(systemText(call())).toBe(CLASSIFY_SYSTEM);
  });

  it('returns the verdict and the reason', async () => {
    const { llm } = adapter(answer(JSON.stringify({ admissible: false, reason: 'The site sells counterfeit goods.' }), billed('0.0004')));
    expect(await llm.classifySite(page)).toEqual({ admissible: false, reason: 'The site sells counterfeit goods.', usd: 0.0004 });
  });

  it('prices Haiku as Sonnet when the gateway does not say, to stay on the safe side', async () => {
    const { llm } = adapter(answer(JSON.stringify({ admissible: true, reason: 'ok' })));
    expect((await llm.classifySite(page)).usd).toBeCloseTo((1000 * 2 + 500 * 10) / 1e6, 9);
  });
});

// Providers reject some JSON Schema keywords in structured output (bounds, patterns, formats): no call sends them, and
// the answer is still held to the whole zod schema.
describe('GatewayLlm: the schema each call sends', () => {
  const BOUND = /"(exclusiveMinimum|exclusiveMaximum|minimum|maximum|multipleOf|minLength|maxLength|minItems|maxItems|pattern|format)"/;
  const items = judgeItems(edlShop());
  const problem: Problem = { where: 'body[1]', rule: 'structure', detail: 'x' };
  const calls: [string, (llm: GatewayLlm) => Promise<unknown>, unknown][] = [
    ['writeEdl', (llm) => llm.writeEdl({ site: siteShop(), images: [] }), edlShop()],
    ['patchEdl', (llm) => llm.patchEdl({ edl: edlShop(), problems: [problem], site: siteShop() }), { patches: [], claimFixes: [] }],
    ['judge', (llm) => llm.judge(items), { verdicts: [], framing: [] }],
    ['classifySite', (llm) => llm.classifySite({ url: 'https://tiendita.example/', title: 'T', text: 'x' }), { admissible: true, reason: 'ok' }],
  ];

  it.each(calls)('%s sends a schema with no bound keyword', async (_name, run, reply) => {
    const { llm, call } = adapter(answer(JSON.stringify(reply)));
    await run(llm);
    const format = call().responseFormat;
    if (format?.type !== 'json' || format.schema === undefined) throw new Error('no JSON schema was sent');
    expect(JSON.stringify(format.schema)).not.toMatch(BOUND);
  });

  it('keeps the descriptions of the edit list in the schema the director gets', async () => {
    const { llm, call } = adapter(answer(JSON.stringify(edlShop())));
    await llm.writeEdl({ site: siteShop(), images: [] });
    const format = call().responseFormat;
    expect(JSON.stringify(format?.type === 'json' ? format.schema : undefined)).toContain('hooks[0] is the main version');
  });

  it('holds the answer to the whole edit list schema: a bpm of 0 is not an edit list', async () => {
    const { llm } = adapter(answer(JSON.stringify({ ...edlShop(), bpm: 0 }), billed('0.17')));
    const failure = await llm.writeEdl({ site: siteShop(), images: [] }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModelOutputInvalid);
    // The gateway's bill is not in the error the SDK throws: the call is priced from its tokens.
    expect((failure as ModelOutputInvalid).usd).toBeCloseTo((1000 * 4 + 500 * 20) / 1e6, 9);
  });
});
