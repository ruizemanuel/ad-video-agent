// The LlmPort as a double, for the tests that run the pre-check, the script and the flow without a model. It answers
// what a test tells it to, and counts the calls it gets and keeps what each was last asked, so a test can say a model
// was (or was not) asked, and with what. A test changes an answer by assigning the method: `llm.judge = async () => ...`.
import { scenePaths, type Claim, type Edl, type Scene, type ScenePatch } from '@app/core';
import type { LlmPort } from '../../ports';

type ClassifySite = LlmPort['classifySite'];
type WriteEdl = LlmPort['writeEdl'];
type PatchEdl = LlmPort['patchEdl'];
type Judge = LlmPort['judge'];
type Review = LlmPort['review'];

// A claim problem says which claim it is about at the start of its detail ("claim c3: ...").
const CLAIM_DETAIL = /^claim (\S+):/;

export class FakeLlm implements LlmPort {
  /** How many times each call was made, whatever it answered. */
  readonly calls = { classifySite: 0, writeEdl: 0, patchEdl: 0, judge: 0, review: 0 };

  /** What `writeEdl` answers. */
  edl: Edl | undefined;
  /**
   * Where `patchEdl` takes its fixes from: for each scene a problem names, the scene at that path here, and for each claim
   * a problem names, that claim here. With none, the patches change nothing.
   */
  fixed: Edl | undefined;
  /** The framing items (by id, e.g. `hooks[0][0]:framing:0`) the judge says assert a fact about the product. */
  framingVerdicts: Record<string, boolean> = {};
  /** The claim items (by id, e.g. `body[1]:c3`) and whether the judge finds each equivalent to its quote. */
  claimVerdicts: Record<string, boolean> = {};
  /** The judge finds no claim equivalent to its quote, whatever the patches did. */
  alwaysBad = false;
  /** What each call costs. */
  usd = { writeEdl: 0.2, patchEdl: 0.05, judge: 0.01, review: 0.2 };

  lastWriteInput: Parameters<WriteEdl>[0] | undefined;
  lastPatchInput: Parameters<PatchEdl>[0] | undefined;
  lastJudgeInput: Parameters<Judge>[0] | undefined;
  lastReviewInput: Parameters<Review>[0] | undefined;

  private classifyAnswer: ClassifySite = async () => ({ admissible: true, reason: 'The site is a normal business site.', usd: 0.0004 });

  private writeAnswer: WriteEdl = async () => {
    if (this.edl === undefined) throw new Error('The FakeLlm has no edit list to write: a test sets `llm.edl`.');
    return { edl: this.edl, usd: this.usd.writeEdl };
  };

  private patchAnswer: PatchEdl = async ({ problems }) => {
    const source = this.fixed;
    const scenes = new Map<string, Scene>(source === undefined ? [] : scenePaths(source).map(({ path, scene }) => [path, scene]));
    const patches: ScenePatch[] = [];
    const claimFixes: Claim[] = [];
    for (const { where, detail } of problems) {
      const path = where.split('.')[0] ?? where;
      const scene = scenes.get(path);
      if (scene && !patches.some((p) => p.path === path)) patches.push({ path, scene });
      const claimId = where === 'edl' ? CLAIM_DETAIL.exec(detail)?.[1] : undefined;
      const claim = source?.claims.find((c) => c.id === claimId);
      if (claim && !claimFixes.some((c) => c.id === claim.id)) claimFixes.push(claim);
    }
    return { patches, claimFixes, usd: this.usd.patchEdl };
  };

  private judgeAnswer: Judge = async ({ claims, framing }) => ({
    verdicts: claims.map(({ id }) => {
      const equivalent = !this.alwaysBad && (this.claimVerdicts[id] ?? true);
      return { id, equivalent, reason: equivalent ? 'The line says what the quote says.' : 'The line says more than the quote.' };
    }),
    framing: framing.map(({ id }) => {
      const assertsProductFact = this.framingVerdicts[id] ?? false;
      return { id, assertsProductFact, reason: assertsProductFact ? 'The line asserts something about the product.' : 'The line asserts nothing.' };
    }),
    usd: this.usd.judge,
  });

  // The reviewer finds nothing wrong: every frame legible and whole, no remarks, and an ad that is specific to its product.
  private reviewAnswer: Review = async ({ frames }) => ({
    review: {
      frames: frames.map((_, k) => ({ frame: k + 1, legible: true, cutMidLetter: false, issues: [] })),
      logoSwap: { generic: false, reason: 'The ad leans on what only this product has.' },
    },
    usd: this.usd.review,
  });

  /** Counts the call and answers as the test said: a test sets the answer with `llm.classifySite = async (input) => ...`. */
  get classifySite(): ClassifySite {
    return async (input) => {
      this.calls.classifySite += 1;
      return this.classifyAnswer(input);
    };
  }

  set classifySite(answer: ClassifySite) {
    this.classifyAnswer = answer;
  }

  get writeEdl(): WriteEdl {
    return async (input) => {
      this.calls.writeEdl += 1;
      this.lastWriteInput = input;
      return this.writeAnswer(input);
    };
  }

  set writeEdl(answer: WriteEdl) {
    this.writeAnswer = answer;
  }

  get patchEdl(): PatchEdl {
    return async (input) => {
      this.calls.patchEdl += 1;
      this.lastPatchInput = input;
      return this.patchAnswer(input);
    };
  }

  set patchEdl(answer: PatchEdl) {
    this.patchAnswer = answer;
  }

  get judge(): Judge {
    return async (input) => {
      this.calls.judge += 1;
      this.lastJudgeInput = input;
      return this.judgeAnswer(input);
    };
  }

  set judge(answer: Judge) {
    this.judgeAnswer = answer;
  }

  get review(): Review {
    return async (input) => {
      this.calls.review += 1;
      this.lastReviewInput = input;
      return this.reviewAnswer(input);
    };
  }

  set review(answer: Review) {
    this.reviewAnswer = answer;
  }
}
