// The script step: the director writes the edit list, and nothing it says goes on unless the site backs it. Each round
// the code checks run first (quotes, numbers, framing, filler, structure); when they find nothing, the judge reads
// every claim against its quote and every framing line for a fact about the product. Whatever fails goes to the
// corrector, scene by scene, for at most two rounds and only while the order's spending cap allows. Every model call is
// recorded on the order as it is made.
import {
  applyPatches,
  judgeItems,
  validateEdl,
  type CaptureFile,
  type Edl,
  type FramingItem,
  type JudgeItem,
  type Problem,
} from '@app/core';
import { ModelOutputInvalid, type ClaimVerdict, type FramingVerdict, type LlmPort, type OrderStore } from '../ports';
import { canAfford, EST } from './budget';

/** How many times the corrector is asked, at most. */
const PATCH_ROUNDS = 2;

export type ScriptDeps = {
  store: Pick<OrderStore, 'addCost' | 'orderCost'>;
  llm: Pick<LlmPort, 'writeEdl' | 'patchEdl' | 'judge'>;
  /** SPEND_CAP_PER_ORDER_USD. */
  spendCap: number;
};

export type ScriptResult = { ok: true; edl: Edl } | { ok: false; reason: 'validation' | 'budget' };

// A judge item is named `${scenePath}:${claimId}` or `${scenePath}:framing:${k}` (judgeItems).
const sceneOf = (itemId: string): { path: string; rest: string } => {
  const at = itemId.indexOf(':');
  return { path: itemId.slice(0, at), rest: itemId.slice(at + 1) };
};

// Why an item fails, or undefined when it passes. It fails closed: with no verdict, or when any of its verdicts fails it.
const failure = <V extends { id: string; reason: string }>(id: string, verdicts: V[], fails: (v: V) => boolean): string | undefined => {
  const mine = verdicts.filter((v) => v.id === id);
  if (mine.length === 0) return 'the judge gave no verdict on it';
  return mine.find(fails)?.reason;
};

/** What the judge failed, as problems whose `where` starts with the scene path. */
const judgeProblems = (
  items: { claims: JudgeItem[]; framing: FramingItem[] },
  verdict: { verdicts: ClaimVerdict[]; framing: FramingVerdict[] },
): Problem[] => {
  const problems: Problem[] = [];
  for (const item of items.claims) {
    const why = failure(item.id, verdict.verdicts, (v) => !v.equivalent);
    if (why === undefined) continue;
    const { path, rest: claimId } = sceneOf(item.id);
    problems.push({ where: path, rule: 'not-equivalent', detail: `claim ${claimId}: "${item.onScreen}" against its quote "${item.quote}": ${why}` });
  }
  for (const item of items.framing) {
    const why = failure(item.id, verdict.framing, (v) => v.assertsProductFact);
    if (why === undefined) continue;
    const { path, rest } = sceneOf(item.id);
    const line = rest.slice('framing:'.length);
    problems.push({ where: `${path}.lines[${line}]`, rule: 'framing-asserts', detail: `framing line "${item.text}" asserts something about the product: ${why}` });
  }
  return problems;
};

export async function runScript({
  orderId,
  capture,
  brief,
  deps,
}: {
  orderId: string;
  capture: CaptureFile;
  brief?: string;
  deps: ScriptDeps;
}): Promise<ScriptResult> {
  const { store, llm, spendCap } = deps;
  const { site } = capture;

  // Records what a call cost, whether it answered well or with something that did not fit (it was billed anyway).
  const paid = async <T extends { usd: number }>(item: string, call: () => Promise<T>): Promise<T> => {
    try {
      const answer = await call();
      await store.addCost(orderId, item, answer.usd, 'card');
      return answer;
    } catch (error) {
      if (error instanceof ModelOutputInvalid) await store.addCost(orderId, item, error.usd, 'card');
      throw error;
    }
  };

  // The code checks; the judge only when they find nothing, since the edit list changes anyway.
  const problemsOf = async (edl: Edl): Promise<Problem[]> => {
    const found = validateEdl(edl, site);
    if (found.length > 0) return found;
    const items = judgeItems(edl);
    return judgeProblems(items, await paid('llm:judge', () => llm.judge(items)));
  };

  // The edit list with the corrector's fix, or undefined when the fix cannot be used: an answer that does not fit, or a
  // patch for a scene that is not there.
  const patched = async (edl: Edl, problems: Problem[]): Promise<Edl | undefined> => {
    let fix: Awaited<ReturnType<ScriptDeps['llm']['patchEdl']>>;
    try {
      fix = await paid('llm:patch', () => llm.patchEdl({ edl, problems, site }));
    } catch (error) {
      if (error instanceof ModelOutputInvalid) return undefined;
      throw error;
    }
    try {
      return applyPatches(edl, fix.patches, fix.claimFixes);
    } catch (error) {
      if (error instanceof RangeError) return undefined;
      throw error;
    }
  };

  let { edl } = await paid('llm:director', () => llm.writeEdl({ site, images: capture.directorImages, brief }));
  let problems = await problemsOf(edl);
  for (let round = 0; problems.length > 0; round += 1) {
    if (round === PATCH_ROUNDS) return { ok: false, reason: 'validation' };
    // A patch is only worth it if the judge that checks it fits too.
    if (!canAfford(await store.orderCost(orderId), EST.patch + EST.judge, spendCap)) return { ok: false, reason: 'budget' };
    const next = await patched(edl, problems);
    // A round whose fix cannot be used is spent, and what was found stands: the same text is never judged twice, so a
    // verdict that fails it cannot be turned by asking again.
    if (next === undefined) continue;
    edl = next;
    problems = await problemsOf(edl);
  }
  return { ok: true, edl };
}
