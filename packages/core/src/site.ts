// What the capture records about a site, as far as the video needs it. Coordinates are in pixels of the shot.

export type Box = {
  shotId: string;
  sectionId?: string;
  kind: 'heading' | 'cta' | 'image' | 'price';
  text?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * The element begins above the top of the shot (a section shot starts partway down the page): only its part in the
   * shot is recorded, from y 0, and the top of the shot cuts it. Captures made before this was recorded never say so.
   */
  clippedTop?: true;
};

/**
 * A card of the page: an element that draws a surface of its own (a border all round, its own or one a pseudo-element draws
 * over it, a shadow, a background unlike what is behind it, or a background image), narrower than the screen and at most
 * 1.2 screens tall. The camera frames a whole
 * card and keeps the edges of the view from slicing one. `clippedTop` as for a box.
 */
export type Block = { shotId: string; x: number; y: number; w: number; h: number; clippedTop?: true };

export type Shot = {
  id: string;
  file: string;
  viewport: 'desktop' | 'mobile';
  dpr: 2;
  sectionId?: string;
  width: number;
  height: number;
};

export type FontFile = { file: string; weight: string; stretch?: string };

export type SiteFont = {
  family: string;
  role: 'display' | 'body';
  source: 'google' | 'fontsource' | 'other';
  url?: string;
  files?: FontFile[];
  weight?: string;
  stretch?: string;
  letterSpacingEm?: number;
  lineHeight?: number;
  /** The display font also sets the body text. */
  alsoBody?: boolean;
};

/** A section of an extra page (a demo the site links to, a page the client named). It is there to be filmed: its text never backs a claim. */
export type ExtraSection = { id: string; heading: string; text: string; ctas: string[]; /** The address of the page it came from. */ page: string };

/** What the capture did, for whoever has to find out why a site came out as it did. The video does not read it. */
export type CaptureLog = { startedAt: string; finishedAt?: string; notes: string[]; timings: Record<string, number> };

export type SiteData = {
  url: string;
  lang: string;
  title: string;
  description: string;
  sections: { id: string; heading: string; text: string; ctas: string[] }[];
  brand: {
    /** `hex` is `#rrggbb`. `weight` is the share of the page that uses the color. */
    colors: { hex: string; role: 'bg' | 'text' | 'primary' | 'accent'; weight: number }[];
    fonts: SiteFont[];
    /**
     * `png` is a raster of the whole logo (DPR 4, transparent); the video shows it, or `file` when there is none.
     * `width` and `height` are the natural size of that picture in pixels, when the capture could read it: every render
     * of the video decides from them whether the logo reads, instead of loading the picture to find out.
     */
    logo?: { file: string; kind: 'svg' | 'png'; png?: string; width?: number; height?: number };
    ogImage?: string;
  };
  shots: Shot[];
  boxes: Box[];
  /**
   * The cards of each shot, nested ones included, in document order. Only the camera reads them: the director never sees
   * them, so they do not count in `boxIndex`. Captures made before blocks were recorded have none.
   */
  blocks?: Block[];
  recordings: { file: string; viewport: 'desktop' | 'mobile'; seconds: number }[];
  /** The sections of the extra pages. Ids continue those of `sections`, so they are unique across pages. */
  extraSections?: ExtraSection[];
  log?: CaptureLog;
};
