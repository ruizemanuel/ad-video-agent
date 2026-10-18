import { describe, expect, it } from 'vitest';
import {
  EdlSchema,
  checkStills,
  layoutScenes,
  settledFrame,
  theme,
  timedScenePath,
  type Check,
  type Format,
  type ProbeItem,
  type SiteData,
  type Still,
} from '../src/index';
import edlShopJson from './fixtures/edl-shop.json';
import siteShopJson from './fixtures/site-shop.json';

const edlShop = EdlSchema.parse(edlShopJson);
const siteShop = siteShopJson as SiteData;
const { fg: FG, bg: BG } = theme(siteShop);

const get = <T>(items: readonly T[], index: number): T => {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at ${index}`);
  return item;
};

// The way Chrome writes a computed color.
const rgb = (hex: string): string => `rgb(${[1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).join(', ')})`;

// A line as the probe of the real frame measures it: inside the safe zone of every format, in the theme colors.
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

// The key frame of scene `index` of the video of `hook`, with one probe item per line of the scene. `over` changes every item.
const stillOf = (index: number, over: Partial<ProbeItem> = {}, hook = 0): Still => {
  const timed = get(layoutScenes(edlShop, hook).scenes, index);
  return {
    index,
    role: timed.role,
    piece: timed.scene.piece,
    frame: settledFrame(timed),
    path: timedScenePath(edlShop, hook, timed),
    text: timed.scene.lines.map((line, k) => item(line.text, { y: 600 + k * 200, ...over })),
    jpegBase64: '',
  };
};
// Scene 0 of the main video is the first hook scene: "¿Cuánto te cobran" / "por cada venta?".
const still = (over: Partial<ProbeItem> = {}): Still => stillOf(0, over);

const check = (checks: Check[], name: string): Check => {
  const found = checks.find((c) => c.name === name);
  if (!found) throw new Error(`no check named ${name}`);
  return found;
};
const fail = (checks: Check[], name: string): boolean => !check(checks, name).pass;
const run = (stills: Still[], format: Format = '9x16', site: SiteData = siteShop, hook = 0): Check[] => checkStills(stills, edlShop, site, format, hook);

describe('checkStills', () => {
  it('returns the five checks, in this order', () => {
    expect(run([still()]).map((c) => c.name)).toEqual(['safe-zone', 'min-size', 'contrast', 'words', 'palette']);
  });

  it('passes a clean still', () => {
    const checks = run([still()]);
    expect(checks.every((c) => c.pass)).toBe(true);
    expect(checks.every((c) => c.where.length === 0)).toBe(true);
  });

  it('says how many stills it looked at when everything passes', () => {
    expect(check(run([still(), stillOf(1)]), 'safe-zone').detail).toContain('2 stills');
  });

  it('defaults to the video of hook 0', () => {
    expect(checkStills([still({ fontSize: 40 })], edlShop, siteShop, '9x16')).toEqual(run([still({ fontSize: 40 })]));
  });
});

describe('safe-zone', () => {
  it('fails text outside the 9x16 safe zone (top 220, bottom 420, left 60, right 160)', () =>
    expect(fail(run([still({ y: 1600, h: 80 })]), 'safe-zone')).toBe(true));

  it.each([
    ['left', { x: 40 }],
    ['right', { x: 300, w: 700 }],
    ['top', { y: 100 }],
    ['bottom', { y: 1400, h: 200 }],
  ])('fails text past the %s edge of the zone', (_side, over) => {
    const checks = run([still(over)]);
    expect(fail(checks, 'safe-zone')).toBe(true);
    expect(check(checks, 'safe-zone').detail).toContain('safe zone');
  });

  it('allows 1 px of slack on each edge, for sub-pixel text boxes', () => {
    expect(fail(run([still({ x: 59, w: 862 })]), 'safe-zone')).toBe(false); // 59 to 921: one px past the zone on both sides
    expect(fail(run([still({ x: 58, w: 862 })]), 'safe-zone')).toBe(true);
    expect(fail(run([still({ y: 219 })]), 'safe-zone')).toBe(false);
    expect(fail(run([still({ y: 1330, h: 171 })]), 'safe-zone')).toBe(false); // bottom at 1501
    expect(fail(run([still({ y: 1330, h: 172 })]), 'safe-zone')).toBe(true);
  });

  it('names the text and where it sits', () => {
    expect(check(run([still({ x: 40 })]), 'safe-zone').detail).toMatch(/hooks\[0\]\[0\] "¿Cuánto te cobran" at x 40-740, y 600-770/);
  });

  it('says so when the text runs past the frame edge', () => {
    expect(check(run([still({ x: 900, w: 300 })]), 'safe-zone').detail).toContain('frame edge');
  });

  it('uses the safe zone of the format it is given', () => {
    const low = still({ y: 900, h: 200 }); // bottom at 1100
    expect(fail(run([low], '9x16'), 'safe-zone')).toBe(false);
    expect(fail(run([low], '16x9'), 'safe-zone')).toBe(true); // 16x9 is 1080 px high, bottom limit 1020
  });
});

describe('min-size', () => {
  it('fails text under 44 px in 9x16', () => expect(fail(run([still({ fontSize: 40 })]), 'min-size')).toBe(true));

  it.each([
    ['9x16', 44],
    ['16x9', 36],
    ['4x5', 40],
  ] as const)('requires %s text of at least %i px', (format, min) => {
    expect(fail(run([still({ fontSize: min })], format), 'min-size')).toBe(false);
    expect(fail(run([still({ fontSize: min - 1 })], format), 'min-size')).toBe(true);
  });

  it('reports the size and the minimum', () => {
    expect(check(run([still({ fontSize: 40 })]), 'min-size').detail).toContain('40px (min 44)');
  });
});

describe('contrast', () => {
  it('fails a color whose contrast after opacity is below 4.5:1', () =>
    expect(fail(run([still({ colors: ['rgb(17,17,17)'], opacity: 0.4, bg: 'rgb(255,255,255)' })]), 'contrast')).toBe(true));

  it('passes the same color at full opacity', () =>
    expect(fail(run([still({ colors: ['rgb(17,17,17)'], opacity: 1, bg: 'rgb(255,255,255)' })]), 'contrast')).toBe(false));

  it('reports the blended color, its background, the ratio and the opacity', () => {
    // 17 at 0.4 over 255 is 160 (#a0a0a0): 2.6:1 on white.
    expect(check(run([still({ colors: ['rgb(17,17,17)'], opacity: 0.4, bg: 'rgb(255,255,255)' })]), 'contrast').detail).toMatch(
      /"¿Cuánto te cobran" #a0a0a0 on #ffffff = 2\.\d\d:1 \(opacity 0\.4\)/,
    );
  });

  it('reads a missing background as white', () => {
    expect(fail(run([still({ colors: ['rgb(17,17,17)'], bg: null })]), 'contrast')).toBe(false);
    expect(fail(run([still({ colors: ['rgb(255,255,255)'], bg: null })]), 'contrast')).toBe(true);
  });

  it('passes white on a dark background', () =>
    expect(fail(run([still({ colors: ['rgb(255, 255, 255)'], bg: 'rgb(17, 17, 17)' })]), 'contrast')).toBe(false));

  it('judges every color of a line, so an accent word is checked too', () => {
    // #f4b942, the site accent, on the page background: about 1.7:1.
    const checks = run([still({ colors: [rgb(FG), 'rgb(244, 185, 66)'] })]);
    expect(fail(checks, 'contrast')).toBe(true);
    expect(check(checks, 'contrast').detail).toContain('#f4b942');
  });

  it('counts the transparency of the color itself, not only the opacity of its parents', () => {
    expect(fail(run([still({ colors: ['rgba(31, 42, 36, 0.3)'] })]), 'contrast')).toBe(true);
    expect(fail(run([still({ colors: ['rgba(31, 42, 36, 1)'] })]), 'contrast')).toBe(false);
  });

  it('fails what it cannot read instead of letting it through', () => {
    const color = run([still({ colors: ['oklch(0.5 0.1 200)'] })]);
    expect(fail(color, 'contrast')).toBe(true);
    expect(check(color, 'contrast').detail).toContain('oklch(0.5 0.1 200)');
    expect(fail(run([still({ bg: 'var(--bg)' })]), 'contrast')).toBe(true);
  });
});

describe('words', () => {
  const lacking = (): Still => {
    const whole = still();
    return { ...whole, text: [item('¿Cuánto te cobran'), item('por cada', { y: 800 })] }; // "venta?" is missing
  };

  it('fails when a word of a line is not on screen', () => {
    const checks = run([lacking()]);
    expect(fail(checks, 'words')).toBe(true);
    expect(check(checks, 'words').where).toEqual(['hooks[0][0]']);
  });

  it('names the missing word and its line', () => {
    expect(check(run([lacking()]), 'words').detail).toBe('hooks[0][0]: "venta?" of "por cada venta?" is not on screen');
  });

  it('accepts a line split over several boxes, in any case, with extra text around it', () => {
    const split: Still = {
      ...still(),
      text: [item('¿CUÁNTO TE'), item('cobran', { y: 700 }), item('por cada venta?', { y: 800 }), item('tiendita.example', { y: 900 })],
    };
    expect(fail(run([split]), 'words')).toBe(false);
  });

  it('wants whole words: a word inside a longer one is not the word', () => {
    const longer: Still = { ...still(), text: [item('¿Cuánto te cobrando'), item('por cada venta?', { y: 800 })] };
    expect(check(run([longer]), 'words').detail).toContain('"cobran"');
  });

  it('fails a scene with no text on screen at all', () => {
    expect(check(run([{ ...still(), text: [] }]), 'words').detail).toContain('"¿Cuánto" of "¿Cuánto te cobran" is not on screen');
  });

  it('reads the words of all the stills of a scene together, for lines that replace each other', () => {
    const first = still();
    const early: Still = { ...first, text: [get(first.text, 0)] };
    const late: Still = { ...first, frame: first.frame + 20, text: [get(first.text, 1)] };
    expect(fail(run([early]), 'words')).toBe(true);
    expect(fail(run([late]), 'words')).toBe(true);
    expect(fail(run([early, late]), 'words')).toBe(false);
  });

  it('does not take the words of one scene for the words of another', () => {
    const body = stillOf(1); // body[0]
    const swapped: Still = { ...body, text: still().text };
    expect(check(run([swapped]), 'words').where).toEqual(['body[0]']);
  });
});

describe('palette', () => {
  it('fails text in a color that is not in the site palette', () => {
    const checks = run([still({ colors: ['rgb(200, 30, 30)'] })]);
    expect(fail(checks, 'palette')).toBe(true);
    expect(check(checks, 'palette').detail).toContain('#c81e1e');
  });

  it('accepts the colors of the site, white and near-black', () => {
    for (const color of ['rgb(11, 122, 75)', 'rgb(31, 42, 36)', 'rgb(244, 185, 66)', 'rgb(255, 255, 255)', 'rgb(17, 17, 17)'])
      expect(fail(run([still({ colors: [color] })]), 'palette')).toBe(false);
  });

  it('does not mistake black for near-black', () => expect(fail(run([still({ colors: ['rgb(0, 0, 0)'] })]), 'palette')).toBe(true));

  it('compares the color itself: opacity and transparency are the contrast check business', () => {
    expect(fail(run([still({ colors: ['rgba(31, 42, 36, 0.3)'], opacity: 0.5 })]), 'palette')).toBe(false);
  });

  it('does not depend on the case the site spells its hex in', () => {
    const loud: SiteData = { ...siteShop, brand: { ...siteShop.brand, colors: siteShop.brand.colors.map((c) => ({ ...c, hex: c.hex.toUpperCase() })) } };
    expect(fail(run([still()], '9x16', loud), 'palette')).toBe(false);
  });

  it('fails a color it cannot read', () => expect(fail(run([still({ colors: ['oklch(0.5 0.1 200)'] })]), 'palette')).toBe(true));
});

describe('where', () => {
  // Hook 0 video: index 0 is hooks[0][0], 1 to 4 are body[0] to body[3], 5 is the cta.
  it('holds the path of each scene that fails, in the order of the stills', () => {
    const stills = [stillOf(5, { fontSize: 20 }), stillOf(0, { fontSize: 20 }), stillOf(1, { fontSize: 20 })];
    expect(check(run(stills), 'min-size').where).toEqual(['cta', 'hooks[0][0]', 'body[0]']);
  });

  it('holds only the scenes that fail', () => {
    const stills = [stillOf(0), stillOf(3, { fontSize: 20 }), stillOf(5)];
    expect(check(run(stills), 'min-size').where).toEqual(['body[2]']);
  });

  it('holds a scene once, however many of its boxes and stills fail', () => {
    const bad = stillOf(1, { fontSize: 20 });
    expect(check(run([bad, { ...bad, frame: bad.frame + 1 }]), 'min-size').where).toEqual(['body[0]']);
  });

  it('keeps each check to its own scenes', () => {
    const checks = run([stillOf(0), stillOf(2, { fontSize: 20 }), stillOf(5, { colors: ['rgb(200, 30, 30)'] })]);
    expect(check(checks, 'min-size').where).toEqual(['body[1]']);
    expect(check(checks, 'palette').where).toEqual(['cta']);
    expect(check(checks, 'safe-zone').where).toEqual([]);
  });

  it('follows the hook it is given: its own scenes, then the shared body and cta', () => {
    // Hook 2 has two scenes: index 0 and 1 are hooks[2][0] and hooks[2][1], 2 to 5 are the body, 6 is the cta.
    const stills = [0, 1, 2, 5, 6].map((index) => stillOf(index, { fontSize: 20 }, 2));
    expect(check(run(stills, '9x16', siteShop, 2), 'min-size').where).toEqual(['hooks[2][0]', 'hooks[2][1]', 'body[0]', 'body[3]', 'cta']);
  });

  it('does not ask the stills for their path: it finds the scene by index', () => {
    const lost: Still = { ...stillOf(1, { fontSize: 20 }), path: 'somewhere/else.jpg' };
    expect(check(run([lost]), 'min-size').where).toEqual(['body[0]']);
  });

  it('throws when a still has no scene in the video of the hook', () => {
    expect(() => run([stillOf(0), { ...stillOf(0), index: 6 }])).toThrow(RangeError); // hook 0 has 6 scenes
    expect(() => run([{ ...stillOf(0), index: -1 }])).toThrow(RangeError);
  });

  it('throws when the hook does not exist', () => {
    expect(() => run([stillOf(0)], '9x16', siteShop, 3)).toThrow(RangeError);
  });
});
