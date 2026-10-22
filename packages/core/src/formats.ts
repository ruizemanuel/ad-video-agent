// Frame shapes of the deliverables: size, platform safe zones and the type scale.
export type Format = '9x16' | '16x9' | '4x5';

export type Safe = { top: number; bottom: number; left: number; right: number };

// Safe zones keep text clear of the platform UI (TikTok and Reels cover the bottom and right).
export const FORMATS: Record<Format, { width: number; height: number; safe: Safe }> = {
  '9x16': { width: 1080, height: 1920, safe: { top: 220, bottom: 420, left: 60, right: 160 } },
  '16x9': { width: 1920, height: 1080, safe: { top: 60, bottom: 60, left: 60, right: 60 } },
  '4x5': { width: 1080, height: 1350, safe: { top: 80, bottom: 160, left: 60, right: 60 } },
};

/**
 * The highest a UI scene's caption starts, in px from the top: the content box of its first line starts at this line or
 * under it, and the card rises into the room a shorter caption leaves above it (see raisedMove). It is the largest top
 * zone the platforms publish for 9:16 ads: YouTube Shorts 288; TikTok 240, Reels 14 %. Other formats have none: their
 * card stays under a caption block of the format's full height.
 */
// Sources: https://support.google.com/google-ads/answer/9128498 (Shorts), https://ads.tiktok.com/help/article/tiktok-auction-in-feed-ads (TikTok), https://www.facebook.com/business/ads-guide/update/video/instagram-reels (Reels).
export const CAPTION_LINE: Partial<Record<Format, number>> = { '9x16': 288 };

// Type scale per format, in px. `min` is the smallest text allowed anywhere in the frame.
// Wide frames center type; tall frames keep it flush left, like the sites themselves.
export const TYPE: Record<Format, { headline: number; caption: number; min: number; logo: number; align: 'left' | 'center' }> = {
  '9x16': { headline: 150, caption: 100, min: 44, logo: 84, align: 'left' },
  '16x9': { headline: 176, caption: 88, min: 36, logo: 76, align: 'center' },
  '4x5': { headline: 128, caption: 88, min: 40, logo: 72, align: 'left' },
};

/**
 * The format of the main video: the one it is rendered in and the key frame review sees, so the one in which the camera
 * of a UI scene must frame its target cleanly (see framesCleanly) for the director to be offered that target. The VM's
 * protocol spells it as a literal of its own (KeyframesInput, RenderInput): a value on the wire.
 */
export const MAIN_FORMAT = '9x16' satisfies Format;

// Which capture viewport reads best in each frame shape.
export const PREFERRED_VIEWPORT: Record<Format, 'desktop' | 'mobile'> = {
  '9x16': 'mobile',
  '16x9': 'desktop',
  '4x5': 'mobile',
};

export const safeWidth = (format: Format): number => FORMATS[format].width - FORMATS[format].safe.left - FORMATS[format].safe.right;
