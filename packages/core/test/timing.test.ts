import { describe, expect, it } from 'vitest';
import {
  AFTER_LOGO,
  EdlSchema,
  FPS,
  LINE_IN,
  WIPE_FRAMES,
  beatsToFrames,
  headlineLineStart,
  isReadable,
  layoutScenes,
  minSceneBeats,
  opensWithBrand,
  retimeForBpm,
  settledFrame,
  stackLineStart,
  textWindows,
  timedScenePath,
  validateEdl,
  type Edl,
  type Line,
  type Scene,
  type SiteData,
  type TimedScene,
} from '../src/index';
import edlShopJson from './fixtures/edl-shop.json';
import { run7 } from './fixtures/paid-runs';
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

describe('minSceneBeats', () => {
  const framing = (text: string, atBeat?: number): Line => ({ text, kind: 'framing', ...(atBeat === undefined ? {} : { atBeat }) });
  const scene = (piece: Scene['piece'], lines: Line[]): Scene => ({ piece, beats: 8, lines });

  it('asks a WordCycle for two beats per word plus one: 5 for two words, 7 for three', () => {
    expect(minSceneBeats(scene('WordCycle', [framing('Pay with'), framing('cards'), framing('cash')]))).toBe(5);
    expect(minSceneBeats(scene('WordCycle', [framing('Pay with'), framing('cards'), framing('cash'), framing('transfers')]))).toBe(7);
  });

  it('keeps 2 beats for any scene, 7 when a caption is replaced and 4 for the EndCard', () => {
    expect(minSceneBeats(scene('KineticHeadline', [framing('One')]))).toBe(2);
    expect(minSceneBeats(scene('UiFocus', [framing('One'), framing('Two', 2)]))).toBe(7);
    expect(minSceneBeats(scene('EndCard', [framing('Start free')]))).toBe(4);
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
    const swapFirst: Edl = { ...edlShop, body: [ui(7, 5), ...edlShop.body] };
    const cycleFirst: Edl = { ...edlShop, body: [cycle(7), ...edlShop.body] };
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

    it('keeps a replaced caption 7 beats long, its atBeat moved with the tempo', () => {
      const swap = first(retimeForBpm(swapFirst, 90).body);
      expect(swap.beats).toBe(7);
      expect(swap.lines[1]?.atBeat).toBe(4);
    });

    it('moves an atBeat with the tempo only as far as both captions stay read', () => {
      // Scaled, beat 5 of 7 at 112 bpm would be beat 6 of 8 at 123.2: too late for "Sin comisiones." to be read.
      const late = first(retimeForBpm(swapFirst, 123.2).body);
      expect([late.beats, late.lines[1]?.atBeat]).toEqual([8, 5]);
      // Beat 4 of 8 at 104 bpm would stay beat 4 of 9 at 114.4: too soon for the first caption.
      const early = first(retimeForBpm({ ...edlShop, bpm: 104, body: [ui(8, 4), ...edlShop.body] }, 114.4).body);
      expect([early.beats, early.lines[1]?.atBeat]).toEqual([9, 5]);
    });

    it('keeps two beats per word plus one in a WordCycle', () => expect(first(retimeForBpm(cycleFirst, 90).body).beats).toBe(7));

    it('keeps the EndCard 4 beats long', () => expect(retimeForBpm(shortClose, 90).cta.beats).toBe(4));
  });

  describe('keeps every text on screen long enough to be read, at every tempo the music comes at', () => {
    /** The texts of the main video (hook 0), the one the order renders and validateEdl checks, not on screen long enough to be read. */
    const unread = (edl: Edl): string[] => {
      const { scenes } = layoutScenes(edl, 0);
      return scenes.flatMap((timed, k) =>
        textWindows(timed, edl.bpm, scenes[k + 1]?.scene.transitionIn === 'wipe')
          .filter((w) => !isReadable(w))
          .map((w) => `${timedScenePath(edl, 0, timed)}.lines[${w.line}] "${w.text}"`),
      );
    };
    // Run 7 as the investigation fixed it (34 beats), and the shop, planned at a tempo the director may pick.
    const fixed7 = (bpm: number): Edl => {
      const edl = run7();
      const [headline, , cycle, focus] = edl.body;
      const scroll: Scene = { piece: 'UiScroll', beats: 8, shotId: 's1-mobile', boxIndex: 2, lines: [{ text: 'Productos y sesiones 1:1.', kind: 'claim', claimId: 'c3' }, { text: 'Un solo link para tu bio.', kind: 'claim', claimId: 'c4', atBeat: 4 }] };
      return { ...edl, bpm, hooks: [[{ piece: 'UiFocus', beats: 4, shotId: 's1-mobile', boxIndex: 0, lines: [{ text: '¿Cuánto te queda?', kind: 'framing' }] }]], body: [headline!, scroll, cycle!, focus!] };
    };

    it.each([
      ['run 7 fixed, planned at 100 bpm', [90, 125], fixed7(100)],
      ['run 7 fixed, planned at 100 bpm', [85, 88.5, 93.2, 96, 104, 107.7, 111.3, 115], fixed7(100)],
      ['the shop, planned at 112 bpm', [95.2, 99, 103.4, 108, 116.6, 120.8, 124.1, 128.8], edlShop],
      ['the shop, planned at 128 bpm', [108.8, 113, 118.5, 122.2, 133.3, 139, 143.6, 147.2], { ...edlShop, bpm: 128 }],
    ] as [string, number[], Edl][])('%s, retimed to %j', (_, tempos, planned) => {
      expect(unread(planned)).toEqual([]);
      for (const measured of tempos) expect(unread(retimeForBpm(planned, measured)), `${measured} bpm`).toEqual([]);
    });

    it('lengthens a scene by the beat its texts need, and no more, when rounding would pull its cut in', () => {
      // The 3-beat headline of hook 2 would round to 2 beats at 90 bpm, too short for "Sin comisiones." to be read.
      const retimed = retimeForBpm(edlShop, 90);
      expect(retimed.hooks[2]?.[1]?.beats).toBe(3);
      expect(retimed.hooks[2]?.[0]?.beats).toBe(4);
    });
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

describe('the rhythm of the pieces', () => {
  const framing = (text: string): Line => ({ text, kind: 'framing' });
  const lines = ['One', 'Two', 'Three'].map(framing);
  /** A scene placed at `startBeat` of a video at `bpm`, as layoutScenes places it. */
  const placed = (scene: Scene, bpm: number, startBeat = 0, index = 1): TimedScene => {
    const from = beatsToFrames(startBeat, bpm);
    return { scene, role: 'body', index, from, duration: beatsToFrames(startBeat + scene.beats, bpm) - from, startBeat };
  };

  describe('headlineLineStart', () => {
    // At 120 bpm a beat is 15 frames.
    const headline = placed({ piece: 'KineticHeadline', beats: 6, lines }, 120, 4);

    it('brings line i in on beat i of the scene', () => expect([0, 1, 2].map((i) => headlineLineStart(i, headline, 120, false))).toEqual([0, 15, 30]));

    it('brings the first line in after the brand when the headline opens the video', () => {
      expect(headlineLineStart(0, headline, 120, true)).toBe(AFTER_LOGO);
      expect(headlineLineStart(1, headline, 120, true)).toBe(15);
    });

    it('brings the second half of a line split in two in `stagger` frames later', () => expect(headlineLineStart(1, headline, 120, false, 5)).toBe(20));

    it('brings a line in no later than LINE_IN frames before the settled frame, in a scene too short for its beat', () => {
      // 3 beats: 45 frames, settled at 37; line 2 would come in on beat 2 (frame 30), after 37 - 12 = 25.
      const short = placed({ piece: 'KineticHeadline', beats: 3, lines }, 120);
      expect(headlineLineStart(2, short, 120, false)).toBe(settledFrame(short) - short.from - LINE_IN);
      expect(headlineLineStart(1, short, 120, false)).toBe(15);
    });
  });

  describe('stackLineStart', () => {
    it('spreads the lines of a ClaimStack floor(beats / lines) beats apart, on the beat grid of the whole video', () => {
      const stack = placed({ piece: 'ClaimStack', beats: 7, lines }, 113.19, 5);
      expect([0, 1, 2].map((i) => stackLineStart(i, stack, 113.19))).toEqual([5, 7, 9].map((beat) => beatsToFrames(beat, 113.19) - stack.from));
    });

    it('keeps the lines a beat apart at least', () => {
      const crowded = placed({ piece: 'ClaimStack', beats: 2, lines }, 120);
      expect([0, 1, 2].map((i) => stackLineStart(i, crowded, 120))).toEqual([0, 15, 30]);
    });
  });

  describe('opensWithBrand', () => {
    it('is true of a headline that opens the video, which carries the brand over it', () => {
      expect(opensWithBrand(placed({ piece: 'KineticHeadline', beats: 4, lines }, 120, 0, 0))).toBe(true);
      expect(opensWithBrand(placed({ piece: 'KineticHeadline', beats: 4, lines }, 120, 4, 1))).toBe(false);
      expect(opensWithBrand(placed({ piece: 'ClaimStack', beats: 4, lines }, 120, 0, 0))).toBe(false);
    });
  });
});
