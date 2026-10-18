import { describe, expect, it } from 'vitest';
import { EdlSchema, FPS, WIPE_FRAMES, beatsToFrames, layoutScenes, retimeForBpm, settledFrame, validateEdl, type Edl, type Scene, type SiteData } from '../src/index';
import edlShopJson from './fixtures/edl-shop.json';
import siteShopJson from './fixtures/site-shop.json';

const edlShop = EdlSchema.parse(edlShopJson);
const first = <T>(items: T[]): T => {
  const item = items[0];
  if (item === undefined) throw new Error('empty list');
  return item;
};
const last = <T>(items: T[]): T => {
  const item = items.at(-1);
  if (item === undefined) throw new Error('empty list');
  return item;
};
const sum = (scenes: Scene[]) => scenes.reduce((beats, s) => beats + s.beats, 0);
const beatsOf = (edl: Edl, hook: number) => sum(edl.hooks[hook] ?? []) + sum(edl.body) + edl.cta.beats;
const allScenes = (edl: Edl): Scene[] => [...edl.hooks.flat(), ...edl.body, edl.cta];

describe('beatsToFrames', () => {
  it('turns 4 beats at 112 bpm into 64 frames', () => expect(beatsToFrames(4, 112)).toBe(64));
  it('honors another frame rate', () => expect(beatsToFrames(4, 120, 24)).toBe(48));
});

describe('layoutScenes', () => {
  it('lays out hook + body + cta back to back', () => {
    const { scenes, total } = layoutScenes(edlShop, 0);
    expect(first(scenes).from).toBe(0);
    expect(last(scenes).from + last(scenes).duration).toBe(total);
  });

  it('puts the hook scenes first, then the body, then the cta', () => {
    const { scenes } = layoutScenes(edlShop, 2);
    expect(scenes.map((t) => t.role)).toEqual(['hook', 'hook', 'body', 'body', 'body', 'body', 'cta']);
    expect(scenes.map((t) => t.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    scenes.slice(1).forEach((t, i) => expect(t.from).toBe(scenes[i]!.from + scenes[i]!.duration));
  });

  it('rounds each cut from the cumulative beat count, so it never drifts off the pulse', () => {
    for (const t of layoutScenes(edlShop, 2).scenes) expect(t.from).toBe(beatsToFrames(t.startBeat, edlShop.bpm));
  });

  it('rejects a hook that does not exist', () => expect(() => layoutScenes(edlShop, 3)).toThrow(RangeError));

  it('makes every version of the shop video last between 15 and 30 seconds', () => {
    for (const hook of [0, 1, 2]) {
      const seconds = layoutScenes(edlShop, hook).total / FPS;
      expect(seconds).toBeGreaterThanOrEqual(15);
      expect(seconds).toBeLessThanOrEqual(30);
    }
  });
});

describe('retimeForBpm', () => {
  it('retimes to the measured bpm keeping the length within one beat and at least 2 beats per scene', () => {
    const r = retimeForBpm(edlShop, 120);
    expect(r.bpm).toBe(120);
    const before = layoutScenes(edlShop, 0).total / 30,
      after = layoutScenes(r, 0).total / 30;
    expect(Math.abs(after - before)).toBeLessThanOrEqual(60 / 120);
    expect(Math.min(...r.body.map((s) => s.beats))).toBeGreaterThanOrEqual(2);
  });

  it.each([96, 104, 120, 128])('keeps every hook version within one beat of its planned length at %i bpm', (measured) => {
    const r = retimeForBpm(edlShop, measured);
    for (const hook of [0, 1, 2]) {
      const planned = (beatsOf(edlShop, hook) * measured) / edlShop.bpm;
      expect(Math.abs(beatsOf(r, hook) - planned)).toBeLessThanOrEqual(1);
    }
  });

  it.each([110.11, 113.19, 84.78])('produces an edit list that still parses at the measured %s bpm', (measured) => {
    const r = retimeForBpm(edlShop, measured);
    expect(EdlSchema.parse(r)).toEqual(r);
    expect(r.bpm).toBe(measured);
    for (const hook of [0, 1, 2]) {
      const planned = (beatsOf(edlShop, hook) * measured) / edlShop.bpm;
      expect(Math.abs(beatsOf(r, hook) - planned)).toBeLessThanOrEqual(1);
    }
  });

  it('does not accumulate rounding error across many short scenes', () => {
    const scene = first(edlShop.body);
    const long: Edl = { ...edlShop, body: Array.from({ length: 10 }, () => ({ ...scene, beats: 3 })) };
    // Rounding every 3-beat scene alone (3 * 1.25 = 3.75 -> 4) would add 10 beats; the cumulative boundary adds 0.5.
    expect(sum(retimeForBpm(long, 140).body)).toBe(38);
  });

  it('keeps every scene at 2 beats or more, even when the track is slower', () => {
    const short: Edl = { ...edlShop, body: edlShop.body.map((s) => ({ ...s, beats: 2 })) };
    const r = retimeForBpm(short, 80);
    expect(allScenes(r).every((s) => s.beats >= 2)).toBe(true);
  });

  it('rescales atBeat with the same ratio', () => {
    const scene: Scene = {
      piece: 'UiFocus',
      beats: 8,
      shotId: 's1-mobile',
      boxIndex: 0,
      lines: [
        { text: 'uno', kind: 'framing' },
        { text: 'dos', kind: 'framing', atBeat: 4 },
      ],
    };
    const retimed = first(retimeForBpm({ ...edlShop, body: [scene] }, 168).body);
    expect(retimed.beats).toBe(12);
    expect(retimed.lines.map((l) => l.atBeat)).toEqual([undefined, 6]);
  });

  it.each([45, 224])('never moves atBeat out of [2, beats - 1] at %i bpm', (measured) => {
    const scenes: Scene[] = [3, 4, 5, 8].map((beats) => ({
      piece: 'UiScroll',
      beats,
      shotId: 's1-mobile',
      lines: Array.from({ length: beats - 1 }, (_, i) => ({ text: 'x', kind: 'framing' as const, atBeat: i + 1 })),
    }));
    for (const scene of retimeForBpm({ ...edlShop, body: scenes }, measured).body)
      for (const line of scene.lines) {
        expect(line.atBeat).toBeGreaterThanOrEqual(2);
        expect(line.atBeat).toBeLessThanOrEqual(scene.beats - 1);
      }
  });

  describe("keeps the rules that the director's edit list met, at a slower track", () => {
    const site = siteShopJson as SiteData;
    const ui = (beats: number, at: number): Scene => ({
      piece: 'UiFocus',
      beats,
      shotId: 's1-mobile',
      boxIndex: 0,
      lines: [
        { text: 'Tu tienda, lista en minutos.', kind: 'claim', claimId: 'c2' },
        { text: 'Sin comisiones.', kind: 'claim', claimId: 'c1', atBeat: at },
      ],
    });
    const cycle = (beats: number): Scene => ({
      piece: 'WordCycle',
      beats,
      lines: [{ text: 'Pagá con', kind: 'framing' }, ...['MP', 'Transferencia', 'Efectivo'].map((text) => ({ text, kind: 'claim' as const, claimId: 'c5' }))],
    });
    // Planned at 112 bpm and retimed to 90, each of these scenes would round to a beat less than it needs.
    const swapFirst: Edl = { ...edlShop, body: [ui(3, 2), ...edlShop.body] };
    const cycleFirst: Edl = { ...edlShop, body: [cycle(4), ...edlShop.body] };
    const shortClose: Edl = { ...edlShop, body: edlShop.body.map((s, i) => (i === 0 ? { ...s, beats: 7 } : s)), cta: { ...edlShop.cta, beats: 4 } };
    const cases: [string, Edl][] = [
      ['a replaced caption', swapFirst],
      ['a WordCycle', cycleFirst],
      ['the EndCard', shortClose],
    ];

    it.each(cases)('%s: the planned edit list and the retimed ones pass validateEdl', (_, edl) => {
      expect(validateEdl(edl, site)).toEqual([]);
      for (const measured of [90, 96, 100.5]) expect(validateEdl(retimeForBpm(edl, measured), site), `${measured} bpm`).toEqual([]);
    });

    it('keeps a replaced caption 3 beats long, its atBeat at 2', () => {
      const swap = first(retimeForBpm(swapFirst, 90).body);
      expect(swap.beats).toBe(3);
      expect(swap.lines[1]?.atBeat).toBe(2);
    });

    it('keeps a beat per word plus one in a WordCycle', () => expect(first(retimeForBpm(cycleFirst, 90).body).beats).toBe(4));

    it('keeps the EndCard 4 beats long', () => expect(retimeForBpm(shortClose, 90).cta.beats).toBe(4));
  });

  it('returns the same edit list at the same bpm', () => expect(retimeForBpm(edlShop, edlShop.bpm)).toEqual(edlShop));

  it('does not change the edit list it receives', () => {
    const copy = structuredClone(edlShop);
    retimeForBpm(edlShop, 125);
    expect(edlShop).toEqual(copy);
  });

  it.each([0, -120, Number.NaN, Number.POSITIVE_INFINITY])('rejects a measured bpm of %s', (measured) =>
    expect(() => retimeForBpm(edlShop, measured)).toThrow(RangeError),
  );
});

describe('settledFrame', () => {
  it('settles a scene 8 frames before its end', () => {
    const t = layoutScenes(edlShop, 0).scenes[1]!;
    expect(settledFrame(t)).toBe(t.from + t.duration - WIPE_FRAMES / 2 - 2);
    expect(t.from + t.duration - settledFrame(t)).toBe(8);
  });
});
