// The script step: the director writes the edit list, and nothing it says goes on unless the site backs it. Each round
// the code checks run first (quotes, numbers, framing, filler, structure); when they find nothing, the judge reads
// every claim against its quote and every framing line, with its scene, for a fact about the product. The judge reads
// each text once: what it said stands while the text is the same. Whatever fails goes to the corrector, scene by scene,
// for at most two rounds and only while the order's spending cap allows. Every model call is recorded on the order as
// it is made.
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

const claimProblem = (item: JudgeItem, why: string): Problem => {
  const { path, rest: claimId } = sceneOf(item.id);
  return { where: path, rule: 'not-equivalent', detail: `claim ${claimId}: "${item.onScreen}" against its quote "${item.quote}": ${why}` };
};

const framingProblem = (item: FramingItem, why: string): Problem => {
  const { path, rest } = sceneOf(item.id);
  const line = rest.slice('framing:'.length);
  return { where: `${path}.lines[${line}]`, rule: 'framing-asserts', detail: `framing line "${item.text}" asserts something about the product: ${why}` };
};

// An item as the judge read it: its id and everything it was shown. The same key is the same text, in the same place.
const claimKey = (item: JudgeItem): string => JSON.stringify(['claim', item.id, item.onScreen, item.quote]);
const framingKey = (item: FramingItem): string => JSON.stringify(['framing', item.id, item.text, item.context]);

const PASSED = Symbol('passed');

type Items = { claims: JudgeItem[]; framing: FramingItem[] };

/**
 * What the judge said about each item it read, for the life of one script: why it failed, or `passed`. An item that
 * reads the same is never asked about again, so a verdict that failed it cannot be turned by asking until it passes.
 */
class Verdicts {
  private readonly said = new Map<string, string | typeof PASSED>();

  /** The items there is no verdict on yet. */
  unread(items: Items): Items {
    return { claims: items.claims.filter((i) => !this.said.has(claimKey(i))), framing: items.framing.filter((i) => !this.said.has(framingKey(i))) };
  }

  /** Keeps what the judge said about the items it was asked about. */
  keep(asked: Items, verdict: { verdicts: ClaimVerdict[]; framing: FramingVerdict[] }): void {
    for (const item of asked.claims) this.said.set(claimKey(item), failure(item.id, verdict.verdicts, (v) => !v.equivalent) ?? PASSED);
    for (const item of asked.framing) this.said.set(framingKey(item), failure(item.id, verdict.framing, (v) => v.assertsProductFact) ?? PASSED);
  }

  /** What failed, as problems whose `where` starts with the scene path. Every item has to have been read. */
  problems(items: Items): Problem[] {
    const why = (key: string): string | undefined => {
      const said = this.said.get(key);
      if (said === undefined) throw new Error('The judge has not read this item.');
      return said === PASSED ? undefined : said;
    };
    return [
      ...items.claims.flatMap((item) => {
        const reason = why(claimKey(item));
        return reason === undefined ? [] : [claimProblem(item, reason)];
      }),
      ...items.framing.flatMap((item) => {
        const reason = why(framingKey(item));
        return reason === undefined ? [] : [framingProblem(item, reason)];
      }),
    ];
  }
}

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

  // The code checks; the judge only when they find nothing, since the edit list changes anyway, and only about the
  // items it has not read: the rest keep what it said about them.
  const verdicts = new Verdicts();
  const problemsOf = async (edl: Edl): Promise<Problem[]> => {
    const found = validateEdl(edl, site);
    if (found.length > 0) return found;
    const items = judgeItems(edl);
    const unread = verdicts.unread(items);
    if (unread.claims.length + unread.framing.length > 0) verdicts.keep(unread, await paid('llm:judge', () => llm.judge(unread)));
    return verdicts.problems(items);
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
    // A round whose fix cannot be used is spent, and what was found stands. A fix that leaves a failing item as it was
    // does not help either: the judge is not asked about it again, and it fails the same way.
    if (next === undefined) continue;
    edl = next;
    problems = await problemsOf(edl);
  }
  return { ok: true, edl };
}
