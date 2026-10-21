// The correction step of the review (correctOnce, the work of the flow's correctForReview step), on the doubles: what it
// gives back and the one line it logs when the correction cannot be used.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPatches, scenePaths, type Edl, type Problem } from '@app/core';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RetryableError } from 'workflow';
import { FileBlob } from '../src/adapters/fake/blob';
import { FakeLlm } from '../src/adapters/fake/llm';
import { FileStore } from '../src/adapters/fake/store';
import { ModelCallFailed, ModelOutputInvalid } from '../src/ports';
import { capturePath } from '../src/vm/tasks';
import { correctOnce } from '../src/workflows/order';
import { captureShop, edlShop as shopEdl } from './support/shop';

const edlShop = shopEdl();
const dir = await mkdtemp(join(tmpdir(), 'review-correction-'));
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
const store = new FileStore(dir);
const blob = new FileBlob(dir);
const CAP = 2.5;
// What the visual review blocked on.
const cut: Problem[] = [{ where: 'body[1]', rule: 'visual', detail: 'visual review: a letter is cut by an edge or a mask' }];

let orders = 0;
let id: string;
let llm: FakeLlm;
let warn: ReturnType<typeof vi.spyOn>;
const lines = (): unknown[][] => warn.mock.calls.filter(([tag]: unknown[]) => tag === '[correction_unusable]');
const correct = (lastTry: boolean) => correctOnce({ orderId: id, edl: edlShop, problems: cut, lastTry }, { store, blob, llm, spendCap: CAP });

beforeEach(async () => {
  orders += 1;
  id = `ord_correction${orders}`;
  llm = new FakeLlm();
  llm.fixed = edlShop;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await blob.put(capturePath(id), JSON.stringify(captureShop()), 'application/json');
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('correctOnce', () => {
  it('gives back the fix the code checks and the judge pass, and logs nothing', async () => {
    expect(await correct(false)).toEqual({ status: 'fixed', edl: edlShop });
    expect(lines()).toEqual([]);
  });

  it('says why the fix cannot be used, in one line', async () => {
    const scene = scenePaths(edlShop).find((p) => p.path === 'body[1]')!.scene;
    const bad: Edl = applyPatches(edlShop, [{ path: 'body[1]', scene: { ...scene, lines: scene.lines.map((line, k) => (k === 0 ? { ...line, text: `${line.text} 99` } : line)) } }], []);
    llm.fixed = bad;
    expect(await correct(false)).toEqual({ status: 'unusable' });
    expect(lines()).toEqual([['[correction_unusable]', id, 'checks body[1].lines[0]:number-mismatch | patched body[1]:KineticHeadline']]);
  });

  it('says the capture could not be read', async () => {
    await blob.put(capturePath(id), 'not json', 'application/json');
    expect(await correct(false)).toEqual({ status: 'unusable' });
    expect(lines()).toEqual([['[correction_unusable]', id, 'capture-unreadable']]);
  });

  it('asks again later for a model that may answer then, while the step has a try left, and logs nothing yet', async () => {
    llm.judge = async () => {
      throw new ModelCallFailed('judge', 'AI_APICallError', 529);
    };
    await expect(correct(false)).rejects.toBeInstanceOf(RetryableError);
    expect(lines()).toEqual([]);
  });

  it('says the correction cannot be used when the model is still busy on the step\'s last try', async () => {
    llm.judge = async () => {
      throw new ModelCallFailed('judge', 'AI_APICallError', 529);
    };
    expect(await correct(true)).toEqual({ status: 'unusable' });
    expect(lines()).toEqual([['[correction_unusable]', id, 'model judge:AI_APICallError:529']]);
    llm.patchEdl = async () => {
      throw new ModelCallFailed('patch', 'AI_RetryError');
    };
    expect(await correct(true)).toEqual({ status: 'unusable' });
    expect(lines()[1]).toEqual(['[correction_unusable]', id, 'model patch:AI_RetryError']);
  });

  it('says so at once for a call refused for good, or an answer of the judge that does not fit', async () => {
    llm.patchEdl = async () => {
      throw new ModelCallFailed('patch', 'AI_APICallError', 400);
    };
    expect(await correct(false)).toEqual({ status: 'unusable' });
    llm = new FakeLlm();
    llm.fixed = edlShop;
    llm.judge = async () => {
      throw new ModelOutputInvalid('The judge model did not answer with a valid judge.', 0.01);
    };
    expect(await correct(false)).toEqual({ status: 'unusable' });
    expect(lines()).toEqual([
      ['[correction_unusable]', id, 'model patch:AI_APICallError:400'],
      ['[correction_unusable]', id, 'model judge:ModelOutputInvalid'],
    ]);
  });

  it('lets any other failure go up, for the step to try again or to fail', async () => {
    llm.patchEdl = async () => {
      throw new Error('The corrector is down: "Precio secreto"');
    };
    await expect(correct(true)).rejects.toThrow('The corrector is down');
    expect(lines()).toEqual([]);
  });
});
