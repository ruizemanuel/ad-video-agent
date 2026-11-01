import { describe, expect, it } from 'vitest';
import {
  contrast,
  EdlSchema,
  layoutScenes,
  sceneSurfaces,
  SURFACE_SEPARATION,
  theme,
  videoSurfaces,
  wipeColor,
  type PieceName,
  type Scene,
  type SiteData,
  type Surfaces,
} from '../src/index';
import edlShopJson from './fixtures/edl-shop.json';
import siteShopJson from './fixtures/site-shop.json';

const edlShop = EdlSchema.parse(edlShopJson);
const siteShop = siteShopJson as SiteData;
const surfaces = theme(siteShop).surfaces;
const recolor = (colors: SiteData['brand']['colors']): SiteData => ({ ...siteShop, brand: { ...siteShop.brand, colors } });

// The scenes of a video made of these pieces: the first is its hook, the last its close, the rest its body.
const videoOf = (...pieces: PieceName[]) => {
  const [hook, ...rest] = pieces.map((piece) => ({ piece, beats: 4, lines: [] }));
  const cta = rest.pop();
  if (!hook || !cta) throw new Error('a video needs a hook and a close');
  return layoutScenes({ ...edlShop, hooks: [[hook]], body: rest, cta }, 0).scenes;
};

// The scenes of a video whose hook is these scenes (so it can hold a WordFlash of n words), followed by these pieces: the last
// is its close.
const flash = (n: number): Scene => ({
  piece: 'WordFlash',
  beats: 2 * n,
  lines: Array.from({ length: n }, (_, k) => ({ text: `word${k}`, kind: 'framing' as const })),
});
const plainHook = (piece: PieceName): Scene => ({ piece, beats: 4, lines: [] });
const hooked = (hook: readonly Scene[], ...rest: PieceName[]) => {
  const [cta] = rest.splice(-1);
  if (!cta) throw new Error('a video needs a close');
  return layoutScenes({ ...edlShop, hooks: [[...hook]], body: rest.map(plainHook), cta: plainHook(cta) }, 0).scenes;
};

describe('sceneSurfaces', () => {
  it('keeps product scenes and a branded opening on the page background', () => {
    const scenes = videoOf('KineticHeadline', 'UiFocus', 'UiScroll', 'TypeIn', 'EndCard');
    expect(sceneSurfaces(scenes, surfaces)).toEqual(['base', 'base', 'base', 'base', 'brand']);
  });

  it('alternates type scenes between contrast and brand', () => {
    const scenes = videoOf('UiFocus', 'ClaimStack', 'UiScroll', 'KineticHeadline', 'UiFocus', 'WordCycle', 'UiFocus', 'EndCard');
    expect(sceneSurfaces(scenes, surfaces)).toEqual(['base', 'contrast', 'base', 'brand', 'base', 'contrast', 'base', 'brand']);
  });

  it('never puts a type scene on brand right before the brand close', () => {
    const scenes = videoOf('UiFocus', 'ClaimStack', 'UiScroll', 'KineticHeadline', 'EndCard');
    expect(sceneSurfaces(scenes, surfaces)).toEqual(['base', 'contrast', 'base', 'contrast', 'brand']);
  });

  it('falls back to base when both colors clash', () => {
    const scenes = videoOf('UiFocus', 'ClaimStack', 'KineticHeadline', 'EndCard');
    expect(sceneSurfaces(scenes, surfaces)).toEqual(['base', 'contrast', 'base', 'brand']);
  });

  it('closes on contrast when the brand surface is unusable', () => {
    const scenes = videoOf('UiFocus', 'ClaimStack', 'UiFocus', 'ClaimStack', 'EndCard');
    expect(sceneSurfaces(scenes, { ...surfaces, brand: null })).toEqual(['base', 'contrast', 'base', 'base', 'contrast']);
  });

  it('alternates type scenes that follow each other, so neighbors never share a background', () => {
    const scenes = videoOf('ClaimStack', 'KineticHeadline', 'WordCycle', 'KineticHeadline', 'EndCard');
    expect(sceneSurfaces(scenes, surfaces)).toEqual(['contrast', 'brand', 'contrast', 'base', 'brand']);
  });

  describe('the cards of a series', () => {
    it('gives the cards of a series one background', () => {
      const scenes = videoOf('UiFocus', 'PointCard', 'PointCard', 'PointCard', 'UiScroll', 'EndCard');
      expect(sceneSurfaces(scenes, surfaces)).toEqual(['base', 'contrast', 'contrast', 'contrast', 'base', 'brand']);
    });

    it('takes brand for a series after a contrast scene, and goes on alternating after it', () => {
      const scenes = videoOf('UiFocus', 'ClaimStack', 'PointCard', 'PointCard', 'UiFocus', 'ClaimStack', 'UiFocus', 'EndCard');
      expect(sceneSurfaces(scenes, surfaces)).toEqual(['base', 'contrast', 'brand', 'brand', 'base', 'contrast', 'base', 'brand']);
    });

    it('goes on alternating from the surface the series took', () => {
      const scenes = videoOf('UiFocus', 'PointCard', 'PointCard', 'UiScroll', 'ClaimStack', 'UiFocus', 'EndCard');
      expect(sceneSurfaces(scenes, surfaces)).toEqual(['base', 'contrast', 'contrast', 'base', 'brand', 'base', 'brand']);
    });

    it('takes contrast for a series whatever the turn', () => {
      // After the ClaimStack the turn is brand's, but the series takes contrast, its first choice, where its neighbors allow.
      const scenes = videoOf('UiFocus', 'ClaimStack', 'UiFocus', 'PointCard', 'PointCard', 'UiFocus', 'EndCard');
      expect(sceneSurfaces(scenes, surfaces)).toEqual(['base', 'contrast', 'base', 'contrast', 'contrast', 'base', 'brand']);
    });

    it('falls back to base for a series between a contrast scene and the brand close', () => {
      const scenes = videoOf('UiFocus', 'ClaimStack', 'PointCard', 'PointCard', 'EndCard');
      expect(sceneSurfaces(scenes, surfaces)).toEqual(['base', 'contrast', 'base', 'base', 'brand']);
    });

    it('keeps a series off the contrast of its neighbor when the brand surface is unusable', () => {
      const scenes = videoOf('UiFocus', 'ClaimStack', 'PointCard', 'PointCard', 'UiFocus', 'EndCard');
      expect(sceneSurfaces(scenes, { ...surfaces, brand: null })).toEqual(['base', 'contrast', 'base', 'base', 'base', 'contrast']);
    });
  });

  it('ends each scene where the next one starts from', () => {
    expect(sceneSurfaces(hooked([flash(3)], 'UiFocus', 'EndCard'), surfaces)).toEqual(['brand', 'base', 'brand']);
  });

  it('gives every scene a surface the site has', () => {
    const { scenes } = layoutScenes(edlShop, 0);
    const names = sceneSurfaces(scenes, surfaces);
    expect(names).toHaveLength(scenes.length);
    for (const name of names) expect(['base', 'contrast', 'brand']).toContain(name);
    const without = sceneSurfaces(scenes, { ...surfaces, brand: null });
    expect(without).toHaveLength(scenes.length);
    expect(without).not.toContain('brand');
  });
});

describe('videoSurfaces', () => {
  const noBrand = { ...surfaces, brand: null };

  it('gives a scene that is not a flash one background', () => {
    const scenes = videoOf('UiFocus', 'ClaimStack', 'UiScroll', 'EndCard');
    expect(videoSurfaces(scenes, surfaces)).toEqual([['base'], ['contrast'], ['base'], ['brand']]);
  });

  it('puts the first word of a flash that opens the video on the page, under the brand, and the last on brand', () => {
    expect(videoSurfaces(hooked([flash(3)], 'UiFocus', 'EndCard'), surfaces)).toEqual([['base', 'contrast', 'brand'], ['base'], ['brand']]);
    expect(videoSurfaces(hooked([flash(2)], 'UiFocus', 'EndCard'), surfaces)[0]).toEqual(['base', 'brand']);
    expect(videoSurfaces(hooked([flash(4)], 'UiFocus', 'EndCard'), surfaces)[0]).toEqual(['base', 'brand', 'contrast', 'brand']);
    expect(videoSurfaces(hooked([flash(5)], 'UiFocus', 'EndCard'), surfaces)[0]).toEqual(['base', 'contrast', 'brand', 'contrast', 'brand']);
  });

  it('goes on alternating after a flash', () => {
    const scenes = hooked([flash(3)], 'ClaimStack', 'UiFocus', 'ClaimStack', 'UiFocus', 'EndCard');
    expect(videoSurfaces(scenes, surfaces)).toEqual([['base', 'contrast', 'brand'], ['contrast'], ['base'], ['brand'], ['base'], ['brand']]);
  });

  it('keeps the first word of a flash second in its hook off the scene before it', () => {
    expect(videoSurfaces(hooked([plainHook('UiFocus'), flash(2)], 'ClaimStack', 'UiFocus', 'EndCard'), surfaces)).toEqual([
      ['base'],
      ['contrast', 'brand'],
      ['contrast'],
      ['base'],
      ['brand'],
    ]);
    expect(videoSurfaces(hooked([plainHook('ClaimStack'), flash(2)], 'UiFocus', 'EndCard'), surfaces)).toEqual([
      ['contrast'],
      ['base', 'brand'],
      ['base'],
      ['brand'],
    ]);
  });

  it('keeps the last word off the brand close right after it', () => {
    expect(videoSurfaces(hooked([flash(3)], 'EndCard'), surfaces)).toEqual([['base', 'brand', 'contrast'], ['brand']]);
  });

  it('alternates the words between the page and contrast when the brand surface is unusable', () => {
    expect(videoSurfaces(hooked([flash(3)], 'UiFocus', 'EndCard'), noBrand)).toEqual([['base', 'contrast', 'base'], ['base'], ['contrast']]);
    expect(videoSurfaces(hooked([flash(4)], 'UiFocus', 'EndCard'), noBrand)).toEqual([['base', 'contrast', 'base', 'contrast'], ['base'], ['contrast']]);
    expect(videoSurfaces(hooked([flash(3)], 'ClaimStack', 'UiFocus', 'EndCard'), noBrand)).toEqual([
      ['base', 'contrast', 'base'],
      ['contrast'],
      ['base'],
      ['contrast'],
    ]);
    expect(videoSurfaces(hooked([plainHook('ClaimStack'), flash(3)], 'UiFocus', 'EndCard'), noBrand)).toEqual([
      ['contrast'],
      ['base', 'contrast', 'base'],
      ['base'],
      ['contrast'],
    ]);
  });

  it('never puts two words of a flash in a row on one background', () => {
    const befores: PieceName[][] = [[], ['UiFocus'], ['ClaimStack']];
    const afters: PieceName[][] = [
      ['UiFocus', 'EndCard'],
      ['ClaimStack', 'UiFocus', 'EndCard'],
    ];
    for (const set of [surfaces, noBrand]) {
      for (const n of [2, 3, 4, 5]) {
        for (const before of befores) {
          for (const after of afters) {
            const runs = videoSurfaces(hooked([...before.map(plainHook), flash(n)], ...after), set);
            const at = before.length;
            const words = runs[at] ?? [];
            const previous = runs[at - 1]?.at(-1);
            const label = `${set.brand ? 'brand' : 'no brand'}, ${n} words, after ${before.join() || 'nothing'}, before ${after.join()}: ${words.join()}`;
            expect(words, label).toHaveLength(n);
            words.slice(1).forEach((name, k) => expect(name, label).not.toBe(words[k]));
            if (at === 0) expect(words[0], label).toBe('base');
            if (previous && previous !== 'base') expect(words[0], label).not.toBe(previous);
          }
        }
      }
    }
  });
});

describe('wipeColor', () => {
  it('wipes in the primary between page scenes', () => expect(wipeColor(surfaces, 'base', 'base')).toBe('#0b7a4b'));

  it('wipes in a color that shows against a brand scene', () => {
    expect(wipeColor(surfaces, 'base', 'brand')).toBe('#1f2a24');
    expect(wipeColor(surfaces, 'contrast', 'brand')).toBe('#f7f7f2');
  });

  it('wipes between two cards of a series in a color that shows on their shared background', () => {
    expect(wipeColor(surfaces, 'contrast', 'contrast')).toBe('#0b7a4b');
    expect(wipeColor(surfaces, 'brand', 'brand')).toBe('#1f2a24');
  });

  it('does not depend on the side a scene is on', () => {
    expect(wipeColor(surfaces, 'brand', 'base')).toBe(wipeColor(surfaces, 'base', 'brand'));
  });

  describe('on a site without a brand surface, where the primary is one of the two sides', () => {
    const shows = (s: Surfaces, color: string) => [s.base.bg, s.contrast.bg].every((bg) => contrast(color, bg) >= SURFACE_SEPARATION);

    it('wipes in another color of the site that shows against both: a gray between yellow and black', () => {
      // No primary: the black text stands for it, and it is the contrast background too, so the primary, the contrast
      // background and the page all match a side. The gray text reads 3.66:1 on the black, more on the yellow.
      const celo = theme(
        recolor([
          { hex: '#fcff52', role: 'bg', weight: 0.902 },
          { hex: '#fcf6f1', role: 'bg', weight: 0.096 },
          { hex: '#000000', role: 'text', weight: 0.672 },
          { hex: '#666666', role: 'text', weight: 0.317 },
        ]),
      ).surfaces;
      expect([celo.base.button.bg, celo.contrast.bg, celo.brand]).toEqual(['#000000', '#000000', null]);
      expect(wipeColor(celo, 'base', 'contrast')).toBe('#666666');
      expect(shows(celo, wipeColor(celo, 'base', 'contrast'))).toBe(true);
    });

    it('wipes in the accent of the site before its other colors', () => {
      // The primary is the darkest color of the site, so it is the contrast background; the accent shows against both.
      const navy = theme(
        recolor([
          { hex: '#f7f7f2', role: 'bg', weight: 0.9 },
          { hex: '#5b655f', role: 'text', weight: 0.2 },
          { hex: '#1f2a24', role: 'primary', weight: 0.6 },
          { hex: '#f4b942', role: 'accent', weight: 0.2 },
        ]),
      ).surfaces;
      expect(navy.contrast.bg).toBe(navy.base.button.bg);
      expect(wipeColor(navy, 'base', 'contrast')).toBe('#f4b942');
      expect(shows(navy, wipeColor(navy, 'base', 'contrast'))).toBe(true);
    });

    it('takes the color that stands out most on the side it stands out less on, when none stands apart from both', () => {
      // White and near-black are the two sides; the light gray is the only other color, 1.16:1 on the white.
      const mono = theme(
        recolor([
          { hex: '#ffffff', role: 'bg', weight: 0.9 },
          { hex: '#eeeeee', role: 'bg', weight: 0.05 },
          { hex: '#111111', role: 'text', weight: 0.8 },
          { hex: '#111111', role: 'primary', weight: 0.5 },
        ]),
      ).surfaces;
      expect([mono.base.bg, mono.contrast.bg]).toEqual(['#ffffff', '#111111']);
      expect(wipeColor(mono, 'base', 'contrast')).toBe('#eeeeee');
    });
  });

  it('rejects a brand scene when the brand surface is unusable', () => {
    expect(() => wipeColor({ ...surfaces, brand: null }, 'base', 'brand')).toThrow(RangeError);
  });
});
