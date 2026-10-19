// What the integration tests of the order workflow share: the fake service (the doubles over one temporary FAKE_DIR per
// test file, which the workflow's steps share with the test), a paid order seeded as the payment route leaves it, the
// VM played by the test, and the VM tasks the run queued.
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { layoutScenes, settledFrame, theme, timedScenePath, type Edl, type KeyframesFile, type SiteData, type VmTaskKind } from '@app/core';
import { waitForHook } from '@workflow/vitest';
import { vi } from 'vitest';
import { resumeHook, type Run } from 'workflow/api';
import { getAdapters } from '../../src/adapters';
import type { FileBlob } from '../../src/adapters/fake/blob';
import type { FakeBuy } from '../../src/adapters/fake/buy';
import type { FakeLlm } from '../../src/adapters/fake/llm';
import type { FakeMusic } from '../../src/adapters/fake/music';
import type { FakeRefunds } from '../../src/adapters/fake/refunds';
import type { FileStore } from '../../src/adapters/fake/store';
import type { OrderRequest, VmTask } from '../../src/ports';
import { capturePath, keyframesPath } from '../../src/vm/tasks';

export const USDT = '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e';
/** Who pays the orders: a made-up address, no real wallet. */
export const PAYER = '0x1234567890AbcdEF1234567890aBcdef12345678';
/** What a development order costs: 0.05 USDT. */
export const PRICE = 50_000n;

/**
 * The doubles the steps use: the very object getAdapters() hands out, so a test can also put a fresh double in it (a model
 * double per test, say) and the next step uses that one.
 */
export type Fakes = { store: FileStore; blob: FileBlob; buy: FakeBuy; llm: FakeLlm; music: FakeMusic; refunds: FakeRefunds };

/**
 * Sets up the fake service for one test file: the settings the steps read, and a FAKE_DIR of its own. `settings` adds to
 * or replaces the defaults. The settings and the adapters are read once per process, so a file that needs other
 * settings (DEV_MODE, say) is a file of its own.
 */
export async function fakeService(settings: Record<string, string> = {}): Promise<{ fakes: Fakes; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'order-flow-'));
  const values: Record<string, string> = {
    AD_AGENT_ADAPTERS: 'fake',
    FAKE_DIR: dir,
    FAKE_SCENARIO: '',
    PAYTO_ADDRESS: `0x${'1'.repeat(40)}`,
    PRICE_ATOMIC: String(PRICE),
    LINK_SIGNING_SECRET: 's'.repeat(40),
    CRON_SECRET: 'c'.repeat(40),
    PUBLIC_BASE_URL: 'https://ad-video-agent.test',
    GITHUB_REPO: 'ruizemanuel/ad-video-agent',
    VM_CODE_REF: '0123456789abcdef0123456789abcdef01234567',
    ...settings,
  };
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
  // The steps get these same doubles: getAdapters keeps them on globalThis, where every copy of its module looks.
  return { fakes: (await getAdapters()) as unknown as Fakes, dir };
}

export async function removeFakeService(dir: string): Promise<void> {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
}

/** What the doubles do, from now on: e.g. {buy: 'ambiguous', settled: 'unsettled'} or {review: 'always-cut'}. */
export function scenario(value: Record<string, string>): void {
  vi.stubEnv('FAKE_SCENARIO', JSON.stringify(value));
}

/** An order as the payment route leaves it once the facilitator settled: `paid`, its payment step done, no run yet. */
export async function paidOrder(store: FileStore, request: Partial<OrderRequest> = {}): Promise<string> {
  const { order } = await store.createOrder({
    request: { url: 'https://tiendita.example', audio: 'music', ...request },
    network: 'eip155:42220',
    asset: USDT,
    payer: PAYER,
    amount: PRICE,
    nonce: `0x${randomBytes(32).toString('hex')}`,
    validAfter: 0n,
    validBefore: BigInt(Math.floor(Date.now() / 1000) + 300),
  });
  if (!(await store.transition(order.id, 'paid', { settleTx: `0x${'5e'.repeat(32)}` }))) throw new Error('The order could not be paid.');
  await store.setStep(order.id, 'payment', 'done');
  return order.id;
}

export const taskToken = (orderId: string, kind: VmTaskKind, round: number): string => `vmtask:${orderId}:${kind}:${round}`;

/**
 * Does what the VM does with a task: waits for the run to wait on it, writes the file the task makes (the capture, or the
 * key frames of the round; nothing for a render, whose videos the flow never reads) and reports `result`, as the result
 * route does.
 */
export async function actAsVm(run: Run<unknown>, orderId: string, kind: VmTaskKind, round: number, file: unknown, result: unknown): Promise<void> {
  const token = taskToken(orderId, kind, round);
  await waitForHook(run, { token });
  if (file !== null) {
    const { blob } = await getAdapters();
    const path = kind === 'capture' ? capturePath(orderId) : keyframesPath(orderId, round);
    await blob.put(path, typeof file === 'string' ? file : JSON.stringify(file), 'application/json');
  }
  await resumeHook(token, result);
}

/** The tasks the run queued for the VM, in the order it queued them. Read once the run is over: it hands them all out. */
export async function tasks(store: FileStore, orderId: string): Promise<VmTask[]> {
  const queued: VmTask[] = [];
  for (let task = await store.claimNextTask(orderId); task !== null; task = await store.claimNextTask(orderId)) queued.push(task);
  return queued;
}

// The way Chrome writes a computed color.
const rgb = (hex: string): string => `rgb(${[1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).join(', ')})`;

/**
 * Key frames of the main video of `edl` that pass the code checks: a still per scene, each line of it measured inside the
 * safe zone, large, in the theme's colors. The pictures are stand-ins.
 */
export function passingKeyframes(edl: Edl, site: SiteData): KeyframesFile {
  const { fg, bg } = theme(site);
  return {
    stills: layoutScenes(edl, 0).scenes.map((timed) => ({
      index: timed.index,
      role: timed.role,
      piece: timed.scene.piece,
      frame: settledFrame(timed),
      path: timedScenePath(edl, 0, timed),
      text: timed.scene.lines.map((line, k) => ({
        text: line.text,
        x: 80,
        y: 600 + k * 200,
        w: 700,
        h: 170,
        fontSize: 150,
        font: 'BrandDisplay 800 normal',
        colors: [rgb(fg)],
        opacity: 1,
        bg: rgb(bg),
      })),
      jpegBase64: `/9j/${timed.index}`,
    })),
  };
}
