// The order workflow from the paid order to the delivery or the refund, on the fake adapters, with the test as the VM.
import { claimsMarkdown, EdlSchema, judgeItems, retimeForBpm, validateEdl, type Edl, type MusicModel, type RenderInput } from '@app/core';
import { clickWav } from '@app/core/testing';
import { waitForHook, waitForSleep } from '@workflow/vitest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRun, start } from 'workflow/api';
import { FakeLlm } from '../../src/adapters/fake/llm';
import { FakeMusic } from '../../src/adapters/fake/music';
import { renderPaths } from '../../src/vm/tasks';
import { vmTokenHash } from '../../src/vm/token';
import { orderWorkflow } from '../../src/workflows/order';
import { captureShop, edlShop as shopEdl, siteShop as shopSite } from '../support/shop';
import {
  actAsVm,
  BUY_PAY_TO,
  fakeService,
  paidOrder,
  passingKeyframes,
  PAYER,
  PRICE,
  removeFakeService,
  runLog,
  scenario,
  stepOutput,
  taskToken,
  tasks,
  USDT,
  type Fakes,
} from './support';

const edlShop = shopEdl();
const siteShop = shopSite();
const CAPTURED = { ok: true, metadataBlocked: true, sections: 4, shots: 2 };
const KEYFRAMES = passingKeyframes(edlShop, siteShop);
const RENDERED = { ok: true, frames: 573, seconds: 19.1, mutedBytes: 10, withMusicBytes: 10 };
const RENDERED_MUTED = { ok: true, frames: 573, seconds: 19.1, mutedBytes: 10, withMusicBytes: null };
const ALL_FILES = ['hook-a-9x16.mp4', 'hook-a-9x16-muted.mp4', 'claims.md', 'music.md'];
const MUTED_FILES = ['hook-a-9x16-muted.mp4', 'claims.md'];

let fakes: Fakes;
let dir: string;
let id: string;

beforeAll(async () => {
  ({ fakes, dir } = await fakeService());
});

afterAll(async () => {
  await removeFakeService(dir);
});

// Each test gets models and music of its own; buy and the refunds' wallet are one for the file, as on the chain.
beforeEach(async () => {
  fakes.llm = new FakeLlm();
  fakes.llm.edl = edlShop;
  fakes.music = new FakeMusic();
  id = await paidOrder(fakes.store);
});

afterEach(() => {
  scenario({});
  vi.restoreAllMocks();
});

// A track for the shop's video (112 bpm asked): hits long enough to read as music, longer than the video.
const track = (bpm: number, gainDb: number): Uint8Array => clickWav({ bpm, seconds: 22, offset: 0.2, gainDb, clickSeconds: 0.25 });

/**
 * Has the music double answer with the track of the model that is asked, whichever candidate asks first (the first two are
 * made at once, so their order of arrival is not for a test to rely on). A model with no track gets the double's own.
 */
function answerByModel(tracks: Partial<Record<MusicModel, Uint8Array>>): void {
  const music = fakes.music;
  const generate = music.generate.bind(music);
  music.generate = async (prompt, model) => {
    const wav = tracks[model];
    if (wav !== undefined) music.queue.unshift(wav);
    return generate(prompt, model);
  };
}

const text = async (path: string): Promise<string> => new TextDecoder().decode(await fakes.blob.get(path));
const kinds = async (orderId: string) => (await tasks(fakes.store, orderId)).map((t) => `${t.kind}:${t.round}`);
const rentals = () => fakes.buy.vmRentals.length;

/** Runs the order up to the point the VM has captured the site and made the first key frames. */
async function captureAndPreview(orderId: string) {
  const run = await start(orderWorkflow, [orderId]);
  await actAsVm(run, orderId, 'capture', 0, captureShop(), CAPTURED);
  await actAsVm(run, orderId, 'keyframes', 0, KEYFRAMES, { ok: true, stills: KEYFRAMES.stills.length });
  return run;
}

/**
 * Has the run time out on the task it is waiting for. Every task the VM answered left its timeout pending (a race does
 * not cancel the sleep that lost it): `answered` says how many there are, and they are woken first, oldest first, which
 * changes nothing.
 */
async function timeOut(run: Awaited<ReturnType<typeof start>>, orderId: string, kind: 'capture' | 'keyframes' | 'render', round = 0, answered = 0) {
  await waitForHook(run, { token: taskToken(orderId, kind, round) });
  for (let k = 0; k <= answered; k++) await getRun(run.runId).wakeUp({ correlationIds: [await waitForSleep(run)] });
}

describe('an order that goes through', () => {
  it('delivers the muted and music MP4s, claims.md and music.md, then shuts the VM down', async () => {
    // Both tracks pass; the more energetic is the first candidate's, which Lyria 3.5 makes.
    answerByModel({ 'lyria-3.5': track(113, -6), 'lyria-3-pro-preview': track(113, -10) });
    const run = await captureAndPreview(id);
    await actAsVm(run, id, 'render', 0, null, RENDERED);
    expect(await run.returnValue).toEqual({ status: 'delivered', files: ALL_FILES, warnings: [] });

    const queued = await tasks(fakes.store, id);
    expect(queued.map((t) => t.kind)).toEqual(['capture', 'keyframes', 'render', 'shutdown']);
    const order = await fakes.store.getOrder(id);
    expect(order).toMatchObject({ status: 'delivered', warnings: [], failureReason: null });
    expect(order?.steps).toEqual({ payment: 'done', vm: 'done', capture: 'done', script: 'done', music: 'done', preview: 'done', review: 'done', render: 'done', delivery: 'done' });
    const out = renderPaths(id);
    expect(order?.deliverables).toEqual([
      { name: 'hook-a-9x16.mp4', path: out.withMusic, bytes: 10 },
      { name: 'hook-a-9x16-muted.mp4', path: out.muted, bytes: 10 },
      { name: 'claims.md', path: `orders/${id}/out/claims.md`, bytes: expect.any(Number) },
      { name: 'music.md', path: `orders/${id}/out/music.md`, bytes: expect.any(Number) },
    ]);
    expect(await text(`orders/${id}/out/claims.md`)).toBe(claimsMarkdown(edlShop, siteShop));

    // The render gets the edit list moved to the tempo measured on the chosen track, and the track.
    const render = queued[2]?.input as RenderInput;
    expect(render.music).toEqual({ firstBeat: expect.any(Number), seconds: expect.any(Number), path: `orders/${id}/music/cand-1.wav` });
    expect(render.edl).toEqual(retimeForBpm(edlShop, render.edl.bpm));
    expect(EdlSchema.parse(render.edl)).toEqual(render.edl);
    expect(render).toMatchObject({ hook: 0, format: '9x16' });
    const bpm = Number.isInteger(render.edl.bpm) ? String(render.edl.bpm) : render.edl.bpm.toFixed(1);
    expect(await text(`orders/${id}/out/music.md`)).toContain(`${bpm} BPM`);
    // Every order makes one track of each model; the chosen one is the first, and music.md names its model.
    expect([...fakes.music.models].sort()).toEqual(['lyria-3-pro-preview', 'lyria-3.5']);
    const note = await text(`orders/${id}/out/music.md`);
    expect(note).toContain('made for this video by Google Lyria 3.5, an AI music model');
    expect(note).not.toContain('3 Pro');
    // The key frames are of the edit list as the director wrote it and the checks passed it.
    expect(queued[1]?.input).toEqual({ edl: edlShop, hook: 0, format: '9x16', round: 0 });
    expect(queued[0]?.input).toEqual({ url: 'https://tiendita.example', extraUrls: [], followDemoLinks: 2 });
  });

  it('names Lyria 3 Pro in music.md when the track that was chosen is the one Lyria 3 Pro made', async () => {
    // The Lyria 3.5 track is at the wrong tempo; the Lyria 3 Pro one passes, so nothing more is asked for.
    answerByModel({ 'lyria-3.5': track(140, -6), 'lyria-3-pro-preview': track(113, -6) });
    const run = await captureAndPreview(id);
    await actAsVm(run, id, 'render', 0, null, RENDERED);
    expect(await run.returnValue).toEqual({ status: 'delivered', files: ALL_FILES, warnings: [] });

    expect([...fakes.music.models].sort()).toEqual(['lyria-3-pro-preview', 'lyria-3.5']);
    const render = (await tasks(fakes.store, id)).find((t) => t.kind === 'render')?.input as RenderInput;
    expect(render.music?.path).toBe(`orders/${id}/music/cand-2.wav`);
    const note = await text(`orders/${id}/out/music.md`);
    expect(note).toContain('made for this video by Google Lyria 3 Pro, an AI music model');
    expect(note).not.toContain('3.5');
    // The watermark and the use of the track are the same whichever model made it.
    expect(note).toContain('SynthID');
    expect(note).toContain('paid ads');
  });

  it('names Lyria 3.5 in music.md when the track that was chosen is the third candidate, asked for after the other two did not pass', async () => {
    // The first two (one of each model) are at the wrong tempo; the third, a Lyria 3.5, is the one that passes.
    fakes.music.queue = [track(140, -6), track(140, -6), track(113, -6)];
    const run = await captureAndPreview(id);
    await actAsVm(run, id, 'render', 0, null, RENDERED);
    expect(await run.returnValue).toEqual({ status: 'delivered', files: ALL_FILES, warnings: [] });

    expect([...fakes.music.models.slice(0, 2)].sort()).toEqual(['lyria-3-pro-preview', 'lyria-3.5']);
    expect(fakes.music.models[2]).toBe('lyria-3.5');
    const render = (await tasks(fakes.store, id)).find((t) => t.kind === 'render')?.input as RenderInput;
    expect(render.music?.path).toBe(`orders/${id}/music/cand-3.wav`);
    const note = await text(`orders/${id}/out/music.md`);
    expect(note).toContain('made for this video by Google Lyria 3.5, an AI music model');
    expect(note).not.toContain('3 Pro');
  });

  it('rents the VM with a script that carries the order permit, and keeps only its hash', async () => {
    const before = rentals();
    const run = await start(orderWorkflow, [id]);
    await waitForHook(run, { token: taskToken(id, 'capture', 0) });
    expect(rentals()).toBe(before + 1);
    const script = fakes.buy.vmRentals.at(-1)?.script ?? '';
    const permit = /K='([A-Za-z0-9_-]+)'/.exec(script)?.[1] ?? '';
    const order = await fakes.store.getOrder(id);
    expect(order?.vmTokenHash).toBe(vmTokenHash(permit));
    expect(order?.vmTokenExpiresAt?.getTime()).toBeGreaterThan(Date.now() + 70 * 60_000);
    expect(script).toContain('API_BASE=https://ad-video-agent.test');
    expect(script).toContain('codeload.github.com/ruizemanuel/ad-video-agent/tar.gz/0123456789abcdef0123456789abcdef01234567');
    await timeOut(run, id, 'capture');
    await run.returnValue;
    // The permit is in the VM's script and nowhere else: not in what any step was given or gave back. (The log is read
    // back into values, as the order id in it shows.)
    const log = await runLog(run.runId);
    expect(log).toContain(id);
    expect(permit.length).toBeGreaterThan(20);
    expect(log).not.toContain(permit);
  });

  it('keeps a permit the order already has, and does not pay again: nothing went out, so it is refunded', async () => {
    // What an earlier run of the paying step leaves when it died before anything was signed.
    const first = 'f'.repeat(64);
    await fakes.store.setVmToken(id, first, new Date(Date.now() + 75 * 60_000));
    const before = rentals();
    const run = await start(orderWorkflow, [id]);
    expect(await run.returnValue).toEqual({ status: 'refunded', reason: 'vm-payment-failed' });
    expect(rentals()).toBe(before);
    expect((await fakes.store.getOrder(id))?.vmTokenHash).toBe(first);
    expect(await stepOutput(run.runId, 'payVm')).toEqual({ status: 'uncertain', pollUrl: null });
    expect(await tasks(fakes.store, id)).toEqual([]);
  });

  it('keeps a permit the order already has when its payment went out, and uses the VM that boots with it once the chain says it was paid', async () => {
    // What an earlier run of the paying step leaves when it died after the authorization went out.
    const first = 'e'.repeat(64);
    await fakes.store.setVmToken(id, first, new Date(Date.now() + 75 * 60_000));
    const key = `${id}:vm`;
    const authorization = { from: `0x${'fa'.repeat(20)}`, nonce: `0x${'ab'.repeat(32)}`, validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 300) };
    await fakes.store.insertPaymentIntent({ key, orderId: id, kind: 'vm', maxAtomic: 70_000n });
    await fakes.store.updatePayment(key, { status: 'uncertain', asset: USDT, amount: 67_011n, payTo: BUY_PAY_TO, authorization });
    fakes.buy.consumed(authorization.nonce, { to: BUY_PAY_TO, value: 67_011n });
    const before = rentals();
    const run = await start(orderWorkflow, [id]);
    await timeOut(run, id, 'capture');
    expect(await run.returnValue).toEqual({ status: 'refunded', reason: 'vm-timeout' });
    expect(rentals()).toBe(before);
    expect((await fakes.store.getOrder(id))?.vmTokenHash).toBe(first);
    expect(await kinds(id)).toEqual(['capture:0', 'shutdown:0']);
  });

  it('delivers only the muted MP4 and claims.md when audio is none, without asking for music', async () => {
    const silent = await paidOrder(fakes.store, { audio: 'none' });
    const calls = fakes.music.calls;
    const run = await captureAndPreview(silent);
    await actAsVm(run, silent, 'render', 0, null, RENDERED_MUTED);
    expect(await run.returnValue).toEqual({ status: 'delivered', files: MUTED_FILES, warnings: [] });
    expect(fakes.music.calls).toBe(calls);
    const render = (await tasks(fakes.store, silent)).find((t) => t.kind === 'render')?.input as RenderInput;
    expect(render).toEqual({ edl: edlShop, hook: 0, format: '9x16', music: null });
    expect((await fakes.store.getOrder(silent))?.steps.music).toBe('skipped');
  });

  it('delivers without music, and says so, when Lyria gives no track: music alone never refunds an order', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fakes.music.failAt = Array.from({ length: 20 }, (_, k) => k + 1);
    const run = await captureAndPreview(id);
    await actAsVm(run, id, 'render', 0, null, RENDERED_MUTED);
    expect(await run.returnValue).toEqual({ status: 'delivered', files: MUTED_FILES, warnings: ['music_unavailable'] });
    expect((await fakes.store.getOrder(id))?.steps.music).toBe('failed');
    // Each of the first two candidates is tried twice; the third, asked for when they give nothing, once.
    expect(fakes.music.calls).toBe(5);
    // A candidate tried again asks for the same model (two of each in the first four calls), and the third is a Lyria 3.5.
    expect([...fakes.music.models.slice(0, 4)].sort()).toEqual(['lyria-3-pro-preview', 'lyria-3-pro-preview', 'lyria-3.5', 'lyria-3.5']);
    expect(fakes.music.models[4]).toBe('lyria-3.5');
    // Why no track passed is for whoever looks into the order, in the log, with the model of each candidate.
    expect(warn).toHaveBeenCalledWith('[music_rejected]', id, expect.stringContaining('"reason":"failed"'));
    const logged = JSON.parse(String(warn.mock.calls.find(([tag]) => tag === '[music_rejected]')?.[2]));
    expect(logged).toEqual([
      { index: 1, model: 'lyria-3.5', reason: 'failed', detail: 'Error' },
      { index: 2, model: 'lyria-3-pro-preview', reason: 'failed', detail: 'Error' },
      { index: 3, model: 'lyria-3.5', reason: 'failed', detail: 'Error' },
    ]);
    expect((await tasks(fakes.store, id)).find((t) => t.kind === 'render')?.input).toMatchObject({ edl: edlShop, music: null });
  });

  it('delivers without music, and says so, when the render could not add the track', async () => {
    const run = await captureAndPreview(id);
    await actAsVm(run, id, 'render', 0, null, RENDERED_MUTED);
    expect(await run.returnValue).toEqual({ status: 'delivered', files: MUTED_FILES, warnings: ['music_unavailable'] });
    expect((await fakes.store.getOrder(id))?.steps.music).toBe('failed');
  });

  it('corrects what the review blocks on, makes key frames of the correction and delivers the corrected edit list', async () => {
    // The first review finds the ad would do for any brand; the review of the corrected key frames does not.
    fakes.llm.review = async ({ frames }) => ({
      review: {
        frames: frames.map((_, k) => ({ frame: k + 1, legible: true, cutMidLetter: false, issues: [] })),
        logoSwap: { generic: fakes.llm.calls.review === 1, reason: 'Any shop could say this.' },
      },
      usd: 0.2,
    });
    const corrected: Edl = { ...edlShop, body: edlShop.body.map((scene, k) => (k === 1 ? { ...scene, lines: [{ text: '0% de comisión en tus ventas.', kind: 'claim', claimId: 'c3' }] } : scene)) };
    fakes.llm.fixed = corrected;
    const run = await captureAndPreview(id);
    await actAsVm(run, id, 'keyframes', 1, passingKeyframes(corrected, siteShop), { ok: true, stills: KEYFRAMES.stills.length });
    await actAsVm(run, id, 'render', 0, null, RENDERED);
    expect(await run.returnValue).toEqual({ status: 'delivered', files: ALL_FILES, warnings: [] });

    // The problem with the whole ad went to the corrector, and its fix was judged before it was used.
    expect(fakes.llm.lastPatchInput?.problems).toEqual([{ where: 'all', rule: 'visual', detail: expect.stringContaining('logo-swap') }]);
    expect(fakes.llm.lastJudgeInput).toEqual(judgeItems(corrected));
    const queued = await tasks(fakes.store, id);
    expect(queued.map((t) => `${t.kind}:${t.round}`)).toEqual(['capture:0', 'keyframes:0', 'keyframes:1', 'render:0', 'shutdown:0']);
    expect(queued[2]?.input).toEqual({ edl: corrected, hook: 0, format: '9x16', round: 1 });
    const render = queued[3]?.input as RenderInput;
    expect(render.edl).toEqual(retimeForBpm(corrected, render.edl.bpm));
    expect(await text(`orders/${id}/out/claims.md`)).toBe(claimsMarkdown(corrected, siteShop));
  });

  it('renders without music, and says so, when a correction makes the video outlast the track: music never refunds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fakes.llm.review = async ({ frames }) => ({
      review: {
        frames: frames.map((_, k) => ({ frame: k + 1, legible: true, cutMidLetter: false, issues: [] })),
        logoSwap: { generic: fakes.llm.calls.review === 1, reason: 'Any shop could say this.' },
      },
      usd: 0.2,
    });
    // Every body scene two beats or more longer: about 4 s more than the video the music was made for.
    const longer: Edl = { ...edlShop, body: edlShop.body.map((scene) => ({ ...scene, beats: 8 })) };
    fakes.llm.fixed = longer;
    const run = await captureAndPreview(id);
    await actAsVm(run, id, 'keyframes', 1, passingKeyframes(longer, siteShop), { ok: true, stills: KEYFRAMES.stills.length });
    await actAsVm(run, id, 'render', 0, null, RENDERED_MUTED);
    expect(await run.returnValue).toEqual({ status: 'delivered', files: MUTED_FILES, warnings: ['music_unavailable'] });
    const render = (await tasks(fakes.store, id)).find((t) => t.kind === 'render')?.input;
    expect(render).toEqual({ edl: longer, hook: 0, format: '9x16', music: null });
    expect((await fakes.store.getOrder(id))?.steps.music).toBe('failed');
    expect(warn).toHaveBeenCalledWith('[music_too_short]', id);
  });

  it('logs what the review remarks without blocking on it, and keeps it from the client', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fakes.llm.review = async ({ frames }) => ({
      review: {
        frames: frames.map((_, k) => ({ frame: k + 1, legible: true, cutMidLetter: false, issues: k === 0 ? ['The headline sits close to the top edge.'] : [] })),
        logoSwap: { generic: false, reason: 'It shows the shop itself.' },
      },
      usd: 0.2,
    });
    const run = await captureAndPreview(id);
    await actAsVm(run, id, 'render', 0, null, RENDERED);
    expect(await run.returnValue).toEqual({ status: 'delivered', files: ALL_FILES, warnings: [] });
    expect(warn).toHaveBeenCalledWith('[review_warning]', id, 'hooks[0][0]: The headline sits close to the top edge.');
  });

  it('goes on with the VM once the chain says the uncertain VM payment settled', async () => {
    scenario({ buy: 'ambiguous', settled: 'settled' });
    const run = await start(orderWorkflow, [id]);
    await timeOut(run, id, 'capture');
    expect(await run.returnValue).toEqual({ status: 'refunded', reason: 'vm-timeout' });
    expect(await kinds(id)).toEqual(['capture:0', 'shutdown:0']);
    // Why buy's answer was not clear stays in the payment record: the run's log keeps only the status (and the tracking URL).
    expect(await stepOutput(run.runId, 'payVm')).toEqual({ status: 'uncertain', pollUrl: null });
  });

  it('keeps the tracking URL of a paid VM in the paying step\'s output, and nothing else', async () => {
    const run = await start(orderWorkflow, [id]);
    await timeOut(run, id, 'capture');
    await run.returnValue;
    expect(await stepOutput(run.runId, 'payVm')).toEqual({ status: 'paid', pollUrl: expect.stringMatching(/^https:\/\/usebuy\.ai\/google\/vm\//) });
  });

  it('takes the order back when a try of its first step failed after taking it and a reconciliation recorded another run', async () => {
    vi.spyOn(fakes.store, 'getOrder').mockImplementationOnce(async () => {
      // The first try moved the order; then a reconciliation overwrote its run id, and the store failed this read.
      await fakes.store.setRunId(id, 'wrun_reconciliation');
      throw new Error('The store did not answer.');
    });
    const run = await start(orderWorkflow, [id]);
    await timeOut(run, id, 'capture');
    expect(await run.returnValue).toEqual({ status: 'refunded', reason: 'vm-timeout' });
    expect((await fakes.store.getOrder(id))?.runId).toBe(run.runId);
  });

  it('ends a delivered order as delivered when the delivery step fails after its delivery', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const setStep = fakes.store.setStep.bind(fakes.store);
    vi.spyOn(fakes.store, 'setStep').mockImplementation(async (orderId, name, state) => {
      if (name === 'delivery' && state === 'done') throw new Error('The store did not answer.');
      return setStep(orderId, name, state);
    });
    const prepares = fakes.refunds.prepareCalls;
    const run = await captureAndPreview(id);
    await actAsVm(run, id, 'render', 0, null, RENDERED);
    expect(await run.returnValue).toEqual({ status: 'delivered', files: ALL_FILES, warnings: [] });
    expect((await fakes.store.getOrder(id))?.status).toBe('delivered');
    expect(fakes.refunds.prepareCalls).toBe(prepares);
    expect(error.mock.calls.filter(([first]) => first === '[refund_failed]')).toEqual([]);
    expect(await kinds(id)).toEqual(['capture:0', 'keyframes:0', 'render:0', 'shutdown:0']);
  });
});

describe('an order that is refunded', () => {
  // The refund is the amount paid, in the token paid, to the address that paid.
  const refunded = async (orderId: string, reason: string) => {
    expect(fakes.refunds.lastPrepare).toEqual({ to: PAYER, asset: USDT, amount: PRICE });
    const order = await fakes.store.getOrder(orderId);
    expect(order).toMatchObject({ status: 'refunded', failureReason: reason, deliverables: [] });
    expect(order?.steps.refund).toBe('done');
    expect((await fakes.store.getRefund(orderId))?.status).toBe('confirmed');
  };

  it('refunds when the VM payment was uncertain and did not settle, without any VM task', async () => {
    scenario({ buy: 'ambiguous', settled: 'unsettled' });
    const run = await start(orderWorkflow, [id]);
    // The authorization is unspent, and buy may still spend it until it expires: the run waits for that, and asks again.
    const wait = await waitForSleep(run);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 7 * 60_000, shouldAdvanceTime: true });
    try {
      await getRun(run.runId).wakeUp({ correlationIds: [wait] });
      expect(await run.returnValue).toEqual({ status: 'refunded', reason: 'vm-payment-failed' });
    } finally {
      vi.useRealTimers();
    }
    expect(await tasks(fakes.store, id)).toEqual([]);
    await refunded(id, 'vm-payment-failed');
    expect((await fakes.store.getOrder(id))?.steps.vm).toBe('failed');
  });

  it('refunds, without waiting forever, when the chain cannot tell whether the uncertain VM payment settled', async () => {
    scenario({ buy: 'ambiguous', settled: 'unknown' });
    const run = await start(orderWorkflow, [id]);
    const outcome = run.returnValue;
    let woken = 0;
    for (let settled = false; !settled; ) {
      const next = await Promise.race([waitForSleep(run, { timeout: 5_000 }).catch(() => null), outcome.then(() => null)]);
      if (next === null) settled = true;
      else {
        woken += 1;
        await getRun(run.runId).wakeUp({ correlationIds: [next] });
      }
    }
    expect(await outcome).toEqual({ status: 'refunded', reason: 'vm-payment-failed' });
    expect(woken).toBeGreaterThan(1);
    expect(woken).toBeLessThanOrEqual(20);
    // The VM may exist after all: it is told to stop, which costs nothing.
    expect(await kinds(id)).toEqual(['shutdown:0']);
  });

  it('refunds when buy will not rent a VM, without any VM task', async () => {
    scenario({ buy: 'rejected' });
    expect(await (await start(orderWorkflow, [id])).returnValue).toEqual({ status: 'refunded', reason: 'vm-unavailable' });
    expect(await tasks(fakes.store, id)).toEqual([]);
    await refunded(id, 'vm-unavailable');
  });

  it('refunds when the VM never reports the capture, and shuts the VM down', async () => {
    const run = await start(orderWorkflow, [id]);
    await timeOut(run, id, 'capture');
    expect(await run.returnValue).toMatchObject({ status: 'refunded', reason: 'vm-timeout' });
    expect(await kinds(id)).toEqual(['capture:0', 'shutdown:0']);
    await refunded(id, 'vm-timeout');
    expect((await fakes.store.getOrder(id))?.steps.capture).toBe('failed');
  });

  it('refunds a blocked site', async () => {
    const run = await start(orderWorkflow, [id]);
    await actAsVm(run, id, 'capture', 0, null, { ok: false, code: 'blocked', message: 'The site answered with a challenge page.' });
    expect(await run.returnValue).toEqual({ status: 'refunded', reason: 'site-blocked' });
    expect(await kinds(id)).toEqual(['capture:0', 'shutdown:0']);
    await refunded(id, 'site-blocked');
  });

  it('refunds a capture that failed otherwise', async () => {
    const run = await start(orderWorkflow, [id]);
    await actAsVm(run, id, 'capture', 0, null, { ok: false, code: 'unreachable', message: 'The site did not answer.' });
    expect(await run.returnValue).toEqual({ status: 'refunded', reason: 'capture' });
  });

  it('refunds when the VM can reach the metadata server', async () => {
    const run = await start(orderWorkflow, [id]);
    await actAsVm(run, id, 'capture', 0, captureShop(), { ...CAPTURED, metadataBlocked: false });
    expect(await run.returnValue).toEqual({ status: 'refunded', reason: 'vm-isolation' });
    expect(await kinds(id)).toEqual(['capture:0', 'shutdown:0']);
  });

  it('refunds when the script cannot be made to pass the checks', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fakes.llm.alwaysBad = true;
    const run = await start(orderWorkflow, [id]);
    await actAsVm(run, id, 'capture', 0, captureShop(), CAPTURED);
    expect(await run.returnValue).toEqual({ status: 'refunded', reason: 'script' });
    expect(await kinds(id)).toEqual(['capture:0', 'shutdown:0']);
    expect((await fakes.store.getOrder(id))?.steps.script).toBe('failed');
    expect(warn).toHaveBeenCalledWith('[script_failed]', id, 'validation');
  });

  it('refunds after two blocking review rounds, with key frames for rounds 0, 1 and 2', async () => {
    scenario({ review: 'always-cut' });
    const run = await captureAndPreview(id);
    for (const round of [1, 2]) await actAsVm(run, id, 'keyframes', round, KEYFRAMES, { ok: true, stills: KEYFRAMES.stills.length });
    expect(await run.returnValue).toEqual({ status: 'refunded', reason: 'quality' });
    expect(await kinds(id)).toEqual(['capture:0', 'keyframes:0', 'keyframes:1', 'keyframes:2', 'shutdown:0']);
    expect((await fakes.store.getOrder(id))?.steps.review).toBe('failed');
  });

  it('logs why each correction could not be used, in ids and rules only, and keeps the step output to the status', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    scenario({ review: 'always-cut' });
    // The corrector rewrites every scene the review blocked on, and puts a number its quote does not have in body[1].
    const bad: Edl = {
      ...edlShop,
      body: edlShop.body.map((scene, k) => (k === 1 ? { ...scene, lines: scene.lines.map((line, n) => (n === 0 ? { ...line, text: `${line.text} 99` } : line)) } : scene)),
    };
    fakes.llm.fixed = bad;
    const run = await captureAndPreview(id);
    expect(await run.returnValue).toEqual({ status: 'refunded', reason: 'quality' });
    expect(fakes.llm.calls).toMatchObject({ patchEdl: 2, judge: 1 });

    const lines = warn.mock.calls.filter(([tag]) => tag === '[correction_unusable]');
    expect(lines).toHaveLength(2);
    for (const [, orderId, why] of lines) {
      expect(orderId).toBe(id);
      expect(why).toMatch(/^checks body\[1\]\.lines\[0\]:number-mismatch \| patched hooks\[0\]\[0\]:KineticHeadline,.*body\[0\]:UiFocus s4-mobile#1,.*cta:EndCard$/);
      // Nothing the site, the model or the review wrote: no detail, no caption.
      const said = [...validateEdl(bad, siteShop).map((p) => p.detail), ...(fakes.llm.lastPatchInput?.problems ?? []).map((p) => p.detail), bad.body[1]!.lines[0]!.text];
      for (const text of said) expect(why).not.toContain(text);
      expect(why).not.toContain('"');
    }
    expect(await stepOutput(run.runId, 'correctForReview')).toEqual({ status: 'unusable' });
  });

  it('does not try a correction the order cannot afford, and refunds', async () => {
    const silent = await paidOrder(fakes.store, { audio: 'none' });
    // With the VM, the director, the judge and the first review, a round of corrections no longer fits under the cap.
    await fakes.store.addCost(silent, 'test:spent', 1.8, 'card');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    scenario({ review: 'always-cut' });
    const run = await captureAndPreview(silent);
    expect(await run.returnValue).toEqual({ status: 'refunded', reason: 'quality' });
    expect(fakes.llm.calls).toMatchObject({ review: 1, patchEdl: 0 });
    expect(warn).toHaveBeenCalledWith('[review_over_budget]', silent);
    expect(await kinds(silent)).toEqual(['capture:0', 'keyframes:0', 'shutdown:0']);
  });

  it('refunds when the key frames file is not what the VM writes, without asking the corrector', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const run = await start(orderWorkflow, [id]);
    await actAsVm(run, id, 'capture', 0, captureShop(), CAPTURED);
    await actAsVm(run, id, 'keyframes', 0, { stills: 'none' }, { ok: true, stills: 0 });
    expect(await run.returnValue).toEqual({ status: 'refunded', reason: 'quality' });
    expect(fakes.llm.calls).toMatchObject({ review: 0, patchEdl: 0 });
    expect(error).toHaveBeenCalledWith('[review_failed]', id, 0, 'keyframes-invalid');
  });

  it('refunds when the VM never reports the key frames', async () => {
    const run = await start(orderWorkflow, [id]);
    await actAsVm(run, id, 'capture', 0, captureShop(), CAPTURED);
    await timeOut(run, id, 'keyframes', 0, 1);
    expect(await run.returnValue).toEqual({ status: 'refunded', reason: 'vm-timeout' });
  });

  it('refunds when the render fails', async () => {
    const run = await captureAndPreview(id);
    await actAsVm(run, id, 'render', 0, null, { ok: false, code: 'error', message: 'ffmpeg failed.' });
    expect(await run.returnValue).toEqual({ status: 'refunded', reason: 'render' });
    expect(await kinds(id)).toEqual(['capture:0', 'keyframes:0', 'render:0', 'shutdown:0']);
    expect((await fakes.store.getOrder(id))?.steps.render).toBe('failed');
  });
});

describe('one run per order', () => {
  it('lets one run own an order: a second one while it runs, or after it ended, does nothing', async () => {
    const first = await start(orderWorkflow, [id]);
    await waitForHook(first, { token: taskToken(id, 'capture', 0) });
    const before = { rentals: rentals(), prepares: fakes.refunds.prepareCalls };

    // While the first run owns the order.
    const second = await start(orderWorkflow, [id]);
    expect(await second.returnValue).toEqual({ status: 'duplicate', runId: first.runId });

    // After it ended: the order is no longer one to start.
    await timeOut(first, id, 'capture');
    expect(await first.returnValue).toMatchObject({ status: 'refunded' });
    const prepares = fakes.refunds.prepareCalls;
    const third = await start(orderWorkflow, [id]);
    expect(await third.returnValue).toEqual({ status: 'duplicate', runId: first.runId });

    expect(rentals()).toBe(before.rentals);
    expect(fakes.refunds.prepareCalls).toBe(prepares);
    expect(prepares).toBe(before.prepares + 1);
    expect(await kinds(id)).toEqual(['capture:0', 'shutdown:0']);
    expect((await fakes.store.getOrder(id))?.status).toBe('refunded');
  });
});
