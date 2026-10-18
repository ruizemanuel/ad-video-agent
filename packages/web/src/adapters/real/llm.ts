// The LlmPort over the Vercel AI Gateway, with the AI SDK. A model is named "provider/model" and the gateway signs in
// with the deployment's OIDC token: there is no key here. Every call asks for structured output (generateText with
// Output.object, over a provider-safe schema) and says what it cost: what the gateway billed, or, when it does not say,
// the price of its tokens.
import { EdlSchema } from '@app/core';
import { generateText, NoObjectGeneratedError, NoOutputGeneratedError, Output, type LanguageModel, type LanguageModelUsage, type UserContent } from 'ai';
import type { z } from 'zod';
import { CLASSIFY_OUTPUT, CLASSIFY_SYSTEM, classifyPrompt } from '../../prompts/classify';
import { DIRECTOR_SYSTEM, directorRequest } from '../../prompts/director';
import { JUDGE_OUTPUT, JUDGE_SYSTEM, judgePrompt } from '../../prompts/judge';
import { PATCH_OUTPUT, PATCH_SYSTEM, patchPrompt } from '../../prompts/patch';
import { ModelOutputInvalid, type LlmPort } from '../../ports';
import { modelSchema } from './provider-safe-schema';

/** The AI Gateway's ids of the models each call uses (checked on 17/10/2026). The corrector is the director's model. */
export const MODELS = {
  director: 'anthropic/claude-opus-5.5',
  patch: 'anthropic/claude-opus-5.5',
  judge: 'anthropic/claude-sonnet-5.5',
  classify: 'anthropic/claude-haiku-5.5',
} as const;

type Role = keyof typeof MODELS;
export type ModelId = (typeof MODELS)[Role];

// US$ per million tokens (17/10/2026), for when the gateway does not say what it billed. Haiku is priced as Sonnet, to
// stay on the safe side of the cap. A token read from the cache costs a tenth of an input token.
const PRICES: Record<ModelId, { input: number; output: number }> = {
  'anthropic/claude-opus-5.5': { input: 4, output: 20 },
  'anthropic/claude-sonnet-5.5': { input: 2, output: 10 },
  'anthropic/claude-haiku-5.5': { input: 2, output: 10 },
};
const CACHE_READ_SHARE = 0.1;

const priced = (id: ModelId, usage: LanguageModelUsage | undefined): number => {
  const price = PRICES[id];
  const cached = usage?.inputTokenDetails.cacheReadTokens ?? 0;
  const input = (usage?.inputTokens ?? 0) - cached;
  return (input * price.input + cached * price.input * CACHE_READ_SHARE + (usage?.outputTokens ?? 0) * price.output) / 1e6;
};

// The gateway puts what it billed in `providerMetadata.gateway.cost`, as a string of US$ (e.g. "0.114104").
const billed = (providerMetadata: unknown): number | undefined => {
  const gateway = (providerMetadata as { gateway?: { cost?: unknown } } | undefined)?.gateway;
  const cost = Number(gateway?.cost);
  return Number.isFinite(cost) && cost > 0 ? cost : undefined;
};

type Ask<T> = {
  role: Role;
  instructions: string;
  content: UserContent;
  schema: z.ZodType<T>;
  name: string;
  maxOutputTokens: number;
};

export class GatewayLlm implements LlmPort {
  /** `model` turns a gateway id into the model to call; the tests give a mock. By default the id goes to the gateway. */
  constructor(private readonly model: (id: ModelId) => LanguageModel = (id) => id) {}

  async classifySite(input: Parameters<LlmPort['classifySite']>[0]): ReturnType<LlmPort['classifySite']> {
    const { output, usd } = await this.ask({
      role: 'classify',
      instructions: CLASSIFY_SYSTEM,
      content: classifyPrompt(input),
      schema: CLASSIFY_OUTPUT,
      name: 'classification',
      maxOutputTokens: 400,
    });
    return { ...output, usd };
  }

  async writeEdl(input: Parameters<LlmPort['writeEdl']>[0]): ReturnType<LlmPort['writeEdl']> {
    const request = directorRequest(input);
    const content: UserContent = [
      { type: 'text', text: request.text },
      ...request.images.flatMap(({ label, jpegBase64 }) => [
        { type: 'text' as const, text: label },
        { type: 'file' as const, data: jpegBase64, mediaType: 'image/jpeg' },
      ]),
    ];
    const { output, usd } = await this.ask({
      role: 'director',
      instructions: DIRECTOR_SYSTEM,
      content,
      schema: EdlSchema,
      name: 'edl',
      maxOutputTokens: 12_000,
    });
    return { edl: output, usd };
  }

  async patchEdl(input: Parameters<LlmPort['patchEdl']>[0]): ReturnType<LlmPort['patchEdl']> {
    const { output, usd } = await this.ask({
      role: 'patch',
      instructions: PATCH_SYSTEM,
      content: patchPrompt(input),
      schema: PATCH_OUTPUT,
      name: 'patches',
      maxOutputTokens: 6_000,
    });
    return { ...output, usd };
  }

  async judge(input: Parameters<LlmPort['judge']>[0]): ReturnType<LlmPort['judge']> {
    const { output, usd } = await this.ask({
      role: 'judge',
      instructions: JUDGE_SYSTEM,
      content: judgePrompt(input),
      schema: JUDGE_OUTPUT,
      name: 'verdicts',
      maxOutputTokens: 6_000,
    });
    return { ...output, usd };
  }

  // One call for structured output. An answer that does not fit the schema is a ModelOutputInvalid with what the call
  // cost; its message names the call, never what the model wrote (it can hold the site's text).
  private async ask<T>({ role, instructions, content, schema, name, maxOutputTokens }: Ask<T>): Promise<{ output: T; usd: number }> {
    const id = MODELS[role];
    const invalid = (usd: number) => new ModelOutputInvalid(`The ${role} model did not answer with a valid ${name}.`, usd);
    const result = await generateText({
      model: this.model(id),
      instructions,
      messages: [{ role: 'user', content }],
      // Without the keywords providers reject; the answer is still held to the whole zod schema.
      output: Output.object({ schema: modelSchema(schema), name }),
      maxOutputTokens,
    }).catch((error: unknown) => {
      if (NoObjectGeneratedError.isInstance(error)) throw invalid(priced(id, error.usage));
      throw error;
    });
    // Each step is billed: there is one unless the SDK had to go on.
    const usd = result.steps.reduce((sum, step) => sum + (billed(step.providerMetadata) ?? priced(id, step.usage)), 0);
    try {
      return { output: result.output, usd };
    } catch (error) {
      if (NoOutputGeneratedError.isInstance(error)) throw invalid(usd);
      throw error;
    }
  }
}
