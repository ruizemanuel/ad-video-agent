// What the director and the corrector read of a capture: the text of each section with its id (what a claim quotes),
// the brand in a few words, and each shot with the boxes the camera can aim at, numbered as `boxIndex` counts them and
// marked with whether a UiFocus or a UiScroll may film them: product UI that the camera frames cleanly.
// Files, font metrics and the capture's log stay out: the model has no use for them, and they cost tokens.
import { framesCleanly, isProductTarget, MAIN_FORMAT, siteHost, type Box, type SiteData } from '@app/core';

export type ModelSite = {
  url: string;
  /** What a TypeIn url types: the host without "www.", as validateEdl compares it. */
  host: string;
  lang: string;
  title: string;
  description: string;
  sections: { id: string; heading: string; text: string; ctas: string[] }[];
  /** The sections of extra pages: there to be filmed, never quoted. */
  extraSections: { id: string; heading: string; page: string; note: string }[];
  brand: { colors: string[]; fonts: string[]; hasLogo: boolean };
  shots: {
    id: string;
    viewport: 'desktop' | 'mobile';
    sectionId: string;
    /**
     * `product`: an image or a price in the section or the card of the box (see isProductTarget), and a box the camera of a
     * UiFocus frames cleanly in the main video (see framesCleanly), as validateEdl demands of a UiFocus or UiScroll.
     */
    boxes: { boxIndex: number; kind: Box['kind']; sectionId: string | undefined; text: string | undefined; product: boolean }[];
  }[];
};

/** Whether a UiFocus or a UiScroll may film the box: product UI that a UiFocus frames cleanly in the main video. */
const canFilm = (site: SiteData, shotId: string, boxIndex: number): boolean =>
  isProductTarget(site, shotId, boxIndex) && framesCleanly(site, { piece: 'UiFocus', shotId, boxIndex }, MAIN_FORMAT);

// The flags of each site object. A step of the order reads the capture once and builds the model site from that object
// for the director and every round of the corrector; the camera's work for each box is worth doing once per step. Kept on
// the object rather than computed where the capture is read, so that no caller has to carry them along: the site is read
// only, never changed once parsed.
const flagsOf = new WeakMap<SiteData, ReadonlyMap<string, readonly boolean[]>>();

/** Whether a UiFocus or a UiScroll may film each box (see canFilm), by shot and in boxIndex order, computed once per site object. */
export const productFlags = (site: SiteData): ReadonlyMap<string, readonly boolean[]> => {
  const known = flagsOf.get(site);
  if (known) return known;
  const flags = new Map(site.shots.map((shot) => [shot.id, site.boxes.filter((box) => box.shotId === shot.id).map((_, boxIndex) => canFilm(site, shot.id, boxIndex))]));
  flagsOf.set(site, flags);
  return flags;
};

export const siteForModel = (site: SiteData): ModelSite => {
  const flags = productFlags(site);
  return {
    url: site.url,
    host: siteHost(site.url) ?? '',
    lang: site.lang,
    title: site.title,
    description: site.description,
    sections: site.sections.map(({ id, heading, text, ctas }) => ({ id, heading, text, ctas })),
    extraSections: (site.extraSections ?? []).map(({ id, heading, page }) => ({ id, heading, page, note: 'imagery only, not a claim source' })),
    brand: {
      colors: site.brand.colors.map((c) => `${c.role} ${c.hex}`),
      fonts: site.brand.fonts.map((f) => `${f.role}: ${f.family}`),
      hasLogo: site.brand.logo !== undefined,
    },
    shots: site.shots.map((shot) => ({
      id: shot.id,
      viewport: shot.viewport,
      sectionId: shot.sectionId ?? 'whole page',
      boxes: site.boxes
        .filter((box) => box.shotId === shot.id)
        .map((box, boxIndex) => ({ boxIndex, kind: box.kind, sectionId: box.sectionId, text: box.text, product: flags.get(shot.id)?.[boxIndex] ?? false })),
    })),
  };
};
