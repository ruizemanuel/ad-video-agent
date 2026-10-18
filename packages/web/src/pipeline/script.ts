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

/** What the judge failed, as problems whose `where` starts with the scene path. An item it said nothing about fails. */
const judgeProblems = (
  items: { claims: JudgeItem[]; framing: FramingItem[] },
  verdict: { verdicts: ClaimVerdict[]; framing: FramingVerdict[] },
): Problem[] => {
  const problems: Problem[] = [];
  for (const item of items.claims) {
    const { path, rest: claimId } = sceneOf(item.id);
    const found = verdict.verdicts.find((v) => v.id === item.id);
    if (found?.equivalent) continue;
    const why = found ? found.reason : 'the judge gave no verdict on it';
    problems.push({ where: path, rule: 'not-equivalent', detail: `claim ${claimId}: "${item.onScreen}" against its quote "${item.quote}": ${why}` });
  }
  for (const item of items.framing) {
    const { path, rest } = sceneOf(item.id);
    const found = verdict.framing.find((v) => v.id === item.id);
    if (found && !found.assertsProductFact) continue;
    const why = found ? found.reason : 'the judge gave no verdict on it';
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

  let { edl } = await paid('llm:director', () => llm.writeEdl({ site, images: capture.directorImages, brief }));
  for (let round = 0; ; round += 1) {
    const problems = await problemsOf(edl);
    if (problems.length === 0) return { ok: true, edl };
    if (round === PATCH_ROUNDS) return { ok: false, reason: 'validation' };
    // A patch is only worth it if the judge that checks it fits too.
    if (!canAfford(await store.orderCost(orderId), EST.patch + EST.judge, spendCap)) return { ok: false, reason: 'budget' };
    // An answer that does not fit, or a patch for a scene that is not there, spends the round: the edit list stays as it was.
    let fix: Awaited<ReturnType<ScriptDeps['llm']['patchEdl']>>;
    try {
      fix = await paid('llm:patch', () => llm.patchEdl({ edl, problems, site }));
    } catch (error) {
      if (error instanceof ModelOutputInvalid) continue;
      throw error;
    }
    try {
      edl = applyPatches(edl, fix.patches, fix.claimFixes);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
  }
}
