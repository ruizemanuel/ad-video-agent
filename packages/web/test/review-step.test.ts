import { beforeEach, describe, expect, it } from 'vitest';
import { layoutScenes, settledFrame, theme, timedScenePath, type Edl, type Problem, type ProbeItem, type SiteData, type Still } from '@app/core';
import { FakeLlm } from '../src/adapters/fake/llm';
import { runReview, KeyframesFileSchema, type ReviewDeps } from '../src/pipeline/review';
import { ModelCallFailed, ModelOutputInvalid, type CostKind, type LlmPort, type VisualReview } from '../src/ports';
import { edlShop as shopEdl, siteShop as shopSite } from './support/shop';

const edl: Edl = shopEdl();
const site: SiteData = shopSite();
const { fg: FG, bg: BG } = theme(site);

// The scenes of the main video of the shop: hooks[0][0], body[0..3] and cta, in this order.
const PATHS = ['hooks[0][0]', 'body[0]', 'body[1]', 'body[2]', 'body[3]', 'cta'];

const get = <T>(items: readonly T[], index: number): T => {
  const found = items[index];
  if (found === undefined) throw new Error(`no item at ${index}`);
  return found;
};

// The way Chrome writes a computed color.
const rgb = (hex: string): string => `rgb(${[1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).join(', ')})`;

// A line as the probe measures it in the rendered frame: inside the safe zone, in the theme colors.
const item = (text: string, over: Partial<ProbeItem> = {}): ProbeItem => ({
  text,
  x: 80,
  y: 600,
  w: 700,
  h: 170,
  fontSize: 150,
  font: 'BrandDisplay 800 normal',
  colors: [rgb(FG)],
  opacity: 1,
  bg: rgb(BG),
  ...over,
});

// The key frame of scene `index` of the main video, with one probe item per line of the scene. `over` changes every item.
// The picture is a stand-in whose bytes say which scene it is.
const stillOf = (index: number, over: Partial<ProbeItem> = {}, picture = `/9j/${index}`): Still => {
  const timed = get(layoutScenes(edl, 0).scenes, index);
  return {
    index,
    role: timed.role,
    piece: timed.scene.piece,
    frame: settledFrame(timed),
    path: timedScenePath(edl, 0, timed),
    text: timed.scene.lines.map((line, k) => item(line.text, { y: 600 + k * 200, ...over })),
    jpegBase64: picture,
  };
};
const allStills = (): Still[] => layoutScenes(edl, 0).scenes.map((timed) => stillOf(timed.index));
// The scenes' stills with the one at `index` changed.
const withStill = (index: number, change: Still): Still[] => allStills().map((s) => (s.index === index ? change : s));

type FrameVerdict = VisualReview['frames'][number];
type Said = { frames?: Record<number, Partial<FrameVerdict>>; issues?: string[]; logoSwap?: VisualReview['logoSwap'] };
// A visual review that finds nothing wrong with the frames it is shown, except what `said` says. Frames are numbered from 1
// as the labels are; `issues` are the remarks on the first frame; `frames` changes the verdict on a frame by its number.
const ok =
  (said: Said = {}): LlmPort['review'] =>
  async ({ frames }) => ({
    review: {
      frames: frames.map((_, k) => ({
        frame: k + 1,
        legible: true,
        cutMidLetter: false,
        issues: k === 0 ? (said.issues ?? []) : [],
        ...said.frames?.[k + 1],
      })),
      logoSwap: said.logoSwap ?? { generic: false, reason: 'The ad leans on what only this product has.' },
    },
    usd: 0.2,
  });

type Cost = { orderId: string; item: string; usd: number; kind: CostKind };
let costs: Cost[];
let llm: FakeLlm;
let deps: ReviewDeps;
let args: Parameters<typeof runReview>[0];
let orders = 0;

beforeEach(() => {
  orders += 1;
  costs = [];
  llm = new FakeLlm();
  deps = {
    store: {
      addCost: async (orderId, name, usd, kind) => {
        costs.push({ orderId, item: name, usd, kind });
      },
    },
    llm,
  };
  args = { orderId: `ord_review${orders}`, edl, site, file: { stills: allStills() }, deps };
});

const blockingOf = async (file: unknown): Promise<Problem[]> => (await runReview({ ...args, file })).blocking;

describe('runReview', () => {
  it('passes key frames that the code checks and the visual review both accept', async () => {
    llm.review = ok();
    expect(await runReview(args)).toEqual({ blocking: [], warnings: [] });
  });

  it('passes them with the double as it comes, which finds nothing wrong', async () => {
    expect(await runReview(args)).toEqual({ blocking: [], warnings: [] });
  });

  describe('level one: the code checks', () => {
    it('blocks on a failing code check, naming the scene', async () => {
      llm.review = ok();
      // The first line of body[0] sits in the bottom 420 px, where the platform's own interface goes.
      const file = { stills: withStill(1, stillOf(1, { y: 1700, h: 80 })) };
      const { blocking } = await runReview({ ...args, file });
      expect(blocking[0]).toEqual({ where: 'body[0]', rule: 'visual', detail: expect.stringMatching(/safe-zone/) });
      expect(blocking.map((p) => p.where)).toEqual(['body[0]']);
    });

    it('says what failed, with the text and where it sits', async () => {
      llm.review = ok();
      const file = { stills: withStill(1, stillOf(1, { fontSize: 40 })) };
      const { blocking } = await runReview({ ...args, file });
      expect(blocking).toEqual([{ where: 'body[0]', rule: 'visual', detail: expect.stringMatching(/min-size.*body\[0\] "Tus clientes piden por WhatsApp\." at 40px \(min 44\)/) }]);
    });

    it('blocks once per scene that fails a check, each with its own words only', async () => {
      llm.review = ok();
      const stills = allStills().map((s) => (s.index === 1 || s.index === 3 ? stillOf(s.index, { fontSize: 40 }) : s));
      const { blocking } = await runReview({ ...args, file: { stills } });
      expect(blocking.map((p) => p.where)).toEqual(['body[0]', 'body[2]']);
      expect(get(blocking, 0).detail).toContain('body[0] "Tus clientes');
      expect(get(blocking, 0).detail).not.toContain('body[2]');
      expect(get(blocking, 1).detail).not.toContain('body[0]');
    });

    it('blocks a scene once for each check it fails', async () => {
      llm.review = ok();
      const file = { stills: withStill(1, stillOf(1, { fontSize: 40, y: 1700, h: 80 })) };
      const { blocking } = await runReview({ ...args, file });
      expect(blocking.map((p) => [p.where, p.detail.split(':')[0]])).toEqual([
        ['body[0]', 'safe-zone'],
        ['body[0]', 'min-size'],
      ]);
    });

    it('blocks a scene that came out without a key frame', async () => {
      llm.review = ok();
      const stills = allStills().filter((s) => s.index !== 3);
      const { blocking } = await runReview({ ...args, file: { stills } });
      expect(blocking).toEqual([{ where: 'body[2]', rule: 'visual', detail: 'no keyframe' }]);
    });

    it('blocks every scene of a file with no key frames, without asking a model about nothing', async () => {
      llm.review = ok();
      const { blocking } = await runReview({ ...args, file: { stills: [] } });
      expect(blocking.map((p) => p.where)).toEqual(PATHS);
      expect(blocking.every((p) => p.rule === 'visual' && p.detail === 'no keyframe')).toBe(true);
      expect(llm.calls.review).toBe(0);
      expect(costs).toEqual([]);
    });

    it('still asks the visual review when a code check fails, so the corrector gets everything in one round', async () => {
      llm.review = ok({ frames: { 3: { legible: false, issues: ['The headline fades into the photo.'] } } });
      const file = { stills: withStill(1, stillOf(1, { fontSize: 40 })) };
      const { blocking } = await runReview({ ...args, file });
      expect(blocking.map((p) => p.where)).toEqual(['body[0]', 'body[1]']);
      expect(llm.calls.review).toBe(1);
    });
  });

  describe('level two: the visual review', () => {
    it('blocks on illegible text, naming the scene of the frame', async () => {
      llm.review = ok({ frames: { 3: { legible: false, issues: ['The price is lost against the photo.'] } } });
      const { blocking, warnings } = await runReview(args);
      expect(blocking).toEqual([{ where: 'body[1]', rule: 'visual', detail: expect.stringMatching(/not legible.*The price is lost against the photo\./) }]);
      expect(warnings).toEqual([]);
    });

    it('blocks on a cut letter, naming the scene of the frame', async () => {
      llm.review = ok({ frames: { 3: { cutMidLetter: true, issues: ['The W of WhatsApp is cut by the card.'] } } });
      const { blocking } = await runReview(args);
      expect(blocking).toEqual([{ where: 'body[1]', rule: 'visual', detail: expect.stringMatching(/letter is cut.*The W of WhatsApp is cut by the card\./) }]);
    });

    it('blocks a frame that is both once, saying both', async () => {
      llm.review = ok({ frames: { 2: { legible: false, cutMidLetter: true } } });
      const { blocking } = await runReview(args);
      expect(blocking).toHaveLength(1);
      expect(get(blocking, 0).where).toBe('body[0]');
      expect(get(blocking, 0).detail).toMatch(/not legible/);
      expect(get(blocking, 0).detail).toMatch(/letter is cut/);
    });

    it('blocks on the logo-swap test, for the whole ad', async () => {
      llm.review = ok({ logoSwap: { generic: true, reason: 'Any shop builder could use these frames.' } });
      const { blocking } = await runReview(args);
      expect(blocking).toEqual([{ where: 'all', rule: 'visual', detail: expect.stringMatching(/logo-swap.*Any shop builder could use these frames\./) }]);
    });

    it('does not block a frame for its remarks: they are warnings, with the scene they are about', async () => {
      llm.review = ok({ issues: ['weak hook'] });
      expect(await runReview(args)).toEqual({ blocking: [], warnings: ['hooks[0][0]: weak hook'] });
    });

    it('keeps the remarks of a blocking frame in its problem, not among the warnings', async () => {
      llm.review = ok({ frames: { 2: { legible: false, issues: ['Too small.'] } } });
      const { blocking, warnings } = await runReview(args);
      expect(get(blocking, 0).detail).toContain('Too small.');
      expect(warnings).toEqual([]);
    });

    it('warns once about a remark that two frames of a scene both get', async () => {
      // Frames 2 and 7 are both body[0]; frame 3 is body[1].
      llm.review = ok({ frames: { 2: { issues: ['same idea twice'] }, 3: { issues: ['same idea twice'] }, 7: { issues: ['same idea twice'] } } });
      const stills = [...allStills(), stillOf(1, {}, '/9j/second')];
      const { warnings } = await runReview({ ...args, file: { stills } });
      expect(warnings).toEqual(['body[0]: same idea twice', 'body[1]: same idea twice']);
    });

    it('blocks on any frame of a scene with several', async () => {
      llm.review = ok({ frames: { 7: { cutMidLetter: true } } });
      const stills = [...allStills(), stillOf(1, {}, '/9j/second')];
      const { blocking } = await runReview({ ...args, file: { stills } });
      expect(blocking.map((p) => p.where)).toEqual(['body[0]']);
    });

    it('reports blocking problems in this order: code checks, then frames, then the logo', async () => {
      llm.review = ok({ frames: { 6: { legible: false } }, logoSwap: { generic: true, reason: 'Template.' } });
      const file = { stills: withStill(1, stillOf(1, { fontSize: 40 })) };
      const { blocking } = await runReview({ ...args, file });
      expect(blocking.map((p) => p.where)).toEqual(['body[0]', 'cta', 'all']);
    });

    describe('when the answer cannot be trusted', () => {
      it('blocks a frame that got no verdict', async () => {
        llm.review = async ({ frames }) => ({
          review: { frames: frames.slice(0, 3).map((_, k) => ({ frame: k + 1, legible: true, cutMidLetter: false, issues: [] })), logoSwap: { generic: false, reason: 'Specific.' } },
          usd: 0.2,
        });
        const { blocking } = await runReview(args);
        expect(blocking.map((p) => [p.where, p.detail])).toEqual([
          ['body[2]', expect.stringMatching(/no verdict/)],
          ['body[3]', expect.stringMatching(/no verdict/)],
          ['cta', expect.stringMatching(/no verdict/)],
        ]);
      });

      it('blocks a scene when any of its frames got no verdict', async () => {
        const stills = [...allStills(), stillOf(1, {}, '/9j/second')];
        const inner = ok();
        llm.review = async (input) => {
          const answer = await inner(input);
          return { ...answer, review: { ...answer.review, frames: answer.review.frames.slice(0, 6) } };
        };
        const { blocking } = await runReview({ ...args, file: { stills } });
        expect(blocking.map((p) => p.where)).toEqual(['body[0]']);
      });

      it('blocks the whole ad, not a scene, on a verdict for a frame that does not exist', async () => {
        llm.review = async ({ frames }) => ({
          review: {
            frames: [...frames.map((_, k) => ({ frame: k + 1, legible: true, cutMidLetter: false, issues: [] })), { frame: 99, legible: false, cutMidLetter: false, issues: ['Unreadable.'] }],
            logoSwap: { generic: false, reason: 'Specific.' },
          },
          usd: 0.2,
        });
        const { blocking } = await runReview(args);
        expect(blocking).toEqual([{ where: 'all', rule: 'visual', detail: expect.stringContaining('Unreadable.') }]);
      });

      it('lets any verdict that blocks a frame block it, even when another passes it', async () => {
        llm.review = async ({ frames }) => ({
          review: {
            frames: [
              ...frames.map((_, k) => ({ frame: k + 1, legible: true, cutMidLetter: false, issues: [] })),
              { frame: 2, legible: false, cutMidLetter: false, issues: ['Unreadable.'] },
            ],
            logoSwap: { generic: false, reason: 'Specific.' },
          },
          usd: 0.2,
        });
        const { blocking } = await runReview(args);
        expect(blocking.map((p) => p.where)).toEqual(['body[0]']);
      });

      it('writes a remark about a frame that does not exist against the whole ad', async () => {
        llm.review = async ({ frames }) => ({
          review: { frames: [...frames.map((_, k) => ({ frame: k + 1, legible: true, cutMidLetter: false, issues: [] })), { frame: 0, legible: true, cutMidLetter: false, issues: ['odd'] }], logoSwap: { generic: false, reason: 'Specific.' } },
          usd: 0.2,
        });
        expect(await runReview(args)).toEqual({ blocking: [], warnings: ['all: odd'] });
      });
    });
  });

  describe('what the model is shown', () => {
    it('gets every key frame in playing order, as its picture after a label that starts with its number and names its scene', async () => {
      llm.review = ok();
      await runReview(args);
      const frames = llm.lastReviewInput?.frames ?? [];
      expect(frames.map((f) => f.jpeg)).toEqual(allStills().map((s) => s.jpegBase64));
      expect(frames.map((f) => f.label)).toEqual([
        'Frame 1: hooks[0][0], hook scene, KineticHeadline',
        'Frame 2: body[0], body scene, UiFocus',
        'Frame 3: body[1], body scene, KineticHeadline',
        'Frame 4: body[2], body scene, ClaimStack',
        'Frame 5: body[3], body scene, KineticHeadline',
        'Frame 6: cta, cta scene, EndCard',
      ]);
    });

    it('says in the label of a scene with several frames which one it is, and that the text changes', async () => {
      llm.review = ok();
      const stills = [stillOf(0, {}, '/9j/a'), stillOf(0, {}, '/9j/b'), ...allStills().slice(1)];
      await runReview({ ...args, file: { stills } });
      const labels = (llm.lastReviewInput?.frames ?? []).map((f) => f.label);
      expect(labels[0]).toBe('Frame 1: hooks[0][0], hook scene, KineticHeadline, picture 1 of 2 (its text changes)');
      expect(labels[1]).toBe('Frame 2: hooks[0][0], hook scene, KineticHeadline, picture 2 of 2 (its text changes)');
      expect(labels[2]).toBe('Frame 3: body[0], body scene, UiFocus');
    });

    it('names the scene by where the edit list puts it, not by what the file says', async () => {
      llm.review = ok();
      const stills = withStill(1, { ...stillOf(1), path: 'body[9]' });
      await runReview({ ...args, file: { stills } });
      expect(llm.lastReviewInput?.frames[1]?.label).toContain('body[0]');
    });

    it('tells it which site the ad is for', async () => {
      llm.review = ok();
      await runReview(args);
      expect(llm.lastReviewInput?.siteUrl).toBe(site.url);
    });

    it('asks once', async () => {
      llm.review = ok();
      await runReview(args);
      expect(llm.calls.review).toBe(1);
    });
  });

  describe('cost', () => {
    it('records what the review cost on the order, as a card cost', async () => {
      llm.review = ok();
      await runReview(args);
      expect(costs).toEqual([{ orderId: args.orderId, item: 'llm:review', usd: 0.2, kind: 'card' }]);
    });

    it('records the cost of an answer that did not fit, and lets the error go on', async () => {
      llm.review = async () => {
        throw new ModelOutputInvalid('The review model did not answer with a valid review.', 0.17);
      };
      await expect(runReview(args)).rejects.toBeInstanceOf(ModelOutputInvalid);
      expect(costs).toEqual([{ orderId: args.orderId, item: 'llm:review', usd: 0.17, kind: 'card' }]);
    });

    it('records nothing for a call that failed without an answer, and lets the error go on', async () => {
      llm.review = async () => {
        throw new ModelCallFailed('review', 'AI_APICallError', 503);
      };
      await expect(runReview(args)).rejects.toBeInstanceOf(ModelCallFailed);
      expect(costs).toEqual([]);
    });
  });

  // The probe is the one thing in the file that the code checks lean on. A file that is not what the VM writes must never
  // pass as clean, and must not cost a model call.
  describe('a key frames file that is not what the VM writes', () => {
    const broken = (change: (still: Record<string, unknown>) => void): unknown => {
      const stills = JSON.parse(JSON.stringify(allStills())) as Record<string, unknown>[];
      change(get(stills, 1));
      return { stills };
    };
    const probeOf = (still: Record<string, unknown>): Record<string, unknown> => get(still.text as Record<string, unknown>[], 0);

    it.each([
      ['a font size that is not a number', (s: Record<string, unknown>) => (probeOf(s).fontSize = null)],
      ['a font size that is a string', (s: Record<string, unknown>) => (probeOf(s).fontSize = '150')],
      ['a box with no width', (s: Record<string, unknown>) => delete probeOf(s).w],
      ['a box with a position that is a string', (s: Record<string, unknown>) => (probeOf(s).x = '80')],
      ['an opacity that is not a number', (s: Record<string, unknown>) => (probeOf(s).opacity = null)],
      ['an opacity above 1', (s: Record<string, unknown>) => (probeOf(s).opacity = 3)],
      ['colors that are not a list', (s: Record<string, unknown>) => (probeOf(s).colors = 'rgb(0, 0, 0)')],
      ['a color that is not text', (s: Record<string, unknown>) => (probeOf(s).colors = [0])],
      ['a background that is neither text nor null', (s: Record<string, unknown>) => (probeOf(s).bg = 0)],
      ['text that is not a list', (s: Record<string, unknown>) => (s.text = 'hello')],
      ['a role that is none of the three', (s: Record<string, unknown>) => (s.role = 'intro')],
      ['a piece that does not exist', (s: Record<string, unknown>) => (s.piece = 'Confetti')],
      ['a scene index that is not a whole number', (s: Record<string, unknown>) => (s.index = 1.5)],
      ['a picture that is not text', (s: Record<string, unknown>) => (s.jpegBase64 = null)],
    ])('blocks %s', async (_name, change) => {
      llm.review = ok();
      const { blocking, warnings } = await runReview({ ...args, file: broken(change) });
      expect(blocking).toEqual([{ where: 'edl', rule: 'visual', detail: expect.stringMatching(/^The key frames file is not valid: .*stills\.1/) }]);
      expect(warnings).toEqual([]);
      expect(llm.calls.review).toBe(0);
      expect(costs).toEqual([]);
    });

    it.each([
      ['not an object', 'stills'],
      ['null', null],
      ['an object with no stills', {}],
      ['stills that are not a list', { stills: {} }],
    ])('blocks a file that is %s', async (_name, file) => {
      expect(await blockingOf(file)).toEqual([{ where: 'edl', rule: 'visual', detail: expect.stringMatching(/^The key frames file is not valid/) }]);
      expect(llm.calls.review).toBe(0);
    });

    it('does not repeat what the file holds in the problem: it can hold the site text', async () => {
      const file = broken((s) => {
        probeOf(s).text = 'Vendé por WhatsApp sin comisiones';
        probeOf(s).fontSize = 'Vendé por WhatsApp sin comisiones';
      });
      const [problem] = await blockingOf(file);
      expect(problem?.detail).not.toMatch(/Vendé|WhatsApp/);
    });

    it('blocks a key frame of a scene that the edit list does not have', async () => {
      llm.review = ok();
      const stills = [...allStills(), { ...stillOf(0), index: 6 }];
      const { blocking } = await runReview({ ...args, file: { stills } });
      expect(blocking).toEqual([{ where: 'edl', rule: 'visual', detail: expect.stringMatching(/scene 6.*6 scenes/) }]);
      expect(llm.calls.review).toBe(0);
    });

    it('accepts the file the VM writes, as JSON', async () => {
      llm.review = ok();
      const file: unknown = JSON.parse(JSON.stringify({ stills: allStills() }));
      expect(await runReview({ ...args, file })).toEqual({ blocking: [], warnings: [] });
    });

    it('keeps what the probe measured, so the code checks read it', async () => {
      const parsed = KeyframesFileSchema.parse({ stills: allStills() });
      expect(parsed).toEqual({ stills: allStills() });
    });

    it('does not mind a key the VM adds one day', async () => {
      llm.review = ok();
      const file = { stills: allStills().map((s) => ({ ...s, extra: true })) };
      expect(await runReview({ ...args, file })).toEqual({ blocking: [], warnings: [] });
    });
  });
});
