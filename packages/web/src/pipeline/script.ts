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
  type ScenePatch,
  type SiteData,
} from '@app/core';
import { ModelCallFailed, ModelOutputInvalid, type ClaimVerdict, type FramingVerdict, type LlmPort, type OrderStore } from '../ports';
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

/**
 * Why the corrector's fix cannot be used: its answer does not fit (`patch-invalid`), it patches a scene that is not there
 * (`patch-path`), the edit list it makes fails the code checks (`checks`) or the judge fails an item of it (`judge`).
 * `problems` are what failed, and `patched` the scenes the fix put in, for the last two.
 */
export type Unusable = { ok: false; reason: 'patch-invalid' | 'patch-path' | 'checks' | 'judge'; problems: Problem[]; patched: ScenePatch[] };

export type Corrected = { ok: true; edl: Edl } | Unusable;

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

/** What one round of checks and corrections needs: the order to record each call on, and the models. */
type Calls = { orderId: string; store: Pick<OrderStore, 'addCost'>; llm: Pick<LlmPort, 'patchEdl' | 'judge'> };

/** Runs a model call and records what it cost, whether it answered well or with something that did not fit (billed anyway). */
async function paid<T extends { usd: number }>({ orderId, store }: Calls, item: string, call: () => Promise<T>): Promise<T> {
  try {
    const answer = await call();
    await store.addCost(orderId, item, answer.usd, 'card');
    return answer;
  } catch (error) {
    if (error instanceof ModelOutputInvalid) await store.addCost(orderId, item, error.usd, 'card');
    throw error;
  }
}

/**
 * The code checks; the judge only when they find nothing, since the edit list changes anyway, and only about the items
 * it has not read: the rest keep what it said about them. Says which of the two found the problems.
 */
async function problemsOf(calls: Calls, edl: Edl, site: SiteData, verdicts: Verdicts): Promise<{ by: 'checks' | 'judge'; problems: Problem[] }> {
  const found = validateEdl(edl, site);
  if (found.length > 0) return { by: 'checks', problems: found };
  const items = judgeItems(edl);
  const unread = verdicts.unread(items);
  if (unread.claims.length + unread.framing.length > 0) verdicts.keep(unread, await paid(calls, 'llm:judge', () => calls.llm.judge(unread)));
  return { by: 'judge', problems: verdicts.problems(items) };
}

/**
 * The edit list with the corrector's fix and the scenes it put in, or why the fix cannot be used: an answer that does not
 * fit, or a patch for a scene that is not there.
 */
async function patched(
  calls: Calls,
  edl: Edl,
  problems: Problem[],
  site: SiteData,
): Promise<{ ok: true; edl: Edl; patches: ScenePatch[] } | { ok: false; reason: 'patch-invalid' | 'patch-path' }> {
  let fix: Awaited<ReturnType<LlmPort['patchEdl']>>;
  try {
    fix = await paid(calls, 'llm:patch', () => calls.llm.patchEdl({ edl, problems, site }));
  } catch (error) {
    if (error instanceof ModelOutputInvalid) return { ok: false, reason: 'patch-invalid' };
    throw error;
  }
  try {
    return { ok: true, edl: applyPatches(edl, fix.patches, fix.claimFixes), patches: fix.patches };
  } catch (error) {
    if (error instanceof RangeError) return { ok: false, reason: 'patch-path' };
    throw error;
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
  const calls: Calls = { orderId, store, llm };
  const verdicts = new Verdicts();

  let { edl } = await paid(calls, 'llm:director', () => llm.writeEdl({ site, images: capture.directorImages, brief }));
  let { problems } = await problemsOf(calls, edl, site, verdicts);
  for (let round = 0; problems.length > 0; round += 1) {
    if (round === PATCH_ROUNDS) return { ok: false, reason: 'validation' };
    // A patch is only worth it if the judge that checks it fits too.
    if (!canAfford(await store.orderCost(orderId), EST.patch + EST.judge, spendCap)) return { ok: false, reason: 'budget' };
    const next = await patched(calls, edl, problems, site);
    // A round whose fix cannot be used is spent, and what was found stands. A fix that leaves a failing item as it was
    // does not help either: the judge is not asked about it again, and it fails the same way.
    if (!next.ok) continue;
    edl = next.edl;
    ({ problems } = await problemsOf(calls, edl, site, verdicts));
  }
  return { ok: true, edl };
}

/**
 * One correction outside the script's own rounds, for the problems the visual review found in the key frames: the
 * corrector's fix, applied and checked as the script checks its edit lists (the code checks, then the judge on every
 * item, since nothing it said before is at hand). When the fix cannot be used, says why (see Unusable). Every call is
 * recorded on the order, and any other failure of a model goes up: a call that failed, or a judge's answer that does
 * not fit (the corrector's own is `patch-invalid`).
 */
export async function correctEdl({
  orderId,
  edl,
  problems,
  site,
  deps,
}: {
  orderId: string;
  edl: Edl;
  problems: Problem[];
  site: SiteData;
  deps: Omit<Calls, 'orderId'>;
}): Promise<Corrected> {
  const calls: Calls = { orderId, ...deps };
  const fix = await patched(calls, edl, problems, site);
  if (!fix.ok) return { ok: false, reason: fix.reason, problems: [], patched: [] };
  const found = await problemsOf(calls, fix.edl, site, new Verdicts());
  if (found.problems.length > 0) return { ok: false, reason: found.by, problems: found.problems, patched: fix.patches };
  return { ok: true, edl: fix.edl };
}

/**
 * Why a correction cannot be used, in one line for the order's log: the reason, what failed as `where:rule`, and the
 * scenes the fix put in as `path:piece shotId#boxIndex`. Only what the code wrote or checked goes in: never a problem's
 * detail, which quotes the site and the model, nor the text of a scene, and a shot the site does not have is `?`.
 */
export function unusableSummary({ reason, problems, patched }: Unusable, site: SiteData): string {
  const failed = [...new Set(problems.map((p) => `${p.where}:${p.rule}`))].join(',');
  const shotOf = (shotId: string): string => (site.shots.some((s) => s.id === shotId) ? shotId : '?');
  const scenes = patched
    .map(({ path, scene }) => {
      const shot = scene.shotId === undefined ? '' : ` ${shotOf(scene.shotId)}${scene.boxIndex === undefined ? '' : `#${scene.boxIndex}`}`;
      return `${path}:${scene.piece}${shot}`;
    })
    .join(',');
  return [reason, failed, scenes && `| patched ${scenes}`].filter(Boolean).join(' ');
}

/**
 * Why a correction cannot be used when a model call of it failed for good (see correctEdl), in one line for the order's
 * log: `model call:ErrorName[:status]`, nothing the call sent or got back. The corrector's answer that does not fit is
 * `patch-invalid`, so one that comes up here is the judge's.
 */
export const failedCallSummary = (error: ModelCallFailed | ModelOutputInvalid): string =>
  error instanceof ModelCallFailed ? `model ${error.call}:${error.name}${error.status === undefined ? '' : `:${error.status}`}` : `model judge:${error.name}`;
