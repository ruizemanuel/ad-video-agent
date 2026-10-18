// What the director and the corrector read of a capture: the text of each section with its id (what a claim quotes),
// the brand in a few words, and each shot with the boxes the camera can aim at, numbered as `boxIndex` counts them.
// Files, font metrics and the capture's log stay out: the model has no use for them, and they cost tokens.
import { siteHost, type Box, type SiteData } from '@app/core';

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
    boxes: { boxIndex: number; kind: Box['kind']; sectionId: string | undefined; text: string | undefined }[];
  }[];
};

export const siteForModel = (site: SiteData): ModelSite => ({
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
      .map((box, boxIndex) => ({ boxIndex, kind: box.kind, sectionId: box.sectionId, text: box.text })),
  })),
});
