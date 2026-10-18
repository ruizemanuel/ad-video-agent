// Opening a page the way a visitor would see it: loaded, settled, scrolled once to wake what loads on scroll, with the
// cookie banner answered and nothing on top of the site. The capture takes its text, boxes and shots from this page.
import type { CaptureLog } from '@app/core';
import type { Browser, Page } from 'puppeteer-core';
import { childEnv } from '../child-env';
import { inPageAutoScroll, inPageSetup, MAX_SCROLL_CSS_PX } from './extract';

export const DPR = 2;
export type ViewportName = 'desktop' | 'mobile';
export const VIEWPORTS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: DPR },
  mobile: { width: 390, height: 844, deviceScaleFactor: DPR, isMobile: true, hasTouch: true },
} as const;

export const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
const PHONE_UA = `${CHROME_UA.replace('(Windows NT 10.0; Win64; x64)', '(Linux; Android 15; Pixel 9)')} Mobile`;

export const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** The site could not be reached at all: the name does not resolve, the connection is refused, the certificate is wrong... */
export class UnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreachableError';
  }
}

// The worker runs through tsx, whose esbuild wraps every named function in a `__name(...)` call. A function sent to
// the page (see `inPage*`) arrives with those calls inside it, and the page has no `__name`: this gives it one.
const NAME_SHIM = 'globalThis.__name = (fn) => fn;';

/**
 * Chrome Headless Shell, the one Remotion downloads on the first run (and the render uses later), started as the
 * worker's own child: with an environment of its own, so it cannot see the order token.
 */
export async function launchBrowser(): Promise<Browser> {
  const { ensureBrowser } = await import('@remotion/renderer');
  const status = await ensureBrowser();
  if (!('path' in status)) throw new Error(`chrome-headless-shell is not available (${status.type}).`);
  const { default: puppeteer } = await import('puppeteer-core');
  return puppeteer.launch({
    executablePath: status.path,
    headless: 'shell',
    // The sandbox needs kernel features a rented VM may not give. The worker is an unprivileged user behind a firewall.
    args: ['--no-sandbox', '--hide-scrollbars', '--disable-dev-shm-usage'],
    env: childEnv(),
  });
}

export const addNote = (log: CaptureLog, text: string): void => {
  log.notes.push(text);
};
// The same action on several pages is one fact for whoever reads the log, so these notes are kept once.
const addNoteOnce = (log: CaptureLog, text: string): void => {
  if (!log.notes.includes(text)) log.notes.push(text);
};

export async function settle(page: Page): Promise<void> {
  await page.waitForNetworkIdle({ idleTime: 700, timeout: 15_000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready.then(() => true));
}

// ---------- cookie banners ----------

// The buttons that accept (in English, Spanish, Portuguese, German and French). The whole label has to be one of
// these: "Accept the offer" or "Reject all" must not be pressed.
const ACCEPT_LABELS = [
  'accept', 'accept all', 'accept all cookies', 'accept cookies', 'allow', 'allow all', 'allow all cookies', 'agree', 'i agree', 'got it', 'ok', 'okay',
  'aceptar', 'aceptar todo', 'aceptar todas', 'aceptar todas las cookies', 'aceptar cookies', 'acepto', 'entendido', 'de acuerdo', 'permitir todo', 'continuar',
  'aceitar', 'aceitar tudo', 'aceitar todos', 'aceitar todos os cookies', 'aceitar cookies', 'concordo', 'entendi',
  'alle akzeptieren', 'alles akzeptieren', 'akzeptieren', 'einverstanden', 'verstanden',
  'tout accepter', 'accepter', 'accepter tout', 'accepter et fermer', "j'accepte", "d'accord", 'compris',
];
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const COOKIE_ACCEPT = new RegExp(`^(?:${ACCEPT_LABELS.map(escapeRegExp).join('|')})[.!]?$`, 'i');
/** A button is only pressed if the text around it (up to 6 levels up) is about cookies or privacy. */
export const COOKIE_CONTEXT = /cookie|privacidad|privacidade|privacy|datenschutz|confidentialit|consent|gdpr|rgpd/i;

/** Presses the first visible accept button that sits in text about cookies. Returns its label, or null. Runs in the page. */
export function inPageDismissCookies(acceptSource: string, contextSource: string): string | null {
  const accept = new RegExp(acceptSource, 'i');
  const context = new RegExp(contextSource, 'i');
  const els = [...document.querySelectorAll<HTMLElement>('button, a, [role=button], input[type=button], input[type=submit]')];
  for (const el of els) {
    const t = (el.innerText || (el as HTMLInputElement).value || '').replace(/\s+/g, ' ').trim();
    if (!accept.test(t) || !el.checkVisibility()) continue;
    let p: HTMLElement | null = el;
    let about = false;
    // Up to the body, not into it: all the text of the page would make every "OK" a cookie button.
    for (let i = 0; i < 6 && p && p !== document.body && p !== document.documentElement; i++, p = p.parentElement) {
      if (context.test(p.innerText || '')) about = true;
    }
    if (!about) continue;
    el.click();
    return t;
  }
  return null;
}

/**
 * Hides whatever is fixed or sticky over the site, on the screen as it is now: an element that covers more than
 * `minShare` of the screen, and any open dialog that is on it. It is hidden (`display: none !important`), not taken
 * out: a page that a framework owns takes its elements out itself, and does not stand finding one gone. Left alone:
 * - what lets clicks through or sits behind the page (decoration);
 * - an element that holds most of the page's text (an app that scrolls inside a fixed box);
 * - a stage that holds a section of the page: one that holds the heading of a section (the capture tags those
 *   `data-capsec` when it reads them), or, before they are read, a sticky one with a heading of its own. A story told
 *   by scrolling pins its stage over the screen, and it is the site, not something on top of it;
 * - a dialog that is shut and waits outside the screen.
 * Returns the ones it hid, by name. Runs in the page.
 */
export function inPageRemoveOverlays(minShare: number): string[] {
  const viewport = innerWidth * innerHeight;
  const pageText = (document.body.innerText || '').length;
  const hidden: string[] = [];
  for (const el of document.body.querySelectorAll<HTMLElement>('*')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    if (cs.pointerEvents === 'none' || (cs.zIndex !== 'auto' && Number(cs.zIndex) < 0)) continue;
    // Not shown already: hidden by an earlier pass (or by the page), or inside something that is.
    if (!el.checkVisibility()) continue;
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left));
    const h = Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top));
    if (w * h === 0) continue; // outside the screen
    const dialog = cs.position === 'fixed' && el.matches('[role=dialog], [role=alertdialog], [aria-modal=true]');
    if (!dialog && (w * h) / viewport <= minShare) continue;
    if (pageText > 0 && (el.innerText || '').length > pageText * 0.6) continue;
    if (el.querySelector('[data-capsec]') !== null) continue;
    if (cs.position === 'sticky' && [...el.querySelectorAll('h1, h2, h3')].some((heading) => (heading.textContent || '').trim() !== '')) continue;
    el.style.setProperty('display', 'none', 'important');
    const className = el.classList[0];
    hidden.push(`${el.localName}${el.id ? `#${el.id}` : ''}${className ? `.${className}` : ''}`);
  }
  return hidden;
}

/** What share of the screen a fixed or sticky element has to cover to be hidden. */
export const OVERLAY_MIN_SHARE = 0.3;

/** Answers the cookie banner if there is one. Returns whether it pressed a button. */
export async function dismissCookies(page: Page, log: CaptureLog, where: string): Promise<boolean> {
  const label = await page.evaluate(inPageDismissCookies, COOKIE_ACCEPT.source, COOKIE_CONTEXT.source);
  if (label === null) return false;
  addNoteOnce(log, 'cookies dismissed');
  addNote(log, `${where}: cookie banner dismissed via "${label}"`);
  await sleep(600); // the banner animates out
  return true;
}

/** Hides the overlays of the page (see `inPageRemoveOverlays`). Returns how many it hid; the log says "overlay removed" once, and which ones. */
export async function removeOverlays(page: Page, log: CaptureLog, where: string): Promise<number> {
  const hidden = await page.evaluate(inPageRemoveOverlays, OVERLAY_MIN_SHARE);
  if (hidden.length === 0) return 0;
  addNoteOnce(log, 'overlay removed');
  addNote(log, `${where}: hid ${hidden.join(', ')}`);
  return hidden.length;
}

// ---------- opening ----------

export type OpenedPage = { page: Page; height: number; status: number };

/**
 * Opens `url` at a viewport and leaves it ready to read: network idle, fonts loaded, helpers in the page, cookie banner
 * answered, overlays off, scrolled to the bottom and back for what loads on scroll. `status` is the HTTP status of the
 * page. Throws `UnreachableError` if the address cannot be reached at all.
 */
export async function openPage(browser: Browser, url: string, viewport: ViewportName, log: CaptureLog): Promise<OpenedPage> {
  const vp = VIEWPORTS[viewport];
  const where = `${url} ${vp.width}`;
  const page = await browser.newPage();
  try {
    await page.evaluateOnNewDocument(NAME_SHIM);
    await page.setUserAgent(viewport === 'mobile' ? PHONE_UA : CHROME_UA);
    await page.setViewport(vp);
    let status = 200;
    try {
      status = (await page.goto(url, { waitUntil: 'networkidle2', timeout: 60_000 }))?.status() ?? 200;
    } catch (error) {
      const message = error instanceof Error ? error.message.split('\n')[0] ?? '' : '';
      // A page that never goes quiet (analytics, chat widgets) is still the page. The others are a failed visit.
      if (error instanceof Error && error.name === 'TimeoutError') addNote(log, `${where}: networkidle2 timed out (${message}), continuing`);
      else if (/net::ERR_/.test(message)) throw new UnreachableError(`The site could not be reached (${message.replace(/^.*net::/, '')}).`);
      else throw error;
    }
    await settle(page);
    await sleep(1000);
    await page.evaluate(inPageSetup);
    await dismissCookies(page, log, where);
    await removeOverlays(page, log, where);
    const height = await page.evaluate(inPageAutoScroll, MAX_SCROLL_CSS_PX); // trigger lazy loading and reveal-on-scroll
    await settle(page);
    await page.evaluate(() => scrollTo(0, 0));
    await sleep(800);
    // Some banners and popups come late or only once the page has been scrolled.
    await dismissCookies(page, log, where);
    await removeOverlays(page, log, where);
    return { page, height, status };
  } catch (error) {
    await page.close().catch(() => {});
    throw error;
  }
}
