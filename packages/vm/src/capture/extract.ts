// What the capture reads from a page. The `inPage*` functions are sent to the browser and run inside the page, so each
// one is complete in itself: it can use the DOM and `window.__cap` (made by `inPageSetup`), and nothing else of this
// module. Their results come back as plain data. `pickColors` runs here, on what the page measured.
import type { Block, Box, SiteData } from '@app/core';

type Rgba = { r: number; g: number; b: number; a: number };
type Cap = {
  clean: (s: string | null | undefined) => string;
  visible: (el: Element) => boolean;
  makeShown: () => (el: Element) => boolean;
  toRgba: (c: string) => Rgba | null;
  hex: (c: { r: number; g: number; b: number }) => string;
  isButtonLike: (el: Element) => boolean;
  PRICE_RE: RegExp;
};
type CapWindow = Window & { __cap: Cap };

export type Weighted = [string, number][];
export type RawSection = { id: string; heading: string; text: string; ctas: string[] };
export type PageText = { lang: string; title: string; description: string; ogImage: string; sections: RawSection[] };
export type RawBrand = {
  bg: Weighted;
  text: Weighted;
  cta: Weighted;
  extra: Weighted;
  displayStack: string;
  bodyStack: string;
  displayWeight: string;
  displayStretch: string;
  displayMetrics: { letterSpacingEm: number; lineHeight: number } | null;
  stylesheets: string[];
  fontFaceSrcs: { family: string; src: string }[];
};
export type FoundLogo = {
  hasText: boolean;
  svg: string | null;
  imgSrc: string | null;
  rect: { w: number; h: number };
  wordmark?: boolean;
};
/** A box as the page measures it: the shot it belongs to is known by the caller. */
export type PageBox = Omit<Box, 'shotId'>;
/** A block as the page measures it: the shot it belongs to is known by the caller. */
export type PageBlock = Omit<Block, 'shotId'>;

/** Chrome caps its textures near 16384 device pixels, so a full-page shot stops at 8000 CSS pixels (at DPR 2). */
export const MAX_FULL_PAGE_CSS_PX = 8000;
/** A page whose height keeps growing as it is scrolled (infinite scroll) is read down to here. */
export const MAX_SCROLL_CSS_PX = 20_000;

/** Defines the helpers the other functions share, on `window`. Runs first on every page. */
export function inPageSetup(): void {
  const clean = (s: string | null | undefined): string => (s || '').replace(/\s+/g, ' ').trim();
  const visible = (el: Element): boolean => el.checkVisibility({ visibilityProperty: true });
  // What a screenshot shows of an element: it is visible, and not see-through, its effective opacity (its own times its
  // ancestors') being 0.05 or more. Content a reveal effect has not run yet (Framer starts it at 0.001) or has run back
  // when it left the screen (0) is in the page but not in the picture. One checker serves one pass: it remembers the
  // opacities it has read, and the page changes between passes.
  const makeShown = (): ((el: Element) => boolean) => {
    const opacities = new Map<Element, number>();
    const opacity = (el: Element | null): number => {
      if (!el) return 1;
      const known = opacities.get(el);
      if (known !== undefined) return known;
      const cs = getComputedStyle(el);
      // A wrapper with no box paints nothing, so its opacity applies to nothing.
      const value = (cs.display === 'contents' ? 1 : Number(cs.opacity)) * opacity(el.parentElement);
      opacities.set(el, value);
      return value;
    };
    return (el) => el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && opacity(el) >= 0.05;
  };
  const cvs = document.createElement('canvas');
  cvs.width = cvs.height = 1;
  const ctx = cvs.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('The page gave no 2D canvas to read colors with.');
  const toRgba = (c: string): Rgba | null => {
    if (!c || c === 'transparent') return null;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = c; // canvas converts any CSS color (oklch, lab...) to sRGB
    ctx.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 0] = ctx.getImageData(0, 0, 1, 1).data;
    return { r, g, b, a: a / 255 };
  };
  const hex = ({ r, g, b }: { r: number; g: number; b: number }): string => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  const isButtonLike = (el: Element): boolean => {
    const tag = el.localName;
    const text = clean((el as HTMLElement).innerText);
    // A button label is short; a long text in a link is a paragraph.
    if (!text || text.length > 40) return false;
    if (tag === 'button' || el.getAttribute('role') === 'button') return true;
    if (tag !== 'a') return false;
    const cs = getComputedStyle(el);
    const bg = toRgba(cs.backgroundColor);
    const hasBg = bg && bg.a > 0.1;
    const hasBorder = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none';
    // Vertical room may come from padding or from a min-height with flex centering.
    const padded = parseFloat(cs.paddingLeft) >= 8 && (parseFloat(cs.paddingTop) >= 4 || el.getBoundingClientRect().height >= 32);
    return Boolean((hasBg || hasBorder) && padded);
  };
  const PRICE_RE = /([$€£]\s?\d)|(\d[\d.,]*\s?(USD|USDT|USDC|ARS|EUR|cUSD|%))|(\/\s?(mes|month|mo)\b)/i;
  (window as unknown as CapWindow).__cap = { clean, visible, makeShown, toRgba, hex, isButtonLike, PRICE_RE };
}

/** Scrolls the page down in steps, to trigger lazy loading and reveal-on-scroll. Returns the height it ends with. */
export async function inPageAutoScroll(maxPx: number): Promise<number> {
  const step = Math.round(innerHeight * 0.6);
  for (let y = 0; y < Math.min(document.documentElement.scrollHeight, maxPx); y += step) {
    scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 160));
  }
  scrollTo(0, Math.min(document.documentElement.scrollHeight, maxPx));
  await new Promise((r) => setTimeout(r, 400));
  return document.documentElement.scrollHeight;
}

/** The addresses and texts of the links of the page, for finding the demo links. */
export function inPageAnchors(): { href: string; text: string }[] {
  const { clean } = (window as unknown as CapWindow).__cap;
  return [...document.querySelectorAll<HTMLAnchorElement>('a[href]')].slice(0, 500).map((a) => ({ href: a.href, text: clean(a.innerText) }));
}

/**
 * The text of the page split into sections (a heading and what follows), and its metadata. Tags each heading that opens a
 * section `data-capsec`. A heading opens one only if it reads as a title, not as a piece of a figure: it has two letters
 * or more, and it is no figure (a number with at most one word: "453K", "1 second", "$0.0004"). Framer splits a figure
 * over several headings ("$" + "6.2" + "Billion"), so headings with no text between them, no more than a line apart on
 * the page, are read together for this. A figure's text joins the section it is in, as one line, which keeps it with
 * its label, above it or under it; its headings are tagged `data-capfig`, so that what holds them is still seen to hold
 * the page's text. A line repeated in a section (a carousel repeats its cards) is kept once, where it first comes.
 */
export function inPageExtractText(): PageText {
  const { clean, visible, isButtonLike } = (window as unknown as CapWindow).__cap;
  const blockCache = new Map<Element, Element>();
  const blockOf = (node: Node): Element => {
    let el = node.parentElement;
    while (el && el !== document.body) {
      const cached = blockCache.get(el);
      if (cached) return cached;
      const d = getComputedStyle(el).display;
      if (!d.startsWith('inline') && d !== 'contents') {
        blockCache.set(el, el);
        return el;
      }
      el = el.parentElement;
    }
    return document.body;
  };
  type Raw = { heading: string; el: Element | null; parts: string[]; ctas: string[]; lastBlock: Element | null };
  const raw: Raw[] = [];
  let cur: Raw = { heading: '', el: null, parts: [], ctas: [], lastBlock: null };
  raw.push(cur);
  const isFragment = (heading: string): boolean => {
    if ((heading.match(/\p{L}/gu) ?? []).length < 2) return true;
    const words = heading.split(' ').filter((w) => /\p{L}/u.test(w)).length;
    return /^\P{L}*\p{N}/u.test(heading) && words <= 1;
  };
  // Whether a heading is near enough to the one before it to be the rest of it: their boxes are no more than a line
  // (of the one before) apart, across or down. On celo.org the pieces of a figure touch: "1.5" and "B" side by side,
  // "Billion" right under "$ 6.2". The title of the next section is a section's padding away.
  const near = (before: Element, el: Element): boolean => {
    const a = before.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    const cs = getComputedStyle(before);
    const line = cs.lineHeight === 'normal' ? 1.2 * parseFloat(cs.fontSize) : parseFloat(cs.lineHeight);
    const gap = Number.isFinite(line) ? line : a.height;
    return Math.max(0, b.left - a.right, a.left - b.right) <= gap && Math.max(0, b.top - a.bottom, a.top - b.bottom) <= gap;
  };
  // The fragments of headings read since the last text, together; and the last of them, whose text is already taken.
  let figure = '';
  let figureEl: Element | null = null;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(n: Node) {
      if (n.nodeType === 1) {
        const el = n as Element;
        if (['script', 'style', 'noscript', 'template', 'svg', 'nav', 'iframe'].includes(el.localName)) return NodeFilter.FILTER_REJECT;
        // A wrapper with no box of its own (Framer wraps every component in one) is no reason to drop what it holds:
        // its children are judged one by one. checkVisibility calls it invisible, for it has no box.
        if (getComputedStyle(el).display === 'contents') return NodeFilter.FILTER_SKIP;
        if (!visible(el)) return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 1) {
      const el = n as HTMLElement;
      if (/^h[1-3]$/.test(el.localName)) {
        const heading = clean(el.innerText);
        const joined = figure !== '' && figureEl !== null && near(figureEl, el);
        const together = joined ? `${figure} ${heading}` : heading;
        if (heading && (isFragment(heading) || (joined && isFragment(together)))) {
          // On the line of the fragments right before it, else on a line of its own.
          if (!joined && cur.lastBlock) cur.parts.push('\n');
          cur.parts.push(heading);
          cur.lastBlock = el;
          el.setAttribute('data-capfig', '');
          figure = together;
          figureEl = el;
        } else if (heading) {
          cur = { heading, el, parts: [], ctas: [], lastBlock: null };
          raw.push(cur);
          figure = '';
        }
      } else if ((el.localName === 'a' || el.localName === 'button' || el.getAttribute('role') === 'button') && isButtonLike(el)) {
        const t = clean(el.innerText);
        if (!cur.ctas.includes(t)) cur.ctas.push(t);
      }
      continue;
    }
    if (cur.el?.contains(n) || figureEl?.contains(n)) continue; // heading text is the heading, or already taken
    const t = clean(n.textContent);
    if (!t) continue;
    figure = '';
    const block = blockOf(n);
    if (cur.lastBlock && block !== cur.lastBlock) cur.parts.push('\n');
    cur.parts.push(t);
    cur.lastBlock = block;
  }
  const sections: RawSection[] = [];
  for (const s of raw) {
    const lines = s.parts
      .join(' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n+/g, '\n')
      .trim()
      .split('\n');
    const text = [...new Set(lines)].join('\n');
    if (!s.heading && text.length < 20 && !s.ctas.length) continue;
    const id = `s${sections.length + 1}`;
    s.el?.setAttribute('data-capsec', id);
    sections.push({ id, heading: s.heading, text, ctas: s.ctas });
  }
  const meta = (sel: string): string => document.querySelector(sel)?.getAttribute('content') || '';
  return {
    lang: document.documentElement.lang || '',
    title: document.title,
    description: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
    ogImage: meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]'),
    sections,
  };
}

/** The colors and fonts the page really uses, weighed by the area or the text they cover. */
export function inPageBrand(): RawBrand {
  const { clean, visible, toRgba, hex, isButtonLike } = (window as unknown as CapWindow).__cap;
  const add = (map: Map<string, number>, key: string, w: number): void => {
    map.set(key, (map.get(key) || 0) + w);
  };
  const bg = new Map<string, number>();
  const text = new Map<string, number>();
  const cta = new Map<string, number>();
  const extra = new Map<string, number>(); // gradients, svg fills, borders: accent candidates
  const docArea = document.documentElement.scrollWidth * document.documentElement.scrollHeight;
  const rootBg = [document.documentElement, document.body].map((e) => toRgba(getComputedStyle(e).backgroundColor)).find((c) => c && c.a > 0.5);
  add(bg, hex(rootBg || { r: 255, g: 255, b: 255 }), docArea);
  const COLOR_FN = /(rgba?|oklch|oklab|lab|lch|hsla?|color)\([^)]*\)|#[0-9a-f]{3,8}\b/gi;
  for (const el of document.body.querySelectorAll<HTMLElement>('*')) {
    if (['script', 'style', 'noscript', 'template'].includes(el.localName) || !visible(el)) continue;
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    if (area < 4) continue;
    const cs = getComputedStyle(el);
    const b = toRgba(cs.backgroundColor);
    if (b && b.a > 0.5) add(bg, hex(b), area);
    if (cs.backgroundImage && cs.backgroundImage.includes('gradient')) {
      for (const m of cs.backgroundImage.match(COLOR_FN) || []) {
        const c = toRgba(m);
        if (c && c.a > 0.5) add(extra, hex(c), area * 0.5);
      }
    }
    let own = 0;
    for (const n of el.childNodes) if (n.nodeType === 3) own += clean(n.textContent).length;
    if (own) {
      const c = toRgba(cs.color);
      if (c && c.a > 0.5) add(text, hex(c), own);
    }
    if (el instanceof SVGElement && el.localName !== 'svg') {
      const f = toRgba(cs.fill);
      if (f && f.a > 0.5) add(extra, hex(f), Math.min(area, 4000));
    }
    if ((el.localName === 'a' || el.localName === 'button' || el.getAttribute('role') === 'button') && isButtonLike(el)) {
      if (b && b.a > 0.5) add(cta, hex(b), 1 + area / 10000);
    }
  }
  const fontStack = (el: Element | null): string => (el ? getComputedStyle(el).fontFamily : '');
  const headingEl = document.querySelector('h1') || document.querySelector('h2');
  const bodyEl = document.querySelector('main p, p') || document.body;
  const fontFaceSrcs: { family: string; src: string }[] = [];
  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // a stylesheet from another origin
    }
    for (const rule of rules || []) {
      if (rule.constructor.name === 'CSSFontFaceRule') {
        const face = rule as CSSFontFaceRule;
        fontFaceSrcs.push({ family: face.style.getPropertyValue('font-family'), src: face.style.getPropertyValue('src') });
      }
    }
  }
  const top = (m: Map<string, number>): Weighted => [...m.entries()].sort((a, b) => b[1] - a[1]);
  return {
    bg: top(bg),
    text: top(text),
    cta: top(cta),
    extra: top(extra),
    displayStack: fontStack(headingEl),
    bodyStack: fontStack(bodyEl),
    displayWeight: headingEl ? getComputedStyle(headingEl).fontWeight : '700',
    displayStretch: headingEl ? getComputedStyle(headingEl).fontStretch : '100%',
    // Tracking and leading of the main heading, relative to its font size.
    displayMetrics: (() => {
      if (!headingEl) return null;
      const cs = getComputedStyle(headingEl);
      const fs = parseFloat(cs.fontSize);
      const ls = cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing);
      const lh = cs.lineHeight === 'normal' ? 1.2 * fs : parseFloat(cs.lineHeight);
      return { letterSpacingEm: Math.round((ls / fs) * 1000) / 1000, lineHeight: Math.round((lh / fs) * 100) / 100 };
    })(),
    stylesheets: [...document.querySelectorAll<HTMLLinkElement>('link[rel~=stylesheet]')].map((l) => l.href),
    fontFaceSrcs,
  };
}

/**
 * Finds the logo at the top of the page and tags it `data-caplogo`, with its SVG if it is an inline one or one a CSS
 * background paints. The candidates, in document order: the links home (Framer writes them "./"), what says it is a logo,
 * and the links of the header. One is the logo if it holds a picture (an image, an SVG, a CSS background or mask with an
 * address), or if its text is the site's name: a menu label is never the logo, and no logo is better than a wrong one.
 */
export function inPageFindLogo(): FoundLogo | null {
  const { visible } = (window as unknown as CapWindow).__cap;
  const norm = (s: string | null | undefined): string => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  // The site's name: og:site_name, else the first part of the title.
  const name = norm(document.querySelector('meta[property="og:site_name"]')?.getAttribute('content') || document.title.split(/[—|·:-]/)[0]);
  const home = `${location.origin}/`;
  const SAYS_LOGO = '[class*="logo" i], [id*="logo" i], img[alt*="logo" i], header a';
  const cands = [...document.querySelectorAll<HTMLElement>(`a[href], ${SAYS_LOGO}`)].filter(
    (el) => (el instanceof HTMLAnchorElement && el.href === home) || el.matches(SAYS_LOGO),
  );
  /** The address of the first url(...) of a computed CSS value, or null. */
  const cssUrl = (value: string): string | null => {
    const m = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s]*))\s*\)/.exec(value);
    const url = m?.[1] ?? m?.[2] ?? m?.[3];
    return url ? url.replace(/\\(.)/g, '$1') : null;
  };
  /** The SVG of a data: address, at the given size, keeping its viewBox (made from its own size if it has none). */
  const svgOfDataUrl = (url: string, w: number, h: number): string | null => {
    const m = /^data:image\/svg\+xml([^,]*),(.*)$/is.exec(url);
    if (!m) return null;
    const [, params = '', payload = ''] = m;
    let source: string;
    try {
      source = /;base64/i.test(params)
        ? new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)))
        : payload.replace(/(%[0-9a-f]{2})+/gi, (s) => {
            try {
              return decodeURIComponent(s);
            } catch {
              return s;
            }
          });
    } catch {
      return null;
    }
    const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
    const svg = doc.documentElement;
    if (svg.localName !== 'svg' || doc.querySelector('parsererror')) return null;
    const [ownW, ownH] = [svg.getAttribute('width'), svg.getAttribute('height')].map((v) => Number(v));
    if (!svg.hasAttribute('viewBox') && ownW && ownH) svg.setAttribute('viewBox', `0 0 ${ownW} ${ownH}`);
    svg.setAttribute('width', String(Math.round(w)));
    svg.setAttribute('height', String(Math.round(h)));
    return new XMLSerializer().serializeToString(svg);
  };
  for (const el of cands) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.top > 160 || r.width < 16 || r.width > 420 || r.height < 12 || r.height > 140) continue;
    const inline = el.matches('img, svg') || el.querySelector('img, svg') !== null;
    // What CSS paints with a picture, on the element or in it. A mask is a shape painted in the element's color.
    const painted = [el, ...el.querySelectorAll('*')].flatMap((e) => {
      if (!visible(e)) return [];
      const cs = getComputedStyle(e);
      const mask = cssUrl(cs.maskImage);
      const background = cssUrl(cs.backgroundImage);
      return mask || background ? [{ e, background: mask ? null : background }] : [];
    });
    const hasText = (el.innerText || '').trim().length > 0;
    if (!inline && painted.length === 0 && !(hasText && name && norm(el.innerText) === name)) continue;
    el.setAttribute('data-caplogo', '1');
    const svgs = el.matches('svg') ? [el as unknown as SVGSVGElement] : [...el.querySelectorAll('svg')];
    let svg: string | null = null;
    if (svgs.length === 1 && svgs[0]) {
      const src = svgs[0];
      const clone = src.cloneNode(true) as SVGSVGElement;
      const origs = [src as Element, ...src.querySelectorAll('*')];
      const clones = [clone as Element, ...clone.querySelectorAll('*')];
      origs.forEach((o, i) => {
        const cs = getComputedStyle(o);
        if (o.localName !== 'svg') {
          clones[i]?.setAttribute('fill', cs.fill);
          if (cs.stroke && cs.stroke !== 'none') clones[i]?.setAttribute('stroke', cs.stroke);
        }
      });
      const sr = src.getBoundingClientRect();
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.setAttribute('width', String(Math.round(sr.width)));
      clone.setAttribute('height', String(Math.round(sr.height)));
      svg = clone.outerHTML;
    }
    // The one picture is an SVG a background paints (Framer's wordmark): kept at the size it is drawn.
    const [only] = painted;
    if (!inline && painted.length === 1 && only?.background) {
      const box = only.e.getBoundingClientRect();
      svg = svgOfDataUrl(only.background, box.width, box.height);
    }
    const img = el.matches('img') ? (el as HTMLImageElement) : el.querySelector('img');
    return { hasText, svg, imgSrc: img?.currentSrc || img?.src || null, rect: { w: r.width, h: r.height } };
  }
  // Text-only wordmark without a home link: the smallest top element whose text is the site name.
  if (!name) return null;
  const words = [...document.querySelectorAll<HTMLElement>('body *')].filter((el) => {
    if (!visible(el) || norm(el.innerText) !== name) return false;
    const r = el.getBoundingClientRect();
    return r.top <= 160 && r.height >= 12 && r.height <= 140;
  });
  const el = words.sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width)[0];
  if (!el) return null;
  el.setAttribute('data-caplogo', '1');
  const r = el.getBoundingClientRect();
  return { hasText: true, svg: null, imgSrc: null, rect: { w: r.width, h: r.height }, wordmark: true };
}

/**
 * The boxes (headings, buttons, images, prices) that are on the screen or, for a full-page shot, on the page, and shown
 * (not see-through: see makeShown). In pixels of the shot; one that begins above the shot is kept from y 0 and marked
 * `clippedTop`.
 */
export function inPageBoxes(fullPage: boolean, maxFullPagePx: number): PageBox[] {
  const { clean, makeShown, isButtonLike, PRICE_RE } = (window as unknown as CapWindow).__cap;
  const shown = makeShown();
  const dpr = devicePixelRatio;
  const vw = innerWidth;
  const vh = innerHeight;
  const offY = fullPage ? scrollY : 0;
  const limitH = fullPage ? Math.min(document.documentElement.scrollHeight, maxFullPagePx) : vh;
  const heads = [...document.querySelectorAll('[data-capsec]')];
  const sectionOf = (el: Element): string | undefined => {
    let id: string | undefined;
    for (const h of heads) {
      if (h === el || h.contains(el) || h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) id = h.getAttribute('data-capsec') ?? undefined;
      else break;
    }
    return id;
  };
  const out: PageBox[] = [];
  const push = (el: Element, kind: PageBox['kind'], text?: string): void => {
    if (!shown(el)) return;
    const r = el.getBoundingClientRect();
    const x = r.left;
    const y = r.top + offY;
    if (r.width < 8 || r.height < 8) return;
    const ix = Math.max(0, Math.min(vw, x + r.width) - Math.max(0, x));
    const iy = Math.max(0, Math.min(limitH, y + r.height) - Math.max(0, y));
    if ((ix * iy) / (r.width * r.height) < 0.6) return;
    const sectionId = sectionOf(el);
    out.push({
      ...(sectionId ? { sectionId } : {}),
      kind,
      ...(text ? { text } : {}),
      x: Math.round(Math.max(0, x) * dpr),
      y: Math.round(Math.max(0, y) * dpr),
      w: Math.round(ix * dpr),
      h: Math.round(iy * dpr),
      // It begins above the shot: the top of the shot cuts it.
      ...(Math.round(y * dpr) < 0 ? { clippedTop: true as const } : {}),
    });
  };
  for (const el of document.querySelectorAll<HTMLElement>('h1, h2, h3')) push(el, 'heading', clean(el.innerText));
  for (const el of document.querySelectorAll<HTMLElement>('a, button, [role=button]')) if (isButtonLike(el)) push(el, 'cta', clean(el.innerText));
  for (const el of document.querySelectorAll('img, picture, video, canvas, svg')) {
    const r = el.getBoundingClientRect();
    if (r.width >= 120 && r.height >= 80 && !el.closest('picture:not(:scope)')) push(el, 'image');
  }
  for (const el of document.querySelectorAll<HTMLElement>('body *')) {
    if (el.children.length > 2) continue;
    const t = clean(el.innerText);
    if (t && t.length <= 40 && PRICE_RE.test(t) && ![...el.children].some((c) => clean((c as HTMLElement).innerText) === t)) push(el, 'price', t);
  }
  return out;
}

/**
 * The blocks (cards) that are on the screen or, for a full-page shot, on the page, nested ones included, in document
 * order, shown like the boxes. In pixels of the shot, measured (and marked `clippedTop`) like the boxes. A block is
 * 40 to 98% of the screen's width (a band as wide as the page is page, not a card), 48 px to 1.2 screens tall, and draws
 * a surface: a border on all four sides, a shadow that is not transparent, a background color unlike the one behind it
 * (the nearest ancestor's that is not transparent, else white), or a background image. What is fixed or sticky, and what
 * is in it, floats over the page: it is no card of it.
 */
export function inPageBlocks(fullPage: boolean, maxFullPagePx: number): PageBlock[] {
  const { makeShown, toRgba, hex } = (window as unknown as CapWindow).__cap;
  const shown = makeShown();
  const dpr = devicePixelRatio;
  const vw = innerWidth;
  const vh = innerHeight;
  const offY = fullPage ? scrollY : 0;
  const limitH = fullPage ? Math.min(document.documentElement.scrollHeight, maxFullPagePx) : vh;
  const floating = new Map<Element, boolean>();
  const floats = (el: Element | null): boolean => {
    if (!el || el === document.documentElement) return false;
    const known = floating.get(el);
    if (known !== undefined) return known;
    const { position } = getComputedStyle(el);
    const result = position === 'fixed' || position === 'sticky' || floats(el.parentElement);
    floating.set(el, result);
    return result;
  };
  // A shadow whose colors are all transparent draws nothing: a hover effect at rest, a framework's empty shadow.
  const COLOR = /(rgba?|oklch|oklab|lab|lch|hsla?|color)\([^)]*\)|#[0-9a-f]{3,8}\b|transparent/gi;
  const drawsShadow = (shadow: string): boolean => {
    const colors = shadow.match(COLOR);
    return shadow !== 'none' && (!colors || colors.some((c) => (toRgba(c)?.a ?? 0) > 0));
  };
  const behind = (el: Element): string => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const c = toRgba(getComputedStyle(p).backgroundColor);
      if (c && c.a > 0) return hex(c);
    }
    return '#ffffff';
  };
  const drawsSurface = (el: Element): boolean => {
    const cs = getComputedStyle(el);
    const sides: [string, string][] = [
      [cs.borderTopWidth, cs.borderTopColor],
      [cs.borderRightWidth, cs.borderRightColor],
      [cs.borderBottomWidth, cs.borderBottomColor],
      [cs.borderLeftWidth, cs.borderLeftColor],
    ];
    // A border whose style is none or hidden is computed 0 px wide.
    if (sides.every(([width, color]) => parseFloat(width) >= 1 && (toRgba(color)?.a ?? 0) > 0)) return true;
    if (drawsShadow(cs.boxShadow) || cs.backgroundImage !== 'none') return true;
    const bg = toRgba(cs.backgroundColor);
    return bg !== null && bg.a > 0.5 && hex(bg) !== behind(el);
  };
  const out: PageBlock[] = [];
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width < vw * 0.4 || r.width > vw * 0.98 || r.height < 48 || r.height > vh * 1.2) continue;
    const x = r.left;
    const y = r.top + offY;
    const ix = Math.max(0, Math.min(vw, x + r.width) - Math.max(0, x));
    const iy = Math.max(0, Math.min(limitH, y + r.height) - Math.max(0, y));
    if ((ix * iy) / (r.width * r.height) < 0.6 || !shown(el) || floats(el) || !drawsSurface(el)) continue;
    out.push({
      x: Math.round(Math.max(0, x) * dpr),
      y: Math.round(Math.max(0, y) * dpr),
      w: Math.round(ix * dpr),
      h: Math.round(iy * dpr),
      ...(Math.round(y * dpr) < 0 ? { clippedTop: true as const } : {}),
    });
  }
  return out;
}

const saturationOf = (hex: string): number => {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  return max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
};

type Color = SiteData['brand']['colors'][number];

/** The colors of the brand from what the page measured: its backgrounds, text, button color and accents. */
export function pickColors(b: Pick<RawBrand, 'bg' | 'text' | 'cta' | 'extra'>, note: (text: string) => void): Color[] {
  const share = (list: Weighted): Weighted => {
    const total = list.reduce((s, [, w]) => s + w, 0) || 1;
    return list.map(([hex, w]) => [hex, Math.round((w / total) * 1000) / 1000]);
  };
  const colors: Color[] = [];
  const bg = share(b.bg)
    .slice(0, 3)
    .filter(([, w], i) => i === 0 || w >= 0.03);
  bg.forEach(([hex, weight]) => colors.push({ hex, role: 'bg', weight }));
  share(b.text)
    .slice(0, 2)
    .filter(([, w], i) => i === 0 || w >= 0.1)
    .forEach(([hex, weight]) => colors.push({ hex, role: 'text', weight }));
  const pageBg = bg[0]?.[0];
  const primary = share(b.cta).find(([hex]) => hex !== pageBg);
  if (primary) colors.push({ hex: primary[0], role: 'primary', weight: primary[1] });
  const taken = new Set(colors.map((c) => c.hex));
  const accents = share([...b.extra, ...b.text, ...b.bg.slice(1)].filter(([hex]) => saturationOf(hex) > 0.35 && !taken.has(hex)));
  const merged = new Map<string, number>();
  for (const [hex, w] of accents) merged.set(hex, (merged.get(hex) || 0) + w);
  [...merged.entries()]
    .sort((a, c) => c[1] - a[1])
    .slice(0, 2)
    .forEach(([hex, weight]) => colors.push({ hex, role: 'accent', weight: Math.round(weight * 1000) / 1000 }));
  const firstAccent = colors.find((c) => c.role === 'accent');
  if (!primary && firstAccent) {
    note(`no CTA background found; primary falls back to accent ${firstAccent.hex}`);
    colors.push({ hex: firstAccent.hex, role: 'primary', weight: 0 });
  }
  return colors;
}
