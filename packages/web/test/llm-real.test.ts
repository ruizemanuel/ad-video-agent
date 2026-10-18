// The real LlmPort over the AI Gateway, run against the AI SDK's mock model: no network and no money. It checks what each
// call asks which model, what it sends, how it reads the answer and how it counts the cost.
import { APICallError, RetryError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { judgeItems, type Problem } from '@app/core';
import { GatewayLlm, MODELS } from '../src/adapters/real/llm';
import { DIRECTOR_SYSTEM } from '../src/prompts/director';
import { JUDGE_SYSTEM } from '../src/prompts/judge';
import { PATCH_SYSTEM, patchPrompt } from '../src/prompts/patch';
import { REVIEW_SYSTEM, reviewIntro } from '../src/prompts/review';
import { CLASSIFY_SYSTEM } from '../src/prompts/classify';
import { ModelCallFailed, ModelOutputInvalid } from '../src/ports';
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

  // The SDK's errors carry the whole request (site text, brief, pictures) and the provider's answer: none of it may
  // reach a log or a workflow's record. The error that goes up names the call, the error's kind and its status only.
  describe('a call that fails', () => {
    const failingWith = (error: Error) =>
      new GatewayLlm(
        () =>
          new MockLanguageModelV4({
            doGenerate: async () => {
              throw error;
            },
          }),
      );
    const apiError = (statusCode: number) =>
      new APICallError({
        message: 'Bad request: Vendé por WhatsApp sin comisiones',
        url: 'https://ai-gateway.vercel.sh/v1/ai/language-model',
        requestBodyValues: { prompt: 'Vendé por WhatsApp sin comisiones', brief: 'Para emprendedores' },
        statusCode,
        responseBody: '{"error":"Vendé por WhatsApp sin comisiones"}',
        isRetryable: false,
      });
    const caught = (llm: GatewayLlm): Promise<Error> =>
      llm.writeEdl(input).then(
        () => {
          throw new Error('the call did not fail');
        },
        (error: unknown) => error as Error,
      );
    const clean = (error: Error) => {
      expect(error).toBeInstanceOf(Error);
      expect(APICallError.isInstance(error)).toBe(false);
      expect(RetryError.isInstance(error)).toBe(false);
      expect(error).not.toHaveProperty('requestBodyValues');
      expect(error).not.toHaveProperty('responseBody');
      expect(error).not.toHaveProperty('errors');
      expect(error.cause).toBeUndefined();
      expect(JSON.stringify({ message: error.message, stack: error.stack })).not.toMatch(/Vendé|emprendedores/);
    };

    it('keeps only the status of an API error', async () => {
      const error = await caught(failingWith(apiError(400)));
      clean(error);
      expect(error.message).toBe('The director model call failed (AI_APICallError, HTTP 400).');
    });

    it('keeps only the status of the last try when the SDK gave up retrying', async () => {
      const error = await caught(failingWith(new RetryError({ message: 'Failed after 3 attempts. Last error: Vendé', reason: 'maxRetriesExceeded', errors: [apiError(503), apiError(529)] })));
      clean(error);
      expect(error.message).toBe('The director model call failed (AI_RetryError, HTTP 529).');
    });

    it('is a ModelCallFailed that says the call, the kind of error and the status, for the flow to tell retry from fatal', async () => {
      const api = await caught(failingWith(apiError(400)));
      expect(api).toBeInstanceOf(ModelCallFailed);
      expect(api).toMatchObject({ name: 'ModelCallFailed', call: 'director', kind: 'AI_APICallError', status: 400 });
      const retried = await caught(failingWith(new RetryError({ message: 'x', reason: 'maxRetriesExceeded', errors: [apiError(529)] })));
      expect(retried).toMatchObject({ kind: 'AI_RetryError', status: 529 });
      const other = await caught(failingWith(new TypeError('fetch failed')));
      expect(other).toBeInstanceOf(ModelCallFailed);
      expect(other).toMatchObject({ kind: 'TypeError' });
      expect((other as ModelCallFailed).status).toBeUndefined();
    });

    it('keeps only the name of any other error', async () => {
      const error = await caught(failingWith(new TypeError('fetch failed: Vendé por WhatsApp')));
      clean(error);
      expect(error.message).toBe('The director model call failed (TypeError).');
    });
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
    expect(parts.map((p) => (p.type === 'text' ? p.text : '')).join('')).toBe(patchPrompt({ edl: edlShop(), problems: [problem], site: siteShop() }));
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

describe('GatewayLlm.review', () => {
  const frames = [
    { label: 'Frame 1: hooks[0][0], hook scene, KineticHeadline', jpeg: '/9j/AAAA' },
    { label: 'Frame 2: body[0], body scene, UiFocus', jpeg: '/9j/BBBB' },
  ];
  const input = { frames, siteUrl: 'https://tiendita.example/' };
  const review = {
    frames: [
      { frame: 1, legible: true, cutMidLetter: false, issues: ['weak hook'] },
      { frame: 2, legible: false, cutMidLetter: true, issues: [] },
    ],
    logoSwap: { generic: false, reason: 'The ad leans on the shop builder.' },
  };

  it('asks the visual model with the review prompt', async () => {
    const { llm, asked, call } = adapter(answer(JSON.stringify(review)));
    await llm.review(input);
    expect(asked).toEqual([MODELS.review]);
    expect(MODELS.review).toBe('anthropic/claude-opus-5.5');
    expect(systemText(call())).toBe(REVIEW_SYSTEM);
    expect(call().responseFormat).toMatchObject({ type: 'json', name: 'review' });
  });

  it('sends the site, then each key frame as its label and a JPEG file', async () => {
    const { llm, call } = adapter(answer(JSON.stringify(review)));
    await llm.review(input);
    const parts = userParts(call());
    expect(parts[0]).toEqual({ type: 'text', text: reviewIntro('https://tiendita.example/') });
    expect(parts.slice(1).map((p) => (p.type === 'text' ? p.text : p.mediaType))).toEqual([frames[0]?.label, 'image/jpeg', frames[1]?.label, 'image/jpeg']);
    // The pictures go as they are: base64 JPEG, in the order of the frames.
    expect(parts.flatMap((p) => (p.type === 'file' ? [p.data] : []))).toEqual([
      { type: 'data', data: '/9j/AAAA' },
      { type: 'data', data: '/9j/BBBB' },
    ]);
  });

  it('returns the review and what the gateway billed for it', async () => {
    const { llm } = adapter(answer(JSON.stringify(review), billed('0.2113')));
    expect(await llm.review(input)).toEqual({ review, usd: 0.2113 });
  });

  it('prices the call from its tokens, with the pictures in, when the gateway does not say what it billed', async () => {
    const { llm } = adapter(answer(JSON.stringify(review)));
    expect((await llm.review(input)).usd).toBeCloseTo((1000 * 4 + 500 * 20) / 1e6, 9);
  });

  it('throws ModelOutputInvalid, with what the call cost, when the answer is not a review', async () => {
    const { llm } = adapter(answer('The ad looks great to me.'));
    const failure = await llm.review(input).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModelOutputInvalid);
    expect((failure as ModelOutputInvalid).usd).toBeCloseTo((1000 * 4 + 500 * 20) / 1e6, 9);
    expect((failure as Error).message).not.toContain('looks great');
  });

  it('throws a ModelCallFailed that names the call, and carries nothing of the pictures', async () => {
    const failing = new GatewayLlm(
      () =>
        new MockLanguageModelV4({
          doGenerate: async () => {
            throw new APICallError({ message: 'Bad request /9j/AAAA', url: 'https://ai-gateway.vercel.sh/v1', requestBodyValues: { jpeg: '/9j/AAAA' }, statusCode: 400, isRetryable: false });
          },
        }),
    );
    const failure = await failing.review(input).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModelCallFailed);
    expect(failure).toMatchObject({ call: 'review', kind: 'AI_APICallError', status: 400 });
    expect(JSON.stringify({ message: (failure as Error).message, stack: (failure as Error).stack })).not.toContain('9j');
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
    [
      'review',
      (llm) => llm.review({ frames: [{ label: 'Frame 1: cta', jpeg: '/9j/AAAA' }], siteUrl: 'https://tiendita.example/' }),
      { frames: [], logoSwap: { generic: false, reason: 'ok' } },
    ],
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
