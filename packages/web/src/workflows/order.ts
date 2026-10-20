// The durable flow of one paid order. It takes the order (one run per order), rents the VM and pays for it at most once,
// has the VM capture the site, writes and checks the script, makes the music while the VM makes the key frames, puts the
// key frames through the two-level review with up to two rounds of corrections, has the VM render the video and delivers
// it. Any failure refunds the order instead, and a VM that was rented is always told to shut down.
//
// The flow only decides: every effect is a step, which asks getAdapters() for what it needs, and the VM is reached through
// tasks it pulls and hooks its results resume. A step returns what the flow branches on as plain data, and the failures
// it expects (a model that answered badly, a review that blocks) come back as data too: only the unexpected throws, and
// the flow refunds the order for it (as the failure of the part it was making, or as `internal`). Nothing a step returns
// carries a secret: the VM's permit exists only in its script.
import {
  claimsMarkdown,
  EdlSchema,
  FPS,
  layoutScenes,
  musicMarkdown,
  retimeForBpm,
  trackCoversVideo,
  type CaptureFile,
  type CaptureInput,
  type Edl,
  type KeyframesInput,
  type Problem,
  type RenderInput,
  type SiteData,
  type VmTaskKind,
} from '@app/core';
import { createHook, getStepMetadata, getWorkflowMetadata, RetryableError, sleep } from 'workflow';
import { getAdapters } from '../adapters';
import { env } from '../env';
import { broadcastRefund, confirmRefund, prepareRefund } from '../payments/refunds';
import { payForVm, resolveVmPayment, vmPaymentKey, type PayResult } from '../payments/vm-payment';
import { canAfford, EST } from '../pipeline/budget';
import { failedCandidate, generateCandidate, musicRequest, pickTrack, type Candidate, type ChosenTrack } from '../pipeline/music';
import { runReview, type ReviewResult } from '../pipeline/review';
import { correctEdl, runScript, type ScriptResult } from '../pipeline/script';
import {
  ModelCallFailed,
  ModelOutputInvalid,
  MusicOutputInvalid,
  SETTLEMENT_GRACE_SECONDS,
  type BlobPort,
  type Deliverable,
  type OrderRequest,
  type OrderStore,
  type SettlementVerdict,
  type StepName,
  type StepState,
} from '../ports';
import { buildBootstrap } from '../vm/bootstrap';
import { capturePath, keyframesPath, renderPaths } from '../vm/tasks';
import { issueVmToken, vmTokenExpiry } from '../vm/token';

/** How a run ends. `duplicate`: another run owns (or owned) the order, and this one did nothing. */
export type OrderOutcome =
  | { status: 'delivered'; files: string[]; warnings: string[] }
  | { status: 'refunded' | 'refund_failed'; reason: string }
  | { status: 'duplicate'; runId: string };

/** Why an order is refunded: the order's `failureReason` until a refund that cannot be paid says otherwise. */
type Failure =
  | 'forced'
  | 'vm-unavailable'
  | 'vm-payment-failed'
  | 'vm-timeout'
  | 'site-blocked'
  | 'capture'
  | 'vm-isolation'
  | 'script'
  | 'quality'
  | 'render'
  | 'internal';

type Failed = { ok: false; reason: Failure };

// How long the flow waits for each task. The capture's includes the VM's start-up: the boot, the packages, the code.
const CAPTURE_TIMEOUT = '12m';
const KEYFRAMES_TIMEOUT = '5m';
const RENDER_TIMEOUT = '12m';
type TaskTimeout = typeof CAPTURE_TIMEOUT | typeof KEYFRAMES_TIMEOUT | typeof RENDER_TIMEOUT;

/** The demo pages of the site the capture follows on its own (spec §5.1). */
const DEMO_LINKS = 2;
/** Rounds of corrections after the first review: then the order is refunded. */
const REVIEW_ROUNDS = 2;
/** The candidate tracks are each a billed call: a failed one is tried once more, and no more. */
const CANDIDATE_RETRIES = 1;
/**
 * How many times an uncertain VM payment is looked up on the chain. The first look that cannot tell waits until the
 * authorization can no longer settle; the ones after it, half a minute each, are for a chain that cannot be read.
 */
const PAYMENT_LOOKS = 12;
const PAYMENT_PAUSE_MS = 30_000;
/** The refund is watched for about 10 minutes; then the reconciliation looks it up (maintenance/reconcile.ts). */
const REFUND_LOOKS = 40;
const REFUND_PAUSE = '15s';

/** The client-facing warning of an order delivered without the music it asked for. */
const MUSIC_UNAVAILABLE = 'music_unavailable';

/** The hook a task's result resumes, which also makes the task unique (OrderStore.enqueueTask). */
const vmTaskToken = (orderId: string, kind: VmTaskKind, round: number): string => `vmtask:${orderId}:${kind}:${round}`;

/** What the flow asks the VM to do. A keyframes task names its round: every round has a hook of its own. */
type TaskRequest =
  | { kind: 'capture'; input: CaptureInput }
  | { kind: 'keyframes'; round: number; edl: Edl }
  | { kind: 'render'; edl: Edl; track: ChosenTrack | null }
  | { kind: 'shutdown' };

/** The step of the status each kind of task shows as. */
const SHOWN_AS: Record<VmTaskKind, StepName | null> = { capture: 'capture', keyframes: 'preview', render: 'render', shutdown: null };

/** What a task's timeout resolves to: never a result, which is always a JSON object. */
const TIMED_OUT = Symbol('timed out');

// ---------------------------------------------------------------- the flow

export async function orderWorkflow(orderId: string): Promise<OrderOutcome> {
  'use workflow';

  // One run per order. Two reconciliations may both start a paid order: the second run finds the token taken and ends.
  using owner = createHook<never>({ token: `order:${orderId}` });
  const owned = await owner.getConflict();
  if (owned !== null) return { status: 'duplicate', runId: owned.runId };

  // Whether a VM may be running for the order: paid for, or paid for as far as anyone can tell.
  const vm = { mayExist: false };
  let made: { ok: true; files: string[]; warnings: string[] } | Failed;
  try {
    const started = await startOrder(orderId, getWorkflowMetadata().workflowRunId);
    // A run that ended already took the order (it is no longer `paid`): nothing is done twice.
    if (started.status === 'taken') return { status: 'duplicate', runId: started.runId };
    made = started.status === 'forced' ? { ok: false, reason: 'forced' } : await make(orderId, started.request, vm);
  } catch {
    // A step that failed for good, or anything else nobody expected.
    made = { ok: false, reason: 'internal' };
  }
  // Before a refund, which can take minutes: the VM has nothing left to do.
  if (vm.mayExist) await shutDownVm(orderId);
  if (made.ok) return { status: 'delivered', files: made.files, warnings: made.warnings };
  return await refund(orderId, made.reason);
}

/** The order made: the VM, the capture, the script, the music and the key frames, the review, the render, the delivery. */
async function make(orderId: string, request: OrderRequest, vm: { mayExist: boolean }): Promise<{ ok: true; files: string[]; warnings: string[] } | Failed> {
  const rental = await rentVm(orderId, vm);
  if (!rental.ok) return rental;
  await markStep(orderId, 'vm', 'done');

  const capture = { url: request.url, extraUrls: request.extraUrls ?? [], followDemoLinks: DEMO_LINKS };
  const captured = captureFailure(await vmTask(orderId, { kind: 'capture', input: capture }, CAPTURE_TIMEOUT));
  if (captured !== null) return await failAt(orderId, 'capture', captured);
  await markStep(orderId, 'capture', 'done');

  let script: { ok: true; edl: Edl } | Failed;
  try {
    script = await writeScript(orderId);
  } catch {
    script = await failAt(orderId, 'script', 'script');
  }
  if (!script.ok) return script;

  // The music while the VM makes the first key frames: neither needs the other.
  const [track, keyframes] = await Promise.all([
    makeMusic(orderId, request.audio, script.edl),
    vmTask(orderId, { kind: 'keyframes', round: 0, edl: script.edl }, KEYFRAMES_TIMEOUT),
  ]);

  const reviewed = await review(orderId, script.edl, keyframes);
  if (!reviewed.ok) return reviewed;

  // The track was chosen for the director's edit list; a correction can make the video longer than it.
  let music: ChosenTrack | null = null;
  try {
    music = track === null ? null : await trackForRender(orderId, reviewed.edl, track);
  } catch {
    // Without the check, the VM could refuse the render: the video goes out without music, never refunded for it.
    try {
      await musicUnavailable(orderId);
    } catch {
      // The video goes out all the same.
    }
  }
  const rendered = await vmTask(orderId, { kind: 'render', edl: reviewed.edl, track: music }, RENDER_TIMEOUT);
  if (rendered === TIMED_OUT) return await failAt(orderId, 'render', 'vm-timeout');
  const video = renderedVideo(rendered);
  if (video === null) return await failAt(orderId, 'render', 'render');
  await markStep(orderId, 'render', 'done');

  return { ok: true, ...(await deliver(orderId, reviewed.edl, music, video)) };
}

/** Marks the step of the status as failed and gives the failure back: a status that cannot be written does not change it. */
async function failAt(orderId: string, step: StepName, reason: Failure): Promise<Failed> {
  try {
    await markStep(orderId, step, 'failed');
  } catch {
    // The refund matters more than the step the status shows.
  }
  return { ok: false, reason };
}

// ---------------------------------------------------------------- the VM

/**
 * The VM, paid for once. A payment whose outcome is not clear (the step died, buy did not answer clearly) is looked up on
 * the chain, never paid again, and the VM is used only once the chain says buy was paid.
 */
async function rentVm(orderId: string, vm: { mayExist: boolean }): Promise<{ ok: true } | Failed> {
  let payment: VmPayment;
  try {
    payment = await payVm(orderId);
  } catch {
    // It may have died after the money went out.
    payment = { status: 'uncertain', pollUrl: null };
  }
  if (payment.status === 'rejected') return await failAt(orderId, 'vm', 'vm-unavailable');
  if (payment.status === 'uncertain') {
    const onChain = await paidOnChain(orderId);
    if (onChain !== 'settled') {
      // A chain that never told: the VM may exist, and is told to stop with the rest.
      vm.mayExist = onChain === 'unknown';
      return await failAt(orderId, 'vm', 'vm-payment-failed');
    }
  }
  vm.mayExist = true;
  return { ok: true };
}

/**
 * Whether the chain says buy got paid for the VM. An authorization nobody signed never went out; one that is unspent may
 * still be spent until it expires, so the run waits for that and asks again. When the chain cannot be read, it asks a few
 * more times and then gives up (`unknown`): the client is refunded, and at worst a VM nobody uses was paid.
 */
async function paidOnChain(orderId: string): Promise<SettlementVerdict> {
  for (let look = 1; ; look += 1) {
    let answer: { settlement: SettlementVerdict; waitMs: number | null };
    try {
      answer = await lookUpVmPayment(orderId);
    } catch {
      answer = { settlement: 'unknown', waitMs: 0 };
    }
    // Nothing signed, so nothing went out.
    if (answer.settlement === 'unknown' && answer.waitMs === null) return 'unsettled';
    if (answer.settlement !== 'unknown' || look === PAYMENT_LOOKS) return answer.settlement;
    await sleep(Math.max(answer.waitMs ?? 0, PAYMENT_PAUSE_MS));
  }
}

/**
 * Hands the VM a task and waits for its result, or for the timeout. The hook is registered before the task is queued, so
 * a VM that answers at once finds it, and it goes away with this call: a result that comes after the timeout finds
 * nobody waiting.
 */
async function vmTask(orderId: string, task: Exclude<TaskRequest, { kind: 'shutdown' }>, timeout: TaskTimeout): Promise<unknown> {
  const round = task.kind === 'keyframes' ? task.round : 0;
  using result = createHook<unknown>({ token: vmTaskToken(orderId, task.kind, round) });
  if ((await result.getConflict()) !== null) throw new Error(`Another run waits on the ${task.kind} task of round ${round} of this order.`);
  await queueTask(orderId, task);
  return await Promise.race([result, sleep(timeout).then(() => TIMED_OUT)]);
}

/** Tells the VM to stop, without waiting: a VM that never hears it stops on its own when its hour is up. */
async function shutDownVm(orderId: string): Promise<void> {
  try {
    await queueTask(orderId, { kind: 'shutdown' });
  } catch {
    // Nothing else to do.
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Whether the VM said a task went well. What it says is checked here: it comes from outside. */
const succeeded = (answer: unknown): boolean => isRecord(answer) && answer.ok === true;

/** Why the capture failed, or null when the site was captured on a VM that cannot reach the metadata server. */
function captureFailure(answer: unknown): Failure | null {
  if (answer === TIMED_OUT) return 'vm-timeout';
  if (!isRecord(answer) || answer.ok !== true) return isRecord(answer) && answer.code === 'blocked' ? 'site-blocked' : 'capture';
  // The worker drives other people's sites: if it can reach the metadata server, nothing more runs on that VM.
  if (answer.metadataBlocked !== true) return 'vm-isolation';
  return null;
}

/** The sizes of the videos the render reports, or null when it did not make them. */
function renderedVideo(answer: unknown): { mutedBytes: number; withMusicBytes: number | null } | null {
  if (!isRecord(answer) || answer.ok !== true) return null;
  const { mutedBytes, withMusicBytes } = answer;
  if (typeof mutedBytes !== 'number' || !(mutedBytes > 0)) return null;
  return { mutedBytes, withMusicBytes: typeof withMusicBytes === 'number' && withMusicBytes > 0 ? withMusicBytes : null };
}

// ---------------------------------------------------------------- the music

/**
 * The track of the video, or null: none was asked for, or none passed (the warning says so). Music never refunds an
 * order: whatever fails here, the video goes out without it.
 */
async function makeMusic(orderId: string, audio: OrderRequest['audio'], edl: Edl): Promise<ChosenTrack | null> {
  try {
    if (audio === 'none') {
      await markStep(orderId, 'music', 'skipped');
      return null;
    }
    await markStep(orderId, 'music', 'running');
    // The first two candidates at once: each is a step of its own.
    const candidates = await Promise.all([1, 2].map((index) => musicCandidate(orderId, edl, index)));
    return await chooseMusic(orderId, edl, candidates);
  } catch {
    try {
      await musicUnavailable(orderId);
    } catch {
      // The video goes out all the same.
    }
    return null;
  }
}

// ---------------------------------------------------------------- the review

/**
 * The key frames of each round through the review. What blocks goes to the corrector, at most twice and while the order's
 * cap allows a whole round (the corrector, the judge and the review after it); a fix that cannot be used spends its round
 * and leaves the same problems. Each usable fix is rendered again as key frames of a new round. The edit list that passes
 * is the one rendered.
 */
async function review(orderId: string, edl: Edl, first: unknown): Promise<{ ok: true; edl: Edl } | Failed> {
  let current = edl;
  let round = 0;
  let corrections = 0;
  let keyframes = first;
  for (;;) {
    if (keyframes === TIMED_OUT) return await failAt(orderId, 'preview', 'vm-timeout');
    if (!succeeded(keyframes)) return await failAt(orderId, 'preview', 'quality');
    await markStep(orderId, 'preview', 'done');

    let blocking: Problem[];
    try {
      const reviewed = await reviewKeyframes(orderId, current, round);
      if (!reviewed.ok) return { ok: false, reason: 'quality' };
      blocking = reviewed.blocking;
    } catch {
      return await failAt(orderId, 'review', 'quality');
    }

    let fixed: Edl | null = null;
    while (blocking.length > 0 && fixed === null) {
      if (corrections === REVIEW_ROUNDS) return await failAt(orderId, 'review', 'quality');
      corrections += 1;
      let correction: Correction;
      try {
        correction = await correctForReview(orderId, current, blocking);
      } catch {
        correction = { status: 'unusable' };
      }
      if (correction.status === 'over-budget') return await failAt(orderId, 'review', 'quality');
      if (correction.status === 'fixed') fixed = correction.edl;
    }
    if (fixed === null) return { ok: true, edl: current };

    current = fixed;
    round = corrections;
    keyframes = await vmTask(orderId, { kind: 'keyframes', round, edl: current }, KEYFRAMES_TIMEOUT);
  }
}

// ---------------------------------------------------------------- the refund

/**
 * The refund: signed once and kept, the same bytes handed to the node on every look until the chain says what came of
 * them, 15 s apart, for about 10 minutes. A refund that cannot be paid leaves the order `refund_failed`; one still
 * unconfirmed at the end leaves it `refunding`, for the reconciliation to look up.
 */
async function refund(orderId: string, reason: Failure): Promise<OrderOutcome> {
  for (let look = 1; look <= REFUND_LOOKS; look += 1) {
    try {
      const prepared = await prepareOrderRefund(orderId, reason);
      // The order was delivered after all (the delivery step failed after its last write): nothing is refunded.
      if (prepared.status === 'delivered') return { status: 'delivered', files: prepared.files, warnings: prepared.warnings };
      if (prepared.status === 'failed') return { status: 'refund_failed', reason };
      try {
        await broadcastOrderRefund(orderId);
      } catch {
        // Whether the node took them, their hash says: the look below asks.
      }
      const answer = await confirmOrderRefund(orderId);
      if (answer === 'refunded') return { status: 'refunded', reason };
      if (answer === 'failed') return { status: 'refund_failed', reason };
    } catch {
      // A step that failed for good on this look (the chain or the store did not answer): the next look goes on.
    }
    if (look < REFUND_LOOKS) await sleep(REFUND_PAUSE);
  }
  return { status: 'refund_failed', reason };
}

// ---------------------------------------------------------------- steps: the order and the VM

/**
 * Takes the order for this run: `paid` to `running`, with the run's id. A run that took it first, or an order that is no
 * longer paid, leaves it as it is. With DEV_MODE=1 and FORCE_FAIL_AT=before-vm, the order is refunded before any VM.
 */
async function startOrder(
  orderId: string,
  runId: string,
): Promise<{ status: 'started'; request: OrderRequest } | { status: 'forced' } | { status: 'taken'; runId: string }> {
  'use step';
  const { store } = await getAdapters();
  const moved = await store.transition(orderId, 'running', { runId });
  const order = await store.getOrder(orderId);
  // A second try of this step finds the order taken already, by this run: it holds the order's token, so no other run
  // can have taken it, whatever run id was written since (startRun only writes one where there is none; setRunId, which
  // this uses, is unconditional). It writes its own back.
  const retried = !moved && order?.status === 'running' && (order.runId === runId || getStepMetadata().attempt > 1);
  if (order === null || (!moved && !retried)) return { status: 'taken', runId: order?.runId ?? '' };
  if (order.runId !== runId) await store.setRunId(orderId, runId);
  const { DEV_MODE, FORCE_FAIL_AT } = env();
  if (DEV_MODE && FORCE_FAIL_AT === 'before-vm') return { status: 'forced' };
  return { status: 'started', request: order.request };
}

async function markStep(orderId: string, name: StepName, state: StepState): Promise<void> {
  'use step';
  const { store } = await getAdapters();
  await store.setStep(orderId, name, state);
}

/**
 * What the run keeps of the VM payment: how it ended and buy's tracking URL (which cannot be had again), never the reason
 * it gives, which can quote an error that holds the signed authorization (the payment record keeps it).
 */
type VmPayment = { status: PayResult['status']; pollUrl: string | null };

/**
 * Pays buy for the VM, once: the step is never run again, and it does not pay when it runs again anyway. The permit is
 * made here and written into the VM's script, which goes to buy and nowhere else; the store keeps its hash, once: a VM
 * paid for by an earlier run of this step boots with the first permit, which nothing replaces. When there is one
 * already, or this is not the first try, the payment is `uncertain` and the chain says whether it went out.
 */
async function payVm(orderId: string): Promise<VmPayment> {
  'use step';
  const { store, buy } = await getAdapters();
  const settings = env();
  await store.setStep(orderId, 'vm', 'running');
  const again: VmPayment = { status: 'uncertain', pollUrl: null };
  const { attempt } = getStepMetadata();
  if (attempt > 1) return again;
  const permit = issueVmToken();
  let script: string;
  try {
    const ref = settings.VERCEL_GIT_COMMIT_SHA ?? settings.VM_CODE_REF;
    if (settings.PUBLIC_BASE_URL === undefined || settings.GITHUB_REPO === undefined || ref === undefined) throw new RangeError('missing setting');
    script = buildBootstrap({ apiBase: settings.PUBLIC_BASE_URL, vmToken: permit.token, repo: settings.GITHUB_REPO, ref });
  } catch {
    // Nothing was paid: the service does not know where it lives or which code the VM runs. In production env.ts refuses
    // these settings before any payment is taken; this is the backstop.
    console.error('[vm_not_configured]', orderId, 'PUBLIC_BASE_URL, GITHUB_REPO and VERCEL_GIT_COMMIT_SHA (or VM_CODE_REF) make the VM script');
    return { status: 'rejected', pollUrl: null };
  }
  if (!(await store.setVmToken(orderId, permit.hash, vmTokenExpiry(new Date())))) return again;
  const paid = await payForVm({ orderId, script, attempt }, { store, buy, dailyCapUsd: settings.BUY_DAILY_CAP_USD });
  return { status: paid.status, pollUrl: paid.status === 'rejected' ? null : (paid.pollUrl ?? null) };
}
payVm.maxRetries = 0;

/**
 * What the chain says of the VM payment, and how long until asking again can tell more: until the authorization can no
 * longer settle. `waitMs` is null when nothing was signed, so nothing went out.
 */
async function lookUpVmPayment(orderId: string): Promise<{ settlement: SettlementVerdict; waitMs: number | null }> {
  'use step';
  const { store, buy } = await getAdapters();
  const settlement = await resolveVmPayment(orderId, { store, buy });
  if (settlement !== 'unknown') return { settlement, waitMs: null };
  const validBefore = (await store.getPayment(vmPaymentKey(orderId)))?.authorization?.validBefore;
  if (validBefore === undefined) return { settlement, waitMs: null };
  const finalAt = (Number(validBefore) + Number(SETTLEMENT_GRACE_SECONDS)) * 1000;
  return { settlement, waitMs: Math.max(finalAt - Date.now(), 0) };
}

/**
 * The chosen track, if it still covers the video the render makes (the edit list moved to the track's tempo) from its
 * first beat, by the rule the VM applies; otherwise none, and the video goes out without music, which the order says.
 */
async function trackForRender(orderId: string, edl: Edl, track: ChosenTrack): Promise<ChosenTrack | null> {
  'use step';
  const videoSeconds = layoutScenes(retimeForBpm(edl, track.measuredBpm), 0).total / FPS;
  if (trackCoversVideo(track, videoSeconds)) return track;
  console.warn('[music_too_short]', orderId);
  const { store } = await getAdapters();
  await noMusic(store, orderId);
  return null;
}

/** Queues a task for the VM (once per hook token) and shows its step as running. */
async function queueTask(orderId: string, task: TaskRequest): Promise<void> {
  'use step';
  const { store } = await getAdapters();
  const round = task.kind === 'keyframes' ? task.round : 0;
  await store.enqueueTask({ orderId, kind: task.kind, round, input: taskInput(task), hookToken: vmTaskToken(orderId, task.kind, round) });
  const shown = SHOWN_AS[task.kind];
  if (shown !== null) await store.setStep(orderId, shown, 'running');
}

/**
 * What the VM is given. The render gets the edit list moved to the tempo measured on the track: that one is checked with
 * the schema only, since its tempo may fall outside the director's range and its length pass the cap by about a beat.
 */
function taskInput(task: TaskRequest): unknown {
  switch (task.kind) {
    case 'capture':
      return task.input;
    case 'keyframes':
      return { edl: task.edl, hook: 0, format: '9x16', round: task.round } satisfies KeyframesInput;
    case 'render': {
      const { edl, track } = task;
      const music = track === null ? null : { firstBeat: track.firstBeat, seconds: track.seconds, path: track.path };
      return { edl: track === null ? edl : EdlSchema.parse(retimeForBpm(edl, track.measuredBpm)), hook: 0, format: '9x16', music } satisfies RenderInput;
    }
    case 'shutdown':
      return {};
  }
}

// ---------------------------------------------------------------- steps: the script, the music, the review

/** A model that did not answer is asked again later when it may answer then (429, 5xx, no status): the step is retried. */
function retryLaterIfBusy(error: unknown): void {
  if (error instanceof ModelCallFailed && (error.status === undefined || error.status === 429 || error.status >= 500)) {
    throw new RetryableError(error.message, { retryAfter: '30s' });
  }
}

/** A model call that failed for good, or answered with something that did not fit (that one is billed and recorded). */
const isModelFailure = (error: unknown): error is ModelCallFailed | ModelOutputInvalid => error instanceof ModelCallFailed || error instanceof ModelOutputInvalid;

/** A JSON file the VM wrote, or undefined when it is not JSON. A file that cannot be read throws, and the step is retried. */
async function readJson(blob: Pick<BlobPort, 'get'>, path: string): Promise<unknown> {
  const text = new TextDecoder().decode(await blob.get(path));
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The capture the VM wrote, or undefined when it is not one. */
async function readCapture(blob: Pick<BlobPort, 'get'>, orderId: string): Promise<CaptureFile | undefined> {
  const file = await readJson(blob, capturePath(orderId));
  if (!isRecord(file) || !Array.isArray(file.directorImages) || !isRecord(file.site)) return undefined;
  const site = file.site as Partial<SiteData>;
  const shaped = typeof site.url === 'string' && Array.isArray(site.sections) && Array.isArray(site.shots) && Array.isArray(site.boxes) && isRecord(site.brand);
  return shaped ? (file as CaptureFile) : undefined;
}

/** The script, from the capture: the director's edit list, checked by code and by the judge, and corrected. */
async function writeScript(orderId: string): Promise<{ ok: true; edl: Edl } | Failed> {
  'use step';
  const { store, blob, llm } = await getAdapters();
  await store.setStep(orderId, 'script', 'running');
  const failed = async (reason: Failure, why: string): Promise<Failed> => {
    console.warn('[script_failed]', orderId, why);
    await store.setStep(orderId, 'script', 'failed');
    return { ok: false, reason };
  };
  const order = await store.getOrder(orderId);
  if (order === null) throw new Error(`There is no order ${orderId}.`);
  const capture = await readCapture(blob, orderId);
  // The VM said it captured the site, and left no capture to read.
  if (capture === undefined) return await failed('capture', 'capture-unreadable');
  let result: ScriptResult;
  try {
    result = await runScript({ orderId, capture, brief: order.request.brief, deps: { store, llm, spendCap: env().SPEND_CAP_PER_ORDER_USD } });
  } catch (error) {
    retryLaterIfBusy(error);
    if (isModelFailure(error)) return await failed('script', error.name);
    throw error;
  }
  if (!result.ok) return await failed('script', result.reason);
  await store.setStep(orderId, 'script', 'done');
  return { ok: true, edl: result.edl };
}
// Each try runs the whole script again, and a director call that answered is billed again: one retry, no more.
writeScript.maxRetries = 1;

/**
 * One candidate track, of the model of its number (a try again asks the same one). A call Lyria refused after billing it
 * is not made again (its cost is recorded); any other failure is tried once more, and then it is a candidate that did
 * not pass. What leaves the step names only the kind of
 * failure: the SDK's errors can hold the request.
 */
async function musicCandidate(orderId: string, edl: Edl, index: number): Promise<Candidate> {
  'use step';
  const { store, blob, music } = await getAdapters();
  const deps = { store, blob, music, spendCap: env().SPEND_CAP_PER_ORDER_USD };
  try {
    return await generateCandidate({ ...musicRequest(orderId, edl), index }, deps);
  } catch (error) {
    const failed = failedCandidate(index, error);
    if (error instanceof MusicOutputInvalid || getStepMetadata().attempt > CANDIDATE_RETRIES) return failed;
    throw new Error(failed.problem ?? 'Lyria failed.');
  }
}
musicCandidate.maxRetries = CANDIDATE_RETRIES;

/**
 * The track among every candidate made, by measurement, with a third candidate when none passes and the cap allows it.
 * Why the others were not chosen is logged, for whoever looks into an order: the client never sees it.
 */
async function chooseMusic(orderId: string, edl: Edl, candidates: Candidate[]): Promise<ChosenTrack | null> {
  'use step';
  const { store, blob, music } = await getAdapters();
  const { track, rejected } = await pickTrack({ ...musicRequest(orderId, edl), candidates }, { store, blob, music, spendCap: env().SPEND_CAP_PER_ORDER_USD });
  if (rejected.length > 0) console.warn('[music_rejected]', orderId, JSON.stringify(rejected));
  if (track === null) await noMusic(store, orderId);
  else await store.setStep(orderId, 'music', 'done');
  return track;
}
chooseMusic.maxRetries = CANDIDATE_RETRIES;

async function musicUnavailable(orderId: string): Promise<void> {
  'use step';
  const { store } = await getAdapters();
  await noMusic(store, orderId);
}

/** The video goes out without music, and the order says so (once). */
async function noMusic(store: Pick<OrderStore, 'getOrder' | 'addWarning' | 'setStep'>, orderId: string): Promise<void> {
  await warnOnce(store, orderId, MUSIC_UNAVAILABLE);
  await store.setStep(orderId, 'music', 'failed');
}

async function warnOnce(store: Pick<OrderStore, 'getOrder' | 'addWarning'>, orderId: string, warning: string): Promise<void> {
  if (!(await store.getOrder(orderId))?.warnings.includes(warning)) await store.addWarning(orderId, warning);
}

/**
 * The review of one round of key frames: what blocks, or a failure (the order cannot afford the review, the key frames
 * file is not what the VM writes, a model failed). The remarks that do not block are logged, never shown to the client.
 */
async function reviewKeyframes(orderId: string, edl: Edl, round: number): Promise<{ ok: true; blocking: Problem[] } | { ok: false }> {
  'use step';
  const { store, blob, llm } = await getAdapters();
  await store.setStep(orderId, 'review', 'running');
  const failed = async (why: string): Promise<{ ok: false }> => {
    console.error('[review_failed]', orderId, round, why);
    await store.setStep(orderId, 'review', 'failed');
    return { ok: false };
  };
  if (!canAfford(await store.orderCost(orderId), EST.review, env().SPEND_CAP_PER_ORDER_USD)) return await failed('over-budget');
  const capture = await readCapture(blob, orderId);
  if (capture === undefined) return await failed('capture-unreadable');
  let result: ReviewResult;
  try {
    result = await runReview({ orderId, edl, site: capture.site, file: await readJson(blob, keyframesPath(orderId, round)), deps: { store, llm } });
  } catch (error) {
    retryLaterIfBusy(error);
    if (isModelFailure(error)) return await failed(error.name);
    throw error;
  }
  for (const warning of result.warnings) console.warn('[review_warning]', orderId, warning);
  // A problem at `edl` is the key frames file itself (not what the VM writes, or a frame of a scene the video does not
  // have): a failure of the VM, which no correction of the edit list can fix.
  if (result.blocking.some((problem) => problem.where === 'edl')) return await failed('keyframes-invalid');
  if (result.blocking.length === 0) await store.setStep(orderId, 'review', 'done');
  return { ok: true, blocking: result.blocking };
}
reviewKeyframes.maxRetries = 1;

type Correction = { status: 'fixed'; edl: Edl } | { status: 'unusable' } | { status: 'over-budget' };

/**
 * The corrector's fix for what the review blocked on, checked as the script is (code checks and the judge), or why there
 * is none: the round would pass the order's cap, or the fix cannot be used.
 */
async function correctForReview(orderId: string, edl: Edl, problems: Problem[]): Promise<Correction> {
  'use step';
  const { store, blob, llm } = await getAdapters();
  if (!canAfford(await store.orderCost(orderId), EST.patch + EST.judge + EST.review, env().SPEND_CAP_PER_ORDER_USD)) {
    console.warn('[review_over_budget]', orderId);
    return { status: 'over-budget' };
  }
  const capture = await readCapture(blob, orderId);
  if (capture === undefined) return { status: 'unusable' };
  try {
    const fixed = await correctEdl({ orderId, edl, problems, site: capture.site, deps: { store, llm } });
    return fixed === undefined ? { status: 'unusable' } : { status: 'fixed', edl: fixed };
  } catch (error) {
    retryLaterIfBusy(error);
    if (isModelFailure(error)) return { status: 'unusable' };
    throw error;
  }
}
correctForReview.maxRetries = 1;

// ---------------------------------------------------------------- steps: the delivery

/**
 * The delivery: claims.md and, with the music, music.md next to the videos; then the order moves to `delivered` with its
 * files, in one write, so only a delivered order has any. A track the render could not add is a video without music.
 */
async function deliver(
  orderId: string,
  edl: Edl,
  track: ChosenTrack | null,
  video: { mutedBytes: number; withMusicBytes: number | null },
): Promise<{ files: string[]; warnings: string[] }> {
  'use step';
  const { store, blob } = await getAdapters();
  await store.setStep(orderId, 'delivery', 'running');
  const capture = await readCapture(blob, orderId);
  if (capture === undefined) throw new Error('The capture cannot be read for claims.md.');
  const put = async (name: string, text: string): Promise<Deliverable> => {
    const path = `orders/${orderId}/out/${name}`;
    return { name, path, bytes: (await blob.put(path, text, 'text/markdown; charset=utf-8')).bytes };
  };

  const videos = renderPaths(orderId);
  const withMusic = track === null ? null : video.withMusicBytes;
  const files: Deliverable[] = [];
  if (withMusic !== null) files.push({ name: 'hook-a-9x16.mp4', path: videos.withMusic, bytes: withMusic });
  files.push({ name: 'hook-a-9x16-muted.mp4', path: videos.muted, bytes: video.mutedBytes });
  files.push(await put('claims.md', claimsMarkdown(edl, capture.site)));
  if (track !== null && withMusic !== null) files.push(await put('music.md', musicMarkdown({ measuredBpm: track.measuredBpm, musicPrompt: edl.musicPrompt, model: track.model })));
  else if (track !== null) await noMusic(store, orderId);

  // A second try of this step finds the order delivered by the first.
  if (!(await store.transition(orderId, 'delivered', { deliverables: files }))) {
    const status = (await store.getOrder(orderId))?.status;
    if (status !== 'delivered') throw new Error(`The order cannot be delivered from ${status ?? 'nowhere'}.`);
  }
  await store.setStep(orderId, 'delivery', 'done');
  return { files: files.map((file) => file.name), warnings: (await store.getOrder(orderId))?.warnings ?? [] };
}

// ---------------------------------------------------------------- steps: the refund

/**
 * Signs the order's refund, or gives back the one it has. A refund that cannot be paid leaves the order `refund_failed`.
 * An order that is not one to refund because it was delivered (its delivery step failed after delivering it) says so,
 * with its files.
 */
async function prepareOrderRefund(
  orderId: string,
  reason: Failure,
): Promise<{ status: 'prepared' } | { status: 'failed' } | { status: 'delivered'; files: string[]; warnings: string[] }> {
  'use step';
  const { store, refunds } = await getAdapters();
  const prepared = await prepareRefund(orderId, reason, { store, refunds, dailyCapUsd: env().REFUND_DAILY_CAP_USD });
  if ('failed' in prepared) {
    if (prepared.failed === 'not-refundable') {
      const order = await store.getOrder(orderId);
      if (order?.status === 'delivered') return { status: 'delivered', files: order.deliverables.map((file) => file.name), warnings: order.warnings };
    }
    // The order now says why the refund failed: why the order did is kept here.
    console.error('[refund_failed]', orderId, reason, prepared.failed);
    if (prepared.failed !== 'not-refundable') await store.setStep(orderId, 'refund', 'failed');
    return { status: 'failed' };
  }
  await store.setStep(orderId, 'refund', 'running');
  return { status: 'prepared' };
}

/** Hands the kept refund to the node: the same bytes every time, never signed again. */
async function broadcastOrderRefund(orderId: string): Promise<void> {
  'use step';
  const { store, refunds } = await getAdapters();
  await broadcastRefund(orderId, { store, refunds });
}
broadcastOrderRefund.maxRetries = 0;

/** What the chain says of the refund: `refunded`, `failed` (mined and reverted), or `waiting` for a later look. */
async function confirmOrderRefund(orderId: string): Promise<'refunded' | 'failed' | 'waiting'> {
  'use step';
  const { store, refunds } = await getAdapters();
  const answer = await confirmRefund(orderId, { store, refunds });
  // Mined while the order was somewhere else: it goes back through `refunding`, the only way, to `refunded`.
  const landed = answer === 'confirmed' || (answer === 'confirmed-unapplied' && (await store.transition(orderId, 'refunding')) && (await store.transition(orderId, 'refunded')));
  if (landed) {
    await store.setStep(orderId, 'refund', 'done');
    return 'refunded';
  }
  if (answer === 'reverted' || answer === 'confirmed-unapplied') {
    console.error('[refund_failed]', orderId, answer);
    await store.setStep(orderId, 'refund', 'failed');
    return 'failed';
  }
  return 'waiting';
}
