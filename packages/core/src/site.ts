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
};

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
    logo?: { file: string; kind: 'svg' | 'png'; png?: string };
    ogImage?: string;
  };
  shots: Shot[];
  boxes: Box[];
  recordings: { file: string; viewport: 'desktop' | 'mobile'; seconds: number }[];
};
