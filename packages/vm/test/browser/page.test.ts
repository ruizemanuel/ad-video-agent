// Opt-in (`pnpm --filter @app/vm test:browser`): the two things the capture does to a page before it films it, tried one
// by one in a real Chrome on small pages made here: answering a cookie banner, and hiding what covers the site.
import type { CaptureLog } from '@app/core';
import type { Browser, Page } from 'puppeteer-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dismissCookies, launchBrowser, removeOverlays } from '../../src/capture/page';

let browser: Browser;
let page: Page;
let log: CaptureLog;

beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser.close();
});
beforeEach(async () => {
  page = await browser.newPage();
  await page.setViewport({ width: 800, height: 600 });
  log = { startedAt: '', notes: [], timings: {} };
  return async () => {
    await page.close();
  };
});

const BASE = 'body { margin: 0; font-family: sans-serif; } p { margin: 0 0 40px; }';
const TEXT = '<p>A page with a good deal of text in it so that no box on top of it is mistaken for the page itself.</p>'.repeat(12);

describe('cookie banners', () => {
  // The banner of a site in another language, with a refuse button next to the accept one: only the accept one is pressed.
  it.each([
    ['Portuguese', 'Usamos cookies para melhorar a sua experiência.', 'Aceitar', 'Recusar'],
    ['German', 'Wir verwenden Cookies, um Ihre Erfahrung zu verbessern.', 'Alle akzeptieren', 'Alle ablehnen'],
    ['French', 'Nous utilisons des cookies pour améliorer votre expérience.', 'Tout accepter', 'Tout refuser'],
    ['Spanish', 'Usamos cookies para mejorar tu experiencia.', 'Aceptar', 'Rechazar'],
    ['English', 'We use cookies to improve your experience.', 'Accept all', 'Reject all'],
  ])('presses the accept button of a %s banner and leaves the other one alone', async (_language, message, accept, refuse) => {
    await page.setContent(`<style>${BASE}</style>${TEXT}
      <div style="position: fixed; bottom: 0; left: 0; right: 0; padding: 16px; background: #222; color: #fff">
        <span>${message}</span> <button id="yes">${accept}</button> <button id="no">${refuse}</button>
      </div>
      <script>
        window.pressed = [];
        for (const id of ['yes', 'no']) document.getElementById(id).addEventListener('click', () => window.pressed.push(id));
      </script>`);

    expect(await dismissCookies(page, log, 'test')).toBe(true);

    expect(await page.evaluate(() => (window as unknown as { pressed: string[] }).pressed)).toEqual(['yes']);
    expect(log.notes).toContain('cookies dismissed');
  });

  it('does not press an "OK" that has nothing to do with cookies', async () => {
    await page.setContent(`<style>${BASE}</style>${TEXT}<button id="ok">OK</button>
      <script>window.pressed = false; document.getElementById('ok').addEventListener('click', () => (window.pressed = true));</script>`);

    expect(await dismissCookies(page, log, 'test')).toBe(false);

    expect(await page.evaluate(() => (window as unknown as { pressed: boolean }).pressed)).toBe(false);
    expect(log.notes).toEqual([]);
  });
});

describe('overlays', () => {
  /** Whether the element is still in the page, and whether it is shown. */
  const state = (selector: string) =>
    page.evaluate((s) => {
      const el = document.querySelector<HTMLElement>(s);
      return el === null ? 'gone' : getComputedStyle(el).display === 'none' ? 'hidden' : 'shown';
    }, selector);

  it('hides a modal that covers the screen, with its dialog, and logs it', async () => {
    await page.setContent(`<style>${BASE}</style>${TEXT}
      <div id="modal" style="position: fixed; inset: 0; background: rgba(0,0,0,.5)"><div style="background: #fff; margin: 100px auto; width: 300px"><h2>Join us</h2></div></div>`);

    expect(await removeOverlays(page, log, 'test')).toBe(1);

    expect(await state('#modal')).toBe('hidden');
    expect(log.notes).toContain('overlay removed');
    expect(log.notes.join('\n')).toContain('div#modal');
  });

  // A page built with React (or any framework that owns its DOM) takes its elements out itself when it renders again.
  // Taking one out of the page behind its back makes that throw, and the page stops working for the shots to come.
  it('hides it, not takes it out, so that the page can still take it out itself later', async () => {
    await page.setContent(`<style>${BASE}</style>${TEXT}<div id="modal" style="position: fixed; inset: 0; background: rgba(0,0,0,.5)"><h2>Join us</h2></div>`);
    // What the framework holds: the node and its parent, from when it put the modal there.
    await page.evaluate(() => {
      const modal = document.getElementById('modal') as HTMLElement;
      (window as unknown as { held: [Node, Node] }).held = [modal.parentNode as Node, modal];
    });

    await removeOverlays(page, log, 'test');

    const outcome = await page.evaluate(() => {
      const [parent, modal] = (window as unknown as { held: [Node, Node] }).held;
      try {
        parent.removeChild(modal);
        return 'removed';
      } catch (error) {
        return (error as Error).name;
      }
    });
    expect(outcome).toBe('removed');
  });

  it('does not log the same overlay again on the next pass', async () => {
    await page.setContent(`<style>${BASE}</style>${TEXT}<div id="modal" style="position: fixed; inset: 0; background: rgba(0,0,0,.5)"><h2>Join us</h2></div>`);

    expect(await removeOverlays(page, log, 'first')).toBe(1);
    expect(await removeOverlays(page, log, 'second')).toBe(0);

    expect(log.notes.filter((n) => n.includes('modal'))).toHaveLength(1);
  });

  it('hides a dialog that does not cover much of the screen, when it says it is a dialog', async () => {
    await page.setContent(`<style>${BASE}</style>${TEXT}
      <div id="backdrop" style="position: fixed; inset: 0; background: rgba(0,0,0,.5)"></div>
      <div id="dialog" role="dialog" aria-modal="true" style="position: fixed; top: 200px; left: 250px; width: 300px; height: 150px; background: #fff">Get 10% off</div>`);

    expect(await removeOverlays(page, log, 'test')).toBe(2);

    expect(await state('#dialog')).toBe('hidden');
  });

  // A drawer that is shut waits outside the screen, still a dialog in the markup: it is not on the site, so there is
  // nothing to hide and nothing to log.
  it.each([
    ['to the left of the screen', 'left: -500px; top: 0; width: 300px; height: 600px'],
    ['to the right of the screen', 'right: -500px; top: 0; width: 300px; height: 600px'],
    ['below the screen', 'left: 0; top: 700px; width: 800px; height: 300px'],
    ['moved out by a transform', 'left: 0; top: 0; width: 300px; height: 600px; transform: translateX(-110%)'],
  ])('leaves alone a shut dialog that waits %s', async (_where, css) => {
    await page.setContent(`<style>${BASE}</style>${TEXT}<div id="drawer" role="dialog" aria-modal="true" style="position: fixed; ${css}; background: #fff">Menu</div>`);

    expect(await removeOverlays(page, log, 'test')).toBe(0);

    expect(await state('#drawer')).toBe('shown');
    expect(log.notes).toEqual([]);
  });

  it('hides a sticky banner that covers a good part of the screen', async () => {
    await page.setContent(`<style>${BASE}</style>${TEXT}<div id="promo" style="position: sticky; bottom: 0; height: 250px; background: #fc0">Sale</div>`);

    expect(await removeOverlays(page, log, 'test')).toBe(1);

    expect(await state('#promo')).toBe('hidden');
  });

  it.each([
    ['a sticky header', '<header id="keep" style="position: sticky; top: 0; height: 60px; background: #eee">Menu</header>'],
    ['a small fixed button', '<button id="keep" style="position: fixed; right: 16px; bottom: 16px; width: 56px; height: 56px">Chat</button>'],
    ['a fixed decoration that lets clicks through', '<div id="keep" style="position: fixed; inset: 0; pointer-events: none; background: linear-gradient(#f0f, #0ff)"></div>'],
    ['a fixed background behind the page', '<div id="keep" style="position: fixed; inset: 0; z-index: -1; background: #123"></div>'],
  ])('leaves %s where it is', async (_what, html) => {
    await page.setContent(`<style>${BASE}</style>${TEXT}${html}`);

    expect(await removeOverlays(page, log, 'test')).toBe(0);

    expect(await state('#keep')).toBe('shown');
    expect(log.notes).toEqual([]);
  });

  it('leaves alone an app that scrolls inside a fixed box: it is the page, not something on top of it', async () => {
    await page.setContent(`<style>${BASE}</style><div id="app" style="position: fixed; inset: 0; overflow: auto">${TEXT}</div>`);

    expect(await removeOverlays(page, log, 'test')).toBe(0);

    expect(await state('#app')).toBe('shown');
  });

  describe('a stage that holds a section of the page', () => {
    // Scrollytelling: a sticky stage as tall as the screen, inside a runway that is much taller, with the section in it.
    const stage = `<div style="height: 2400px"><div id="stage" style="position: sticky; top: 0; height: 600px; background: #eef"><h2>Pinned story</h2><p>What the product does, one step at a time.</p></div></div>`;

    it('is not hidden when it is sticky and has a heading, before the sections are read', async () => {
      await page.setContent(`<style>${BASE}</style>${stage}${TEXT}`);

      expect(await removeOverlays(page, log, 'test')).toBe(0);

      expect(await state('#stage')).toBe('shown');
      expect(log.notes).toEqual([]);
    });

    // A section pinned by a script (GSAP) is fixed while it is pinned. Once the sections are read, a heading of one is tagged.
    it('is not hidden when it holds the tagged heading of a section, fixed or sticky', async () => {
      await page.setContent(`<style>${BASE}</style>${TEXT}
        <div id="pinned" style="position: fixed; inset: 0; background: #eef"><h2 data-capsec="s2">Pinned story</h2></div>`);
      expect(await removeOverlays(page, log, 'test')).toBe(0);
      expect(await state('#pinned')).toBe('shown');

      await page.setContent(`<style>${BASE}</style>${TEXT}
        <div id="stuck" style="position: sticky; top: 0; height: 600px; background: #eef"><div>Step one</div><span data-capsec="s3">Step</span></div>`);
      expect(await removeOverlays(page, log, 'test')).toBe(0);
      expect(await state('#stuck')).toBe('shown');
    });

    it('does not keep a modal safe because it has a heading', async () => {
      await page.setContent(`<style>${BASE}</style>${stage}${TEXT}
        <div id="late" style="position: fixed; inset: 0; background: rgba(0,0,0,.5)"><h2>Last chance</h2></div>`);

      expect(await removeOverlays(page, log, 'test')).toBe(1);

      expect(await state('#late')).toBe('hidden');
      expect(await state('#stage')).toBe('shown');
    });
  });
});
