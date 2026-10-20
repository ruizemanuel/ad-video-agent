// The review step: the quality gate on the key frames of the main video, in two levels. The first is the code checks on
// what the probe measured in the real frames; the second is a model with vision looking at the pictures. What blocks:
// any code check that fails, a scene with no key frame, text that cannot be read, a letter cut mid-glyph and the
// logo-swap test. Everything else the model remarks on is a warning, recorded but never in the way of the delivery.
// Both levels always run (when there are pictures to show), so the corrector gets every problem in one round.
//
// The step fails closed. A key frames file that is not what the VM writes blocks without asking the model, a frame the
// model gave no verdict on blocks its scene, and a model call that fails or answers with something that does not fit
// goes up as an error for the flow to deal with. Nothing the model or the probe said is ever logged.
import {
  checkStills,
  layoutScenes,
  MAIN_FORMAT,
  PIECES,
  timedScenePath,
  type Check,
  type Edl,
  type KeyframesFile,
  type Problem,
  type SiteData,
  type Still,
  type TimedScene,
} from '@app/core';
import { z } from 'zod';
import { ModelOutputInvalid, type LlmPort, type OrderStore, type ReviewFrame, type VisualReview } from '../ports';

/** The key frames are of the main hook, in the main video's format (the one the platforms show first). */
const HOOK = 0;

/** The most key frames a file may hold. A video has under ten scenes and a scene a handful of frames: more is not ours. */
const MAX_STILLS = 60;

// What the VM writes (see Still and ProbeItem in core), checked where the file comes in. Numbers must be finite (zod's
// are) and the opacity one of a CSS opacity, so that a probe that measured nothing cannot pass the code checks by
// comparing against NaN. Keys the schema does not know are left out.
const ProbeItemSchema = z.object({
  text: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  fontSize: z.number(),
  font: z.string(),
  colors: z.array(z.string()),
  opacity: z.number().min(0).max(1),
  bg: z.string().nullable(),
});

const StillSchema = z.object({
  index: z.number().int().min(0),
  role: z.enum(['hook', 'body', 'cta']),
  piece: z.enum(PIECES),
  frame: z.number().int().min(0),
  path: z.string(),
  text: z.array(ProbeItemSchema),
  jpegBase64: z.string(),
});

export const KeyframesFileSchema = z.object({ stills: z.array(StillSchema).max(MAX_STILLS) }) satisfies z.ZodType<KeyframesFile>;

export type ReviewDeps = {
  store: Pick<OrderStore, 'addCost'>;
  llm: Pick<LlmPort, 'review'>;
};

export type ReviewResult = { blocking: Problem[]; warnings: string[] };

const visual = (where: string, detail: string): Problem => ({ where, rule: 'visual', detail });

const unique = <T>(items: T[]): T[] => [...new Set(items)];

// Where a problem is about the whole ad and not one scene (the logo-swap test, a verdict on a frame that is not there).
const WHOLE_AD = 'all';

// ---------- level one: the code checks ----------

// A check says all its failures in one `detail`, each starting with the path of its scene, joined by " | ".
const NEXT_SCENE = / \| (?=(?:hooks\[\d+\]\[\d+\]|body\[\d+\]|cta)[ :])/;

// What a failed check says about one scene: its own failures, or all of it if they cannot be told apart.
const detailAt = (check: Check, path: string): string => {
  const own = check.detail.split(NEXT_SCENE).filter((part) => part.startsWith(`${path} `) || part.startsWith(`${path}:`));
  return own.length > 0 ? own.join(' | ') : check.detail;
};

const failedChecks = (checks: Check[]): Problem[] =>
  checks.filter((check) => !check.pass).flatMap((check) => check.where.map((path) => visual(path, `${check.name}: ${detailAt(check, path)}`)));

// ---------- level two: the visual review ----------

const frameLabel = (n: number, path: string, role: string, piece: string, picture: { of: number; at: number }): string =>
  `Frame ${n}: ${path}, ${role} scene, ${piece}${picture.of > 1 ? `, picture ${picture.at} of ${picture.of} (its text changes)` : ''}`;

type FrameVerdict = VisualReview['frames'][number];

// What the model said of one place, `where`, in one or more verdicts: a problem if any of them blocks it, else warnings.
function judge(where: string, verdicts: FrameVerdict[], out: ReviewResult): void {
  const issues = unique(verdicts.flatMap((v) => v.issues.map((issue) => issue.trim()).filter((issue) => issue !== '')));
  const what: string[] = [];
  if (verdicts.some((v) => !v.legible)) what.push('text not legible on a phone');
  if (verdicts.some((v) => v.cutMidLetter)) what.push('a letter is cut by an edge or a mask');
  if (what.length > 0) out.blocking.push(visual(where, `visual review: ${what.join(' and ')}${issues.length > 0 ? `: ${issues.join('; ')}` : ''}`));
  else out.warnings.push(...issues.map((issue) => `${where}: ${issue}`));
}

// The model's review, placed on the scenes by the number of each frame (the first is 1).
function judgeReview(review: VisualReview, paths: string[]): ReviewResult {
  const out: ReviewResult = { blocking: [], warnings: [] };
  paths.forEach((path, k) => {
    const verdicts = review.frames.filter((v) => v.frame === k + 1);
    if (verdicts.length === 0) out.blocking.push(visual(path, 'visual review: no verdict on this frame'));
    else judge(path, verdicts, out);
  });
  // A verdict on a frame that is not there cannot be placed on a scene: it is about the whole ad.
  for (const verdict of review.frames.filter((v) => v.frame < 1 || v.frame > paths.length)) judge(WHOLE_AD, [verdict], out);
  if (review.logoSwap.generic) out.blocking.push(visual(WHOLE_AD, `logo-swap test: the ad would work as well for another brand: ${review.logoSwap.reason}`));
  return out;
}

// ---------- the step ----------

const invalidFile = (error: z.ZodError): Problem => {
  // Where the file is wrong and how, never what it holds: it can hold the site's text.
  const found = error.issues.slice(0, 3).map((issue) => `${issue.path.join('.') || 'file'}: ${issue.message}`);
  return visual('edl', `The key frames file is not valid: ${found.join('; ')}`);
};

/**
 * Reviews the key frames of round `file` for the edit list `edl`. `file` is what was read from the blob store and parsed
 * as JSON, checked here. Returns what blocks the delivery (each problem names its scene, or `edl` for the file and `all`
 * for the ad as a whole) and the warnings (`<scene path>: <remark>`). The visual review is recorded on the order as a
 * card cost, also when its answer did not fit, in which case the error goes on.
 */
export async function runReview({
  orderId,
  edl,
  site,
  file,
  deps,
}: {
  orderId: string;
  edl: Edl;
  site: SiteData;
  file: unknown;
  deps: ReviewDeps;
}): Promise<ReviewResult> {
  const { store, llm } = deps;

  const parsed = KeyframesFileSchema.safeParse(file);
  if (!parsed.success) return { blocking: [invalidFile(parsed.error)], warnings: [] };
  const { stills } = parsed.data;

  // Each key frame with the scene it is of, as the edit list lays the video out.
  const { scenes } = layoutScenes(edl, HOOK);
  const located: { still: Still; timed: TimedScene }[] = [];
  const stray: number[] = [];
  for (const still of stills) {
    const timed = scenes.find((scene) => scene.index === still.index);
    if (timed) located.push({ still, timed });
    else stray.push(still.index);
  }
  if (stray.length > 0) {
    const blocking = unique(stray).map((index) => visual('edl', `A key frame is of scene ${index}, but the video has ${scenes.length} scenes.`));
    return { blocking, warnings: [] };
  }

  // Level one.
  const noFrame = scenes.filter((scene) => !stills.some((s) => s.index === scene.index)).map((scene) => visual(timedScenePath(edl, HOOK, scene), 'no keyframe'));
  const blocking = [...failedChecks(checkStills(stills, edl, site, MAIN_FORMAT, HOOK)), ...noFrame];
  if (stills.length === 0) return { blocking, warnings: [] };

  // Level two: every key frame in playing order, labeled with its number and its scene so that the verdicts find their way back.
  const paths = located.map(({ timed }) => timedScenePath(edl, HOOK, timed));
  const frames: ReviewFrame[] = located.map(({ still, timed }, k) => {
    const same = located.filter((other) => other.timed.index === timed.index);
    const picture = { of: same.length, at: same.findIndex((other) => other.still === still) + 1 };
    return { label: frameLabel(k + 1, paths[k] ?? '', timed.role, timed.scene.piece, picture), jpeg: still.jpegBase64 };
  });

  let answer: Awaited<ReturnType<LlmPort['review']>>;
  try {
    answer = await llm.review({ frames, siteUrl: site.url });
    await store.addCost(orderId, 'llm:review', answer.usd, 'card');
  } catch (error) {
    // The model was paid for an answer that did not fit.
    if (error instanceof ModelOutputInvalid) await store.addCost(orderId, 'llm:review', error.usd, 'card');
    throw error;
  }

  const visualReview = judgeReview(answer.review, paths);
  return {
    blocking: [...blocking, ...visualReview.blocking],
    warnings: unique(visualReview.warnings),
  };
}
