import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KeyframesFile, Still, TaskEnvelope } from '@app/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyframesTask } from '../src/render/keyframes';
import { fixtureEdl, fixtureSite, writeCapturedSite } from './support/edl';

const TARGET = 'https://store.example/orders/o1/keyframes-0.json?signature=SECRET';

const still = (index: number): Still => ({
  index,
  role: index === 0 ? 'hook' : 'body',
  piece: 'KineticHeadline',
  frame: 52 + index,
  path: index === 0 ? 'hooks[0][0]' : `body[${index - 1}]`,
  text: [],
  jpegBase64: 'AAEC',
});

const task = (input: unknown, urls: Record<string, string> = { keyframesJson: TARGET }): TaskEnvelope => ({ id: 't1', kind: 'keyframes', input, urls });
const input = (extra: Record<string, unknown> = {}) => ({ edl: fixtureEdl(), hook: 0, format: '9x16', round: 0, ...extra });

describe('keyframesTask', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'keyframes-task-'));
    writeCapturedSite(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const deps = (stills: Still[] = [still(0), still(1), still(2)]) => ({
    renderKeyframes: vi.fn(async (_options: unknown): Promise<Still[]> => stills),
    upload: vi.fn(async (_url: string, _body: string | Uint8Array | Blob, _type: string): Promise<void> => {}),
  });

  it('renders the key frames of the hook, with the site that was captured, and uploads them as the file the flow reads', async () => {
    const d = deps();

    const result = await keyframesTask(task(input()), dir, d);

    expect(result).toEqual({ ok: true, stills: 3 });
    expect(d.renderKeyframes).toHaveBeenCalledTimes(1);
    expect(d.renderKeyframes).toHaveBeenCalledWith({ edl: fixtureEdl(), site: fixtureSite(), runDir: dir, format: '9x16', hook: 0 });
    expect(d.upload).toHaveBeenCalledTimes(1);
    const [url, body, type] = d.upload.mock.calls[0] ?? [];
    expect(url).toBe(TARGET);
    expect(type).toBe('application/json');
    expect(JSON.parse(String(body))).toEqual({ stills: [still(0), still(1), still(2)] } satisfies KeyframesFile);
  });

  it('refuses, before rendering anything, a task without a place to put the key frames', async () => {
    const d = deps();

    await expect(keyframesTask(task(input(), {}), dir, d)).rejects.toThrow(/place to put/);

    expect(d.renderKeyframes).not.toHaveBeenCalled();
    expect(d.upload).not.toHaveBeenCalled();
  });

  it.each([
    ['has no edit list', { edl: undefined }],
    ['has an edit list that is not one', { edl: { bpm: 'fast' } }],
    ['is not an object', 'edl'],
  ])('refuses, before rendering anything, a task that %s', async (_what, given) => {
    const d = deps();
    const body = typeof given === 'string' ? given : input(given);

    await expect(keyframesTask(task(body), dir, d)).rejects.toThrow(/edit list/);

    expect(d.renderKeyframes).not.toHaveBeenCalled();
  });

  it.each([
    ['another hook', { hook: 1 }],
    ['another format', { format: '16x9' }],
  ])('refuses %s: the first service renders the main hook in 9x16 only', async (_what, extra) => {
    const d = deps();

    await expect(keyframesTask(task(input(extra)), dir, d)).rejects.toThrow(/hook 0 in 9x16/);

    expect(d.renderKeyframes).not.toHaveBeenCalled();
  });

  it('says so, before rendering anything, when the capture is not on this VM', async () => {
    const d = deps();
    rmSync(join(dir, 'site.json'));

    await expect(keyframesTask(task(input()), dir, d)).rejects.toThrow(/no capture/);

    expect(d.renderKeyframes).not.toHaveBeenCalled();
  });

  it('uploads nothing when a frame cannot be rendered, and lets the failure through for the worker to report', async () => {
    const d = deps();
    d.renderKeyframes.mockRejectedValue(new Error('The key frame 52 came out without its text measured.'));

    await expect(keyframesTask(task(input()), dir, d)).rejects.toThrow(/without its text measured/);

    expect(d.upload).not.toHaveBeenCalled();
  });

  it('lets a failed upload through, so that the worker reports the task as failed', async () => {
    const d = deps();
    d.upload.mockRejectedValue(new Error('The upload was refused (HTTP 403).'));

    await expect(keyframesTask(task(input()), dir, d)).rejects.toThrow(/403/);
  });
});
