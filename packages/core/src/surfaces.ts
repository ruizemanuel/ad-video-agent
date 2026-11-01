// Which background each scene of a video takes, and the color the wipe brings in between two of them. Pure and
// deterministic, so the render and its checks agree on what a video looks like.
import { SURFACE_SEPARATION, contrast, type SurfaceName, type Surfaces } from './brand';
import { opensWithBrand, type TimedScene } from './timing';

type Loud = Exclude<SurfaceName, 'base'>;

// The scenes whose background is not a choice: the product shots, the typing and the opening headline are designed on
// the page's own colors (the logo reads on them), and the close is the brand's own moment. The type scenes
// (undefined here) are the ones that alternate.
const pinned = (t: TimedScene, surfaces: Surfaces): SurfaceName | undefined => {
  if (opensWithBrand(t)) return 'base';
  switch (t.scene.piece) {
    case 'UiFocus':
    case 'UiScroll':
    case 'TypeIn':
      return 'base';
    case 'EndCard':
      return surfaces.brand ? 'brand' : 'contrast';
    case 'KineticHeadline':
    case 'ClaimStack':
    case 'WordCycle':
      return undefined;
  }
};

/**
 * The background of each scene of one version of the video (a hook with the shared body and cta), in order. The type
 * scenes take contrast and brand in turn, so the video keeps changing color. One never takes the surface of its
 * neighbor (a cut between two backgrounds that look the same shows nothing), and the close is brand, so the scene before
 * it is never. The turn is spent only when a scene takes it: a scene that gives way for a neighbor leaves it to the next.
 */
export const sceneSurfaces = (scenes: readonly TimedScene[], surfaces: Surfaces): SurfaceName[] => {
  const fixed = scenes.map((t) => pinned(t, surfaces));
  const names: SurfaceName[] = [];
  // Without a usable brand surface, contrast is all the type scenes have.
  const turns: Loud[] = surfaces.brand ? ['contrast', 'brand'] : ['contrast'];
  let turn = 0;
  scenes.forEach((_, i) => {
    const pin = fixed[i];
    if (pin) {
      names.push(pin);
      return;
    }
    // The neighbors this scene must differ from: the scene before it, and the one after it when its surface is already set.
    // A neighbor on `base` never matches a candidate, which is never `base`: a cut to or from the plain page always shows.
    const taken = new Set<SurfaceName | undefined>([names[i - 1], fixed[i + 1]]);
    const wanted = turns[turn % turns.length];
    const other = turns.find((name) => name !== wanted);
    if (wanted && !taken.has(wanted)) {
      names.push(wanted);
      turn++;
    } else if (other && !taken.has(other)) {
      names.push(other);
    } else {
      names.push('base');
    }
  });
  return names;
};

const surfaceOf = (surfaces: Surfaces, name: SurfaceName) => {
  const colors = surfaces[name];
  if (!colors) throw new RangeError(`There is no ${name} surface to wipe against.`);
  return colors;
};

/**
 * The wipe's color into a cut: the first color that stands apart (SURFACE_SEPARATION) from both scenes, so the wipe shows
 * against each side, of the primary, the contrast background, the page background and then the rest of the site's palette
 * (see Surfaces): on a site without a brand surface the primary is often one of the sides, and the other two backgrounds
 * are the sides. When none does, the one that stands out most on the side it stands out less on.
 */
export const wipeColor = (surfaces: Surfaces, before: SurfaceName, after: SurfaceName): string => {
  const sides = [surfaceOf(surfaces, before).bg, surfaceOf(surfaces, after).bg];
  const pool = [surfaces.base.button.bg, surfaces.contrast.bg, surfaces.base.bg, ...surfaces.palette];
  const weaker = (color: string) => Math.min(...sides.map((bg) => contrast(color, bg)));
  return pool.find((color) => weaker(color) >= SURFACE_SEPARATION) ?? pool.reduce((best, color) => (weaker(color) > weaker(best) ? color : best));
};
