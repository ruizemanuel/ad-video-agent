import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { applyPatches, judgeItems, scenePaths, type Edl, type Problem, type Scene, type SiteData } from '@app/core';
import { FakeLlm } from '../src/adapters/fake/llm';
import { FileStore } from '../src/adapters/fake/store';
import { canAfford, EST } from '../src/pipeline/budget';
import { runScript } from '../src/pipeline/script';
import { siteForModel } from '../src/pipeline/site-for-model';
import { ModelOutputInvalid } from '../src/ports';
import { captureShop, edlShop as shopEdl, siteShop } from './support/shop';

const edlShop = shopEdl();

const dir = await mkdtemp(join(tmpdir(), 'script-'));
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
const store = new FileStore(dir);
const CAP = 2.5;

// The scene at `path`, changed.
const withScene = (edl: Edl, path: string, change: (scene: Scene) => Scene): Edl => {
  const scene = scenePaths(edl).find((p) => p.path === path)?.scene;
  if (!scene) throw new Error(`no scene at ${path}`);
  return applyPatches(edl, [{ path, scene: change(scene) }], []);
};
// The scene at `path` with a number on its first line that the quote of its claim does not have.
const withBadNumber = (edl: Edl, path: string): Edl =>
  withScene(edl, path, (scene) => ({ ...scene, lines: scene.lines.map((line, k) => (k === 0 ? { ...line, text: `${line.text} 99` } : line)) }));
const withQuote = (edl: Edl, id: string, quote: string): Edl => ({ ...edl, claims: edl.claims.map((c) => (c.id === id ? { ...c, quote } : c)) });

let orders = 0;
let id: string;
let llm: FakeLlm;
let args: Parameters<typeof runScript>[0];
const patchProblems = (): Problem[] => llm.lastPatchInput?.problems ?? [];

beforeEach(() => {
  orders += 1;
  id = `ord_script${orders}`;
  llm = new FakeLlm();
  llm.edl = edlShop;
  // What the corrector takes its fixes from: the scenes and claims of the clean edit list.
  llm.fixed = edlShop;
  args = { orderId: id, capture: captureShop(), deps: { store, llm, spendCap: CAP } };
});

describe('runScript', () => {
  it('accepts a clean EDL with one director call and one judge call', async () => {
    expect(await runScript(args)).toEqual({ ok: true, edl: edlShop });
    expect(llm.calls).toMatchObject({ writeEdl: 1, judge: 1, patchEdl: 0 });
  });

  it('gives the director the site, its phone pictures and the brief', async () => {
    await runScript({ ...args, brief: 'Para emprendedores que venden por WhatsApp' });
    expect(llm.lastWriteInput).toEqual({ site: siteShop(), images: captureShop().directorImages, brief: 'Para emprendedores que venden por WhatsApp' });
  });

  it('gives the judge the claims and the framing lines of the edit list', async () => {
    await runScript(args);
    expect(llm.lastJudgeInput).toEqual(judgeItems(edlShop));
  });

  it('patches only the scene with the problem', async () => {
    llm.edl = withBadNumber(edlShop, 'body[1]');
    expect(await runScript(args)).toEqual({ ok: true, edl: edlShop });
    expect(patchProblems().map((p) => [p.where.split('.')[0], p.rule])).toEqual([['body[1]', 'number-mismatch']]);
  });

  it('asks the judge only once the code finds nothing', async () => {
    llm.edl = withBadNumber(edlShop, 'body[1]');
    await runScript(args);
    expect(llm.calls).toMatchObject({ writeEdl: 1, patchEdl: 1, judge: 1 });
  });

  it('gives the corrector the edit list it is fixing and the site, with no pictures', async () => {
    const bad = withBadNumber(edlShop, 'body[1]');
    llm.edl = bad;
    await runScript(args);
    expect(llm.lastPatchInput).toEqual({ edl: bad, problems: patchProblems(), site: siteShop() });
  });

  it('fails a framing line that asserts a product fact', async () => {
    llm.framingVerdicts = { 'hooks[0][0]:framing:0': true };
    await runScript(args);
    expect(patchProblems()[0]?.rule).toBe('framing-asserts');
  });

  it('names the line of a framing problem, so its scene path comes first', async () => {
    llm.framingVerdicts = { 'hooks[0][0]:framing:0': true };
    await runScript(args);
    expect(patchProblems()).toEqual([{ where: 'hooks[0][0].lines[0]', rule: 'framing-asserts', detail: expect.stringContaining('¿Cuánto te cobran') }]);
  });

  it('fails a claim the judge does not find in its quote, naming its scene and its claim', async () => {
    llm.claimVerdicts = { 'body[1]:c3': false };
    await runScript(args);
    expect(patchProblems()).toEqual([{ where: 'body[1]', rule: 'not-equivalent', detail: expect.stringContaining('c3') }]);
  });

  it('fails every item the judge gave no verdict for', async () => {
    llm.judge = async () => ({ verdicts: [], framing: [], usd: 0.01 });
    await runScript(args);
    const items = judgeItems(edlShop);
    const rules = patchProblems().map((p) => p.rule);
    expect(rules.filter((r) => r === 'not-equivalent')).toHaveLength(items.claims.length);
    expect(rules.filter((r) => r === 'framing-asserts')).toHaveLength(items.framing.length);
    expect(rules).toHaveLength(items.claims.length + items.framing.length);
  });

  it('passes a claim whose quote is not on the site to the corrector, which fixes the claim', async () => {
    llm.edl = withQuote(edlShop, 'c3', '0% de comisión siempre');
    expect(await runScript(args)).toEqual({ ok: true, edl: edlShop });
    expect(patchProblems()).toEqual([{ where: 'edl', rule: 'quote-missing', detail: expect.stringContaining('claim c3') }]);
  });

  it('gives up after two patch rounds', async () => {
    llm.alwaysBad = true;
    expect(await runScript(args)).toEqual({ ok: false, reason: 'validation' });
    expect(llm.calls.patchEdl).toBe(2);
    expect(llm.calls.judge).toBe(3);
  });

  it('counts a patch for a scene that does not exist as a failed round', async () => {
    llm.edl = withBadNumber(edlShop, 'body[1]');
    llm.patchEdl = async () => ({ patches: [{ path: 'body[9]', scene: edlShop.cta }], claimFixes: [], usd: 0.05 });
    expect(await runScript(args)).toEqual({ ok: false, reason: 'validation' });
    expect(llm.calls.patchEdl).toBe(2);
  });

  it('counts a corrector answer that does not fit its schema as a failed round, and records what it cost', async () => {
    llm.edl = withBadNumber(edlShop, 'body[1]');
    llm.patchEdl = async () => {
      throw new ModelOutputInvalid('The corrector did not answer with valid patches.', 0.04);
    };
    expect(await runScript(args)).toEqual({ ok: false, reason: 'validation' });
    expect(llm.calls.patchEdl).toBe(2);
    expect(await store.orderCost(id)).toBeCloseTo(llm.usd.writeEdl + 0.04 * 2, 6);
  });

  it('fails when the director does not answer with an edit list, and records what the call cost', async () => {
    llm.writeEdl = async () => {
      throw new ModelOutputInvalid('The director did not answer with a valid edit list.', 0.18);
    };
    await expect(runScript(args)).rejects.toThrow(ModelOutputInvalid);
    expect(await store.orderCost(id)).toBe(0.18);
  });

  it('lets any other failure of a model through, without patching', async () => {
    llm.judge = async () => {
      throw new Error('The gateway is down.');
    };
    await expect(runScript(args)).rejects.toThrow('The gateway is down.');
    expect(llm.calls.patchEdl).toBe(0);
  });

  it('does not patch when the budget would be passed', async () => {
    await store.addCost(id, 'x', 2.45, 'card');
    llm.edl = withBadNumber(edlShop, 'body[1]');
    expect(await runScript(args)).toEqual({ ok: false, reason: 'budget' });
    expect(llm.calls.patchEdl).toBe(0);
  });

  it('patches when the patch and the judge after it still fit under the cap exactly', async () => {
    // After the director, the order has spent the cap less a patch and a judge.
    await store.addCost(id, 'x', CAP - llm.usd.writeEdl - (EST.patch + EST.judge), 'card');
    llm.edl = withBadNumber(edlShop, 'body[1]');
    expect(await runScript(args)).toEqual({ ok: true, edl: edlShop });
  });

  it('records every model cost on the order', async () => {
    llm.edl = withBadNumber(edlShop, 'body[1]');
    await runScript(args);
    expect(await store.orderCost(id)).toBeCloseTo(llm.usd.writeEdl + llm.usd.patchEdl + llm.usd.judge, 6);
  });
});

describe('siteForModel', () => {
  const site = siteShop();

  it('gives the director the text of each section, with its id', () =>
    expect(siteForModel(site).sections).toEqual(site.sections.map(({ id: sectionId, heading, text, ctas }) => ({ id: sectionId, heading, text, ctas }))));

  it('gives the host that a TypeIn url has to type', () =>
    expect(siteForModel({ ...site, url: 'https://www.Tiendita.example/precios' }).host).toBe('tiendita.example'));

  it('numbers the boxes of each shot as boxIndex counts them', () => {
    const shots = siteForModel(site).shots;
    expect(shots.map((s) => [s.id, s.viewport, s.sectionId])).toEqual([
      ['s1-mobile', 'mobile', 's1'],
      ['s4-mobile', 'mobile', 's4'],
    ]);
    expect(shots[1]?.boxes).toEqual([
      { boxIndex: 0, kind: 'heading', sectionId: 's4', text: 'Mirá una tienda de ejemplo' },
      { boxIndex: 1, kind: 'image', sectionId: 's4', text: undefined },
      { boxIndex: 2, kind: 'cta', sectionId: 's4', text: 'Ver demo' },
    ]);
  });

  it('says "whole page" for a shot of no section', () => {
    const whole: SiteData = { ...site, shots: [{ id: 's0-full', file: 'media/s0-full.png', viewport: 'mobile', dpr: 2, width: 780, height: 6000 }] };
    expect(siteForModel(whole).shots[0]?.sectionId).toBe('whole page');
  });

  it('marks the sections of extra pages as imagery only, without their text', () => {
    const extra: SiteData = { ...site, extraSections: [{ id: 's5', heading: 'Demo', text: 'Probá la tienda.', ctas: [], page: 'https://tiendita.example/demo' }] };
    expect(siteForModel(extra).extraSections).toEqual([
      { id: 's5', heading: 'Demo', page: 'https://tiendita.example/demo', note: 'imagery only, not a claim source' },
    ]);
  });

  it('names the brand colors and fonts by role, and says whether there is a logo', () =>
    expect(siteForModel(site).brand).toEqual({
      colors: ['bg #f7f7f2', 'bg #ffffff', 'text #1f2a24', 'text #5b655f', 'primary #0b7a4b', 'accent #f4b942'],
      fonts: ['display: Plus Jakarta Sans'],
      hasLogo: true,
    }));

  it('leaves out the files, the font metrics and the capture log', () => {
    const view = JSON.stringify(siteForModel({ ...site, log: { startedAt: 'now', notes: ['secret note'], timings: {} } }));
    for (const left of ['media/', 'letterSpacingEm', 'secret note', 'recordings']) expect(view).not.toContain(left);
  });
});

describe('canAfford', () => {
  it('allows what fits under the cap exactly, with no float drift', () => {
    expect(canAfford(0.1, 0.2, 0.3)).toBe(true);
    expect(canAfford(2.37, EST.patch + EST.judge, 2.5)).toBe(true);
  });

  it('refuses what would pass the cap', () => expect(canAfford(2.45, EST.patch + EST.judge, 2.5)).toBe(false));

  it('estimates the next calls as measured in the quality test', () => expect(EST).toEqual({ patch: 0.1, judge: 0.03, review: 0.25, lyria: 0.08 }));
});
