import { describe, expect, it } from 'vitest';
import { EdlSchema, layoutScenes, sceneSurfaces, theme, wipeColor, type PieceName, type SiteData, type Surfaces } from '../src/index';
import edlShopJson from './fixtures/edl-shop.json';
import siteShopJson from './fixtures/site-shop.json';

const edlShop = EdlSchema.parse(edlShopJson);
const surfaces = theme(siteShopJson as SiteData).surfaces;

// The scenes of a video made of these pieces: the first is its hook, the last its close, the rest its body.
const videoOf = (...pieces: PieceName[]) => {
  const [hook, ...rest] = pieces.map((piece) => ({ piece, beats: 4, lines: [] }));
  const cta = rest.pop();
  if (!hook || !cta) throw new Error('a video needs a hook and a close');
  return layoutScenes({ ...edlShop, hooks: [[hook]], body: rest, cta }, 0).scenes;
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

  it('gives every scene a surface', () => {
    const { scenes } = layoutScenes(edlShop, 0);
    expect(sceneSurfaces(scenes, surfaces)).toHaveLength(scenes.length);
  });
});

describe('wipeColor', () => {
  it('wipes in the primary between page scenes', () => expect(wipeColor(surfaces, 'base', 'base')).toBe('#0b7a4b'));

  it('wipes in a color that shows against a brand scene', () => {
    expect(wipeColor(surfaces, 'base', 'brand')).toBe('#1f2a24');
    expect(wipeColor(surfaces, 'contrast', 'brand')).toBe('#f7f7f2');
  });

  it('does not depend on the side a scene is on', () => {
    expect(wipeColor(surfaces, 'brand', 'base')).toBe(wipeColor(surfaces, 'base', 'brand'));
  });

  it('falls back to the primary when no color stands apart from both scenes', () => {
    const flat = (bg: string) => ({ bg, fg: bg, muted: bg, accent: bg, button: { bg, fg: bg } });
    const same: Surfaces = { base: flat('#0b7a4b'), contrast: flat('#0b7a4b'), brand: flat('#0b7a4b') };
    expect(wipeColor(same, 'base', 'contrast')).toBe('#0b7a4b');
  });

  it('rejects a brand scene when the brand surface is unusable', () => {
    expect(() => wipeColor({ ...surfaces, brand: null }, 'base', 'brand')).toThrow(RangeError);
  });
});
