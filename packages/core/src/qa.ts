// Code checks on the key frames of a video, before any model looks at them: text inside the platform safe zones,
// no text below the minimum size, enough contrast once opacity is counted, every word of every line on screen, and
// only colors of the site. They measure the real DOM of the rendered frame (the probe), so they catch what the edit
// list alone cannot: a line that wraps out of the zone, a fade that washes a color out, a word that got cut.
import { MIN_CONTRAST, NEAR_BLACK, WHITE, contrast, mix, theme } from './brand';
import type { Edl, PieceName, Scene } from './edl';
import { FORMATS, TYPE, type Format } from './formats';
import type { SiteData } from './site';
import { layoutScenes, type SceneRole } from './timing';
import { timedScenePath } from './validate';

/** One line of text as the probe measures it in the rendered frame (a `[data-qa-line]` element). */
export type ProbeItem = {
  text: string;
  /** The box of the text in frame pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  font: string;
  /** Computed CSS colors (`rgb(...)` or `rgba(...)`) of the line and of its spans, such as an accent word. */
  colors: string[];
  /** The opacity of the line times that of every ancestor. */
  opacity: number;
  /** Computed background of the nearest ancestor that has one, or null when there is none (the frame is read as white). */
  bg: string | null;
};

/** A key frame of one scene. `path` is the scene path (`hooks[h][j]`, `body[j]` or `cta`), see timedScenePath. */
export type Still = {
  /** Position of the scene in layoutScenes(edl, hook).scenes. */
  index: number;
  role: SceneRole;
  piece: PieceName;
  frame: number;
  path: string;
  text: ProbeItem[];
  jpegBase64: string;
};

/** `where` holds the scene paths that fail the check, each once; it is empty when the check passes. */
export type Check = { name: string; pass: boolean; detail: string; where: string[] };

type Failure = { path: string; message: string };

// A text box may overshoot the zone by a pixel: the probe measures sub-pixel boxes.
const SLACK = 1;

type Rgba = { hex: string; alpha: number };

// How Chrome writes a computed color: `rgb(r, g, b)` or `rgba(r, g, b, a)`. Anything else is not read.
const CSS_COLOR = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*(?:,\s*(\d+(?:\.\d+)?)\s*)?\)$/;

const readColor = (css: string): Rgba | undefined => {
  const match = CSS_COLOR.exec(css.trim());
  if (!match) return undefined;
  const channels = [match[1], match[2], match[3]].map(Number);
  const alpha = match[4] === undefined ? 1 : Number(match[4]);
  if (channels.some((v) => v > 255) || alpha > 1) return undefined;
  return { hex: '#' + channels.map((v) => Math.round(v).toString(16).padStart(2, '0')).join(''), alpha };
};

// The colors a text may have: the theme, the site's own and the two fallbacks of the theme.
const paletteOf = (site: SiteData): Set<string> => {
  const themed = Object.values(theme(site)).filter((v): v is string => typeof v === 'string');
  return new Set([...site.brand.colors.map((c) => c.hex), ...themed, WHITE, NEAR_BLACK].map((hex) => hex.toLowerCase()));
};

// Whole words, ignoring case and the kind of space between them.
const wordsOf = (text: string): string[] => text.normalize('NFC').split(/\s+/).filter(Boolean);

const verdict = (name: string, failures: Failure[], okDetail: string): Check => ({
  name,
  pass: failures.length === 0,
  detail: failures.length ? failures.map((f) => f.message).join(' | ') : okDetail,
  where: [...new Set(failures.map((f) => f.path))],
});

/**
 * Runs the code checks on the key frames of the video of `hook` in `format`. Each still is matched to its scene by
 * `still.index` in layoutScenes(edl, hook), and a failing check names that scene's path in `where`. A scene may have
 * several stills (lines that replace each other); its words are read together. The checks are `safe-zone`, `min-size`,
 * `contrast`, `words` and `palette`, and all of them block. Throws a RangeError for a still that has no scene.
 */
export const checkStills = (stills: Still[], edl: Edl, site: SiteData, format: Format, hook = 0): Check[] => {
  const { width, height, safe } = FORMATS[format];
  const minSize = TYPE[format].min;
  const palette = paletteOf(site);
  const { scenes } = layoutScenes(edl, hook);

  const outside: Failure[] = [];
  const small: Failure[] = [];
  const lowContrast: Failure[] = [];
  const offPalette: Failure[] = [];
  const onScreen = new Map<number, { path: string; scene: Scene; texts: string[] }>();

  for (const still of stills) {
    const timed = scenes.find((t) => t.index === still.index);
    if (!timed) throw new RangeError(`There is no scene ${still.index} in the video of hook ${hook}; it has ${scenes.length}.`);
    const path = timedScenePath(edl, hook, timed);
    const shown = onScreen.get(timed.index) ?? { path, scene: timed.scene, texts: [] };
    onScreen.set(timed.index, shown);

    for (const item of still.text) {
      shown.texts.push(item.text);
      const at = `${path} "${item.text}"`;

      const [left, top, right, bottom] = [item.x, item.y, item.x + item.w, item.y + item.h];
      const box = `at x ${Math.round(left)}-${Math.round(right)}, y ${Math.round(top)}-${Math.round(bottom)}`;
      if (left < 0 || top < 0 || right > width || bottom > height) outside.push({ path, message: `${at} ${box} runs past the frame edge` });
      else if (left < safe.left - SLACK || right > width - safe.right + SLACK || top < safe.top - SLACK || bottom > height - safe.bottom + SLACK)
        outside.push({ path, message: `${at} ${box} is outside the safe zone` });

      if (item.fontSize < minSize) small.push({ path, message: `${at} at ${item.fontSize}px (min ${minSize})` });

      // Text drawn at some opacity over its background is seen as the blend of both. A frame without a background is white,
      // and the transparency of a background is not counted: what lies under it is not in the probe.
      const background = item.bg === null ? { hex: WHITE, alpha: 1 } : readColor(item.bg);
      if (!background) lowContrast.push({ path, message: `${at} has a background that cannot be read: "${item.bg}"` });
      for (const css of item.colors) {
        const color = readColor(css);
        if (!color) {
          // Not reading a color is not passing it: it is neither measured nor known to be a color of the site.
          const message = `${at} has a color that cannot be read: "${css}"`;
          lowContrast.push({ path, message });
          offPalette.push({ path, message });
          continue;
        }
        if (!palette.has(color.hex)) offPalette.push({ path, message: `${at} uses ${color.hex}, which is not a color of the site` });
        if (!background) continue;
        const opacity = item.opacity * color.alpha;
        const seen = mix(background.hex, color.hex, opacity);
        const ratio = contrast(seen, background.hex);
        if (ratio < MIN_CONTRAST) {
          const faded = opacity < 1 ? ` (opacity ${Number(opacity.toFixed(2))})` : '';
          lowContrast.push({ path, message: `${at} ${seen} on ${background.hex} = ${ratio.toFixed(2)}:1${faded}` });
        }
      }
    }
  }

  // Every word of every line of a scene must be on screen in one of its stills, whole.
  const missing: Failure[] = [];
  for (const { path, scene, texts } of onScreen.values()) {
    const shown = new Set(texts.flatMap(wordsOf).map((w) => w.toLowerCase()));
    for (const line of scene.lines)
      for (const word of wordsOf(line.text))
        if (!shown.has(word.toLowerCase())) missing.push({ path, message: `${path}: "${word}" of "${line.text}" is not on screen` });
  }

  const count = `${stills.length} ${stills.length === 1 ? 'still' : 'stills'}`;
  return [
    verdict('safe-zone', outside, `${count}, all text inside the ${format} safe zone`),
    verdict('min-size', small, `${count}, no text below ${minSize}px in ${format}`),
    verdict('contrast', lowContrast, `${count}, every text color has ${MIN_CONTRAST}:1 on its background once opacity is counted`),
    verdict('words', missing, `${count}, every word of every line is on screen`),
    verdict('palette', offPalette, `${count}, all text in colors of the site`),
  ];
};
