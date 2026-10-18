// The judge's instructions: the claim check of the quality test (each line against its quote, nothing added) and the
// framing check of 2a (a framing line asserts nothing about the product). The code has already checked what code can:
// quotes are on the site, numbers match, framing has no numbers. The judge reads meaning.
import type { FramingItem, JudgeItem } from '@app/core';
import { z } from 'zod';

export const JUDGE_SYSTEM = `You check product ads for honesty. You receive two lists of items.

\`claims\`: for each item, decide whether the on-screen phrase (\`onScreen\`) states the same thing as
the quote from the website (\`quote\`), without adding anything. Paraphrase, translation and saying
less are fine. Adding a fact, a number, a promise, a scope ("always", "every", "anyone") or a meaning
the quote does not support is not. Judge only against the quote, not against what you know about the
product.

\`framing\`: lines meant to carry no facts (questions, pains, calls to action). For each one:
does this framing line assert a fact about the product? "¿Cuánto te cobran por cada venta?" or
"Create your store" assert nothing; "Los más baratos del país", "the best", "the fastest" or "your
store in minutes" assert something about the product, even without a number.

Return one verdict for every item, with its \`id\`, and a reason of one short sentence.`;

/** What the judge is sent. */
export const judgePrompt = (items: { claims: JudgeItem[]; framing: FramingItem[] }): string => `Items:\n${JSON.stringify(items, null, 1)}`;

const reason = z.string().describe('One short sentence.');

export const JUDGE_OUTPUT = z.object({
  verdicts: z.array(z.object({ id: z.string(), equivalent: z.boolean(), reason })).describe('One per item of `claims`.'),
  framing: z.array(z.object({ id: z.string(), assertsProductFact: z.boolean(), reason })).describe('One per item of `framing`.'),
});
