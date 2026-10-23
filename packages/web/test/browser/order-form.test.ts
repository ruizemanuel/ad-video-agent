// The order form of the home as a person uses it, against the app in fake mode with the stub wallet: it quotes the site,
// connects the wallet, moves it to Celo, picks the token the wallet holds enough of, has it sign one payment and lands
// on the order page. When it should not pay, it says why and asks the wallet for nothing it does not need.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { HTTPRequest, Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileStore } from '../../src/adapters/fake/store';
import { TOKENS } from '../../src/payments/tokens';
import type { Order } from '../../src/ports';
import { launchPage, startApp, type App, type AppAnswer, type LaunchedPage } from './support/app';
import { seedOrder } from './support/seed';
import type { Eip1193Provider, WalletOptions } from './support/wallet';

/** How long any one thing may take to show: a first compile of the page included. */
const WAIT = { timeout: 60_000 };
const FORM = '#order form';
const URL_FIELD = `${FORM} input[name="url"]`;
const BUTTON = `${FORM} button[type="submit"]`;
/** Enough of a token for any price of the test app. */
const PLENTY = 5_000_000n;
const PROTOCOL_WORDS = ['x402', 'EIP-3009', 'facilitator', 'settlement', 'nonce', 'authorization'];

/** Every order in the app's fake store (one JSON file per order, named by its id). */
async function storedOrders(fakeDir: string): Promise<Order[]> {
  const names = await readdir(join(fakeDir, 'orders')).catch(() => [] as string[]);
  const store = new FileStore(fakeDir);
  const orders = await Promise.all(names.filter((name) => name.endsWith('.json')).map((name) => store.getOrder(decodeURIComponent(name.slice(0, -'.json'.length)))));
  return orders.filter((order): order is Order => order !== null);
}

/** The home, with its order form ready to use (it appears once the page runs in the browser). */
async function openForm(app: App, wallet: WalletOptions = {}): Promise<LaunchedPage> {
  const launched = await launchPage(app, wallet);
  try {
    expect((await launched.page.goto(`${app.url}/`, { waitUntil: 'load' }))?.status()).toBe(200);
    await launched.page.waitForSelector(URL_FIELD, WAIT);
    return launched;
  } catch (error) {
    await launched.browser.close();
    throw error;
  }
}

/** What a person puts in the form; the optional parts are left alone when not given. */
type Filled = { url: string; brief?: string; extraUrl?: string; audio?: 'music' | 'none' };

/** Fills the form as a person does: typing, opening the optional parts, picking the audio. */
async function fill(page: Page, order: Filled): Promise<void> {
  await page.type(URL_FIELD, order.url);
  if (order.brief !== undefined) {
    await page.click(`${FORM} details[data-part="brief"] summary`);
    await page.type(`${FORM} textarea[name="brief"]`, order.brief);
  }
  if (order.extraUrl !== undefined) {
    await page.click(`${FORM} details[data-part="pages"] summary`);
    await page.type(`${FORM} input[name="extraUrls.0"]`, order.extraUrl);
  }
  if (order.audio !== undefined) await page.click(`${FORM} input[name="audio"][value="${order.audio}"]`);
}

const orderText = (page: Page): Promise<string> => page.$eval('#order', (section) => (section as HTMLElement).innerText);

/** Waits until the order section says `text`. */
const waitForText = (page: Page, text: string): Promise<unknown> =>
  page.waitForFunction((wanted) => document.querySelector<HTMLElement>('#order')?.innerText.includes(wanted) === true, WAIT, text);

/** Waits until the page is the order page of a new order, and gives the order's id. */
async function waitForOrderPage(page: Page): Promise<string> {
  await page.waitForFunction(() => /^\/o\/ord_[a-z0-9]+$/.test(location.pathname), WAIT);
  return new URL(page.url()).pathname.slice('/o/'.length);
}

/** Every text the pay button shows from now on, in order, kept in the test (so a change of page does not lose them). */
async function recordButton(page: Page): Promise<string[]> {
  const seen: string[] = [];
  await page.exposeFunction('__buttonText', (text: string) => {
    if (seen.at(-1) !== text) seen.push(text);
  });
  await page.$eval(BUTTON, (button) => {
    const report = () => (window as unknown as { __buttonText(text: string): void }).__buttonText(button.textContent ?? '');
    report();
    new MutationObserver(report).observe(button, { childList: true, characterData: true, subtree: true });
  });
  return seen;
}

/** Asks the wallet in the page directly, as the page would. */
const askWallet = (page: Page, method: string): Promise<unknown> =>
  page.evaluate((m) => (window as unknown as { ethereum: Eip1193Provider }).ethereum.request({ method: m }), method);

/** The pay button as the person sees it. */
const buttonState = (page: Page): Promise<{ disabled: boolean; text: string | null }> =>
  page.$eval(BUTTON, (button) => ({ disabled: (button as HTMLButtonElement).disabled, text: button.textContent }));

/** Waits until the pay button says `text`. */
const waitForButton = (page: Page, text: string): Promise<unknown> =>
  page.waitForFunction((selector, wanted) => document.querySelector(selector)?.textContent === wanted, WAIT, BUTTON, text);

/** What the service says when the first-video price is gone by the time the payment arrives (409 promo_unavailable). */
const PROMO_GONE = 'The first-video price is no longer available for this wallet. Ask for a new quote.';

/** Whether the request is the paying POST of an order: the one that carries the signed payment. */
const isPaying = (request: HTTPRequest): boolean =>
  request.method() === 'POST' && new URL(request.url()).pathname === '/v1/videos' && request.headers()['payment-signature'] !== undefined;

const expectPlainWords = (text: string): void => {
  for (const word of PROTOCOL_WORDS) expect(text.toLowerCase(), word).not.toContain(word.toLowerCase());
};

describe('the order form', () => {
  let app: App;
  beforeAll(async () => {
    app = await startApp();
  });
  afterAll(async () => {
    await app?.stop();
  });

  it('pays and lands on the order page', async () => {
    const { browser, page, wallet, blockedRequests } = await openForm(app, { balances: { USDT: PLENTY } });
    try {
      expect(await page.$eval(BUTTON, (button) => button.textContent)).toBe('Connect wallet and pay 0.05 USDT');
      // The promo is off in this app: no banner.
      expect(await orderText(page)).not.toMatch(/first \d+ wallets/i);
      expectPlainWords(await orderText(page));

      await fill(page, { url: 'tiendita.example/shop' });
      // Two clicks at once are one payment.
      await page.$eval(BUTTON, (button) => {
        (button as HTMLButtonElement).click();
        (button as HTMLButtonElement).click();
      });
      const id = await waitForOrderPage(page);

      const orders = await storedOrders(app.fakeDir);
      expect(orders.map((order) => order.id)).toEqual([id]);
      expect(orders[0]).toMatchObject({
        amount: 50_000n,
        asset: TOKENS.USDT.address,
        payer: wallet.address,
        promoSlot: null,
        request: { url: 'https://tiendita.example/shop', audio: 'music' },
      });
      expect(wallet.signatureRequests()).toBe(1);
      expect(blockedRequests()).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it('pays with USDC when the wallet has too little USDT', async () => {
    const { browser, page, wallet, blockedRequests } = await openForm(app, { balances: { USDT: 49_999n, USDC: PLENTY } });
    try {
      await fill(page, { url: 'https://usdc.tiendita.example/' });
      await page.click(BUTTON);
      const id = await waitForOrderPage(page);
      const order = (await storedOrders(app.fakeDir)).find((stored) => stored.id === id);
      expect(order).toMatchObject({ amount: 50_000n, asset: TOKENS.USDC.address, payer: wallet.address });
      expect(blockedRequests()).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it('keeps the form when the signature is rejected', async () => {
    const before = (await storedOrders(app.fakeDir)).length;
    const { browser, page, wallet, blockedRequests } = await openForm(app, { balances: { USDT: PLENTY }, rejectSignature: true });
    try {
      await fill(page, { url: 'https://kept.tiendita.example/', brief: 'For freelancers, friendly tone', extraUrl: 'https://kept.tiendita.example/app', audio: 'none' });
      await page.click(BUTTON);
      await waitForText(page, 'You cancelled the signature. Nothing was charged.');

      expect(await page.$eval(URL_FIELD, (input) => (input as HTMLInputElement).value)).toBe('https://kept.tiendita.example/');
      expect(await page.$eval(`${FORM} textarea[name="brief"]`, (input) => (input as HTMLTextAreaElement).value)).toBe('For freelancers, friendly tone');
      expect(await page.$eval(`${FORM} input[name="extraUrls.0"]`, (input) => (input as HTMLInputElement).value)).toBe('https://kept.tiendita.example/app');
      expect(await page.$eval(`${FORM} input[name="audio"][value="none"]`, (input) => (input as HTMLInputElement).checked)).toBe(true);
      // Ready for another try, now with the wallet's own price.
      expect(await page.$eval(BUTTON, (button) => ({ disabled: (button as HTMLButtonElement).disabled, text: button.textContent }))).toEqual({
        disabled: false,
        text: 'Pay 0.05 USDT',
      });
      expectPlainWords(await orderText(page));

      expect(wallet.signatureRequests()).toBe(1);
      expect(await storedOrders(app.fakeDir)).toHaveLength(before);
      expect(blockedRequests()).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it('asks to switch to Celo', async () => {
    const { browser, page, wallet, blockedRequests } = await openForm(app, { chainId: 1, balances: { USDT: PLENTY } });
    try {
      expect(await askWallet(page, 'eth_chainId')).toBe('0x1');
      await fill(page, { url: 'https://switch.tiendita.example/' });
      await page.click(BUTTON);
      const id = await waitForOrderPage(page);
      // The wallet added Celo, moved to it, and only then signed.
      expect(await askWallet(page, 'eth_chainId')).toBe('0xa4ec');
      expect((await storedOrders(app.fakeDir)).find((order) => order.id === id)).toMatchObject({ payer: wallet.address, amount: 50_000n });
      expect(wallet.signatureRequests()).toBe(1);
      expect(blockedRequests()).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it('says which tokens are missing before asking to sign', async () => {
    const before = (await storedOrders(app.fakeDir)).length;
    const { browser, page, wallet, blockedRequests } = await openForm(app);
    try {
      await fill(page, { url: 'https://broke.tiendita.example/' });
      await page.click(BUTTON);
      await waitForText(page, 'You need 0.05 USDT or USDC on Celo.');
      expect(wallet.signatureRequests()).toBe(0);
      expect(await page.$eval(BUTTON, (button) => (button as HTMLButtonElement).disabled)).toBe(false);
      expect(await storedOrders(app.fakeDir)).toHaveLength(before);
      expect(blockedRequests()).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it.each<[string, AppAnswer]>([
    ['a 500 with no body', { status: 500, contentType: 'text/plain', body: '' }],
    ['no answer at all', { unanswered: true }],
  ])('never pays again after a payment that may have gone through (%s), until the person unlocks it', async (_label, answer) => {
    const before = (await storedOrders(app.fakeDir)).length;
    const { browser, page, wallet, blockedRequests, answerForApp } = await openForm(app, { balances: { USDT: PLENTY } });
    try {
      // The payment leaves, and what comes back names no order: it may or may not have been charged.
      let answered = false;
      answerForApp((request) => {
        if (!isPaying(request) || answered) return null;
        answered = true;
        return answer;
      });
      await fill(page, { url: 'https://doubt.tiendita.example/' });
      await page.click(BUTTON);
      await waitForText(page, 'Check your wallet for a payment to Ad Video Agent before you try again.');
      expect(await orderText(page)).toContain('If it’s there, your video is being made, so don’t pay again.');
      expect(wallet.signatureRequests()).toBe(1);
      expect(await buttonState(page)).toMatchObject({ disabled: true });
      expectPlainWords(await orderText(page));

      // No press signs anything now, however it comes: a click, the button's own click, Enter in the address field.
      const ordering: string[] = [];
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/v1/videos') ordering.push(request.method());
      });
      await page.click(BUTTON);
      await page.$eval(BUTTON, (button) => (button as HTMLButtonElement).click());
      await page.focus(URL_FIELD);
      await page.keyboard.press('Enter');
      await page.waitForNetworkIdle({ idleTime: 500, timeout: WAIT.timeout });
      expect(ordering).toEqual([]);
      expect(wallet.signatureRequests()).toBe(1);
      expect(await orderText(page)).toContain('Check your wallet for a payment to Ad Video Agent before you try again.');
      expect(await storedOrders(app.fakeDir)).toHaveLength(before);

      // The person looked, and the payment is not in the wallet: they say so, and the next press pays.
      const unlock = `${FORM} button[data-part="unlock"]`;
      expect(await page.$eval(unlock, (button) => button.textContent)).toBe('The payment isn’t in my wallet. Try again');
      await page.click(unlock);
      expect(await buttonState(page)).toMatchObject({ disabled: false });
      expect(await page.$(unlock)).toBeNull();
      await page.click(BUTTON);
      const id = await waitForOrderPage(page);
      expect(wallet.signatureRequests()).toBe(2);
      const orders = await storedOrders(app.fakeDir);
      expect(orders).toHaveLength(before + 1);
      expect(orders.find((order) => order.id === id)).toMatchObject({ payer: wallet.address, amount: 50_000n, request: { url: 'https://doubt.tiendita.example/' } });
      expect(blockedRequests()).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it('shows the reason when the site is behind a login', async () => {
    const res = await fetch(`${app.url}/v1/videos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://tiendita.example/login', audio: 'music' }),
    });
    expect(res.status).toBe(422);
    const { reason } = (await res.json()) as { reason: string };

    const { browser, page, wallet, blockedRequests } = await openForm(app, { balances: { USDT: PLENTY } });
    try {
      await fill(page, { url: 'tiendita.example/login' });
      await page.click(BUTTON);
      await waitForText(page, reason);
      // The wallet was never asked to connect, let alone to sign.
      expect(await askWallet(page, 'eth_accounts')).toEqual([]);
      expect(wallet.signatureRequests()).toBe(0);
      expect(blockedRequests()).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it('refuses an address that is no site before quoting', async () => {
    const { browser, page, wallet, blockedRequests } = await openForm(app, { balances: { USDT: PLENTY } });
    try {
      const quotes: string[] = [];
      page.on('request', (request) => {
        if (request.url().endsWith('/v1/videos')) quotes.push(request.method());
      });
      await fill(page, { url: 'ftp://tiendita.example/' });
      await page.click(BUTTON);
      await page.waitForSelector(`${URL_FIELD}[aria-invalid="true"]`, WAIT);
      expect(await orderText(page)).toContain('Enter your site’s address, like yourproject.xyz.');
      expect(quotes).toEqual([]);
      expect(await askWallet(page, 'eth_accounts')).toEqual([]);
      expect(wallet.signatureRequests()).toBe(0);
      expect(blockedRequests()).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it('suggests extra pages for a thin site', async () => {
    const before = (await storedOrders(app.fakeDir)).length;
    const { browser, page, wallet, blockedRequests } = await openForm(app, { balances: { USDT: PLENTY } });
    try {
      await fill(page, { url: 'https://thin.tiendita.example/' });
      await page.click(BUTTON);
      // The form stops before the wallet: the suggestion, the place to add pages open, and a button to go on.
      await waitForText(page, 'Your site shows little of the product. Adding up to 3 public pages makes a better video.');
      await page.waitForFunction((selector) => document.querySelector(selector)?.textContent?.startsWith('Continue and pay') === true, WAIT, BUTTON);
      expect(await page.$eval(BUTTON, (button) => ({ disabled: (button as HTMLButtonElement).disabled, text: button.textContent }))).toEqual({
        disabled: false,
        text: 'Continue and pay 0.05 USDT',
      });
      expect(await page.$eval(`${FORM} details[data-part="pages"]`, (details) => (details as HTMLDetailsElement).open)).toBe(true);
      expect(wallet.signatureRequests()).toBe(0);
      // Not even asked to connect.
      expect(await askWallet(page, 'eth_accounts')).toEqual([]);
      expect(await storedOrders(app.fakeDir)).toHaveLength(before);
      expectPlainWords(await orderText(page));

      // The person adds a page and goes on: one press, one payment, with what the form holds now.
      await page.type(`${FORM} input[name="extraUrls.0"]`, 'tiendita.example/app');
      await page.click(BUTTON);
      const id = await waitForOrderPage(page);
      const order = (await storedOrders(app.fakeDir)).find((stored) => stored.id === id);
      expect(order).toMatchObject({
        amount: 50_000n,
        payer: wallet.address,
        request: { url: 'https://thin.tiendita.example/', extraUrls: ['https://tiendita.example/app'] },
      });
      expect(wallet.signatureRequests()).toBe(1);
      expect(blockedRequests()).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it('reaches the order form from the keyboard before the example videos', async () => {
    const { browser, page, blockedRequests } = await openForm(app);
    try {
      // From the top of the page, as a person who has just opened it.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const reached: string[] = [];
      for (let step = 0; step < 40; step += 1) {
        await page.keyboard.press('Tab');
        const here = await page.evaluate(() => {
          const focused = document.activeElement;
          if (focused === null) return 'none';
          if (focused.closest('video') !== null) return 'video';
          return focused.getAttribute('name') === 'url' ? 'url' : focused.tagName;
        });
        reached.push(here);
        if (here === 'url' || here === 'video') break;
      }
      expect(reached.at(-1), reached.join(' → ')).toBe('url');
      expect(blockedRequests()).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});

describe("the order form once the day's videos are all made", () => {
  it('says so before the wallet, and that nothing was charged', async () => {
    // A daily buy cap below what one VM may cost: the service has room for no order today.
    const app = await startApp({ BUY_DAILY_CAP_USD: '0.05' });
    try {
      const { browser, page, wallet, blockedRequests } = await openForm(app, { balances: { USDT: PLENTY } });
      try {
        await fill(page, { url: 'https://full.tiendita.example/' });
        await page.click(BUTTON);
        await waitForText(page, 'We’ve made all the videos we can for today. Try again tomorrow. Nothing was charged.');
        expect(await orderText(page)).not.toContain('Try again in');
        // The wallet was never asked to connect, let alone to sign, and the button is ready for tomorrow.
        expect(await askWallet(page, 'eth_accounts')).toEqual([]);
        expect(wallet.signatureRequests()).toBe(0);
        expect(await buttonState(page)).toMatchObject({ disabled: false });
        expectPlainWords(await orderText(page));
        expect(await storedOrders(app.fakeDir)).toEqual([]);
        expect(blockedRequests()).toEqual([]);
      } finally {
        await browser.close();
      }
    } finally {
      await app.stop();
    }
  });
});

describe('the order form with the first-video promo on', () => {
  it('pays the promo price as an eligible wallet', async () => {
    const app = await startApp({ PROMO_SLOTS: '3' });
    try {
      const { browser, page, wallet, blockedRequests } = await openForm(app, { balances: { USDT: PLENTY } });
      try {
        await waitForText(page, 'First 3 wallets: 0.01 USDT · 3 left');
        // Before the wallet is known, the full price.
        const texts = await recordButton(page);
        expect(texts).toEqual(['Connect wallet and pay 0.05 USDT']);

        await fill(page, { url: 'https://promo.tiendita.example/' });
        await page.click(BUTTON);
        const id = await waitForOrderPage(page);
        // Once the wallet's own quote is in, its price.
        expect(texts).toContain('Pay 0.01 USDT');
        expect(texts.indexOf('Pay 0.01 USDT')).toBeGreaterThan(0);

        const orders = await storedOrders(app.fakeDir);
        expect(orders.map((order) => order.id)).toEqual([id]);
        expect(orders[0]).toMatchObject({ amount: 10_000n, promoSlot: 1, payer: wallet.address, asset: TOKENS.USDT.address });
        expect(wallet.signatureRequests()).toBe(1);
        expect(blockedRequests()).toEqual([]);
      } finally {
        await browser.close();
      }
    } finally {
      await app.stop();
    }
  });

  it('shows a dearer price before paying it, when the promo runs out after the wallet saw it', async () => {
    const app = await startApp({ PROMO_SLOTS: '1' });
    try {
      const { browser, page, wallet, blockedRequests } = await openForm(app, { balances: { USDT: PLENTY }, rejectSignature: true });
      try {
        await waitForText(page, 'First wallet: 0.01 USDT · 1 left');
        await fill(page, { url: 'https://race.tiendita.example/' });
        await page.click(BUTTON);
        await waitForText(page, 'You cancelled the signature. Nothing was charged.');
        expect(await buttonState(page)).toEqual({ disabled: false, text: 'Pay 0.01 USDT' });
        expect(wallet.signatureRequests()).toBe(1);

        // Meanwhile another wallet takes the last slot, and this person now means to sign.
        const taker = await seedOrder(app.fakeDir, 'running', { promoSlot: 1 });
        wallet.setRejectSignature(false);

        // The press that said 0.01 does not pay 0.05: it stops before the wallet, with the new price on the button.
        await page.click(BUTTON);
        await waitForText(page, 'The price for your wallet is now 0.05 USDT or USDC. Nothing was charged. Press the button again to pay it.');
        expect(await buttonState(page)).toEqual({ disabled: false, text: 'Pay 0.05 USDT' });
        expect(wallet.signatureRequests()).toBe(1);
        expect((await storedOrders(app.fakeDir)).map((order) => order.id)).toEqual([taker]);

        // The next press, on the button that says 0.05, pays it.
        await page.click(BUTTON);
        const id = await waitForOrderPage(page);
        expect((await storedOrders(app.fakeDir)).find((order) => order.id === id)).toMatchObject({ amount: 50_000n, promoSlot: null, payer: wallet.address });
        expect(wallet.signatureRequests()).toBe(2);
        expect(blockedRequests()).toEqual([]);
      } finally {
        await browser.close();
      }
    } finally {
      await app.stop();
    }
  });

  it('shows the full price after the promo is lost at the moment of paying', async () => {
    const app = await startApp({ PROMO_SLOTS: '1' });
    try {
      const { browser, page, wallet, blockedRequests, answerForApp } = await openForm(app, { balances: { USDT: PLENTY } });
      try {
        // The race at the moment of paying: another wallet's payment takes the last slot between this wallet's quote
        // and its order, and the service answers 409 without taking the payment. The two payments cannot be timed from
        // here, so the service's answer is given in its place (the route's own tests cover how it comes to give it),
        // with the slot taken in the store as the other payment leaves it.
        let taker: string | undefined;
        answerForApp(async (request) => {
          if (!isPaying(request) || taker !== undefined) return null;
          taker = await seedOrder(app.fakeDir, 'running', { promoSlot: 1 });
          return { status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'promo_unavailable', reason: PROMO_GONE }) };
        });

        await waitForText(page, 'First wallet: 0.01 USDT · 1 left');
        await fill(page, { url: 'https://lost.tiendita.example/' });
        await page.click(BUTTON);
        await waitForText(page, PROMO_GONE);
        expect(wallet.signatureRequests()).toBe(1);
        // The wallet's 0.01 no longer holds: the button says the full price, and the banner is gone with the last slot.
        await waitForButton(page, 'Pay 0.05 USDT');
        await page.waitForFunction(() => document.querySelector<HTMLElement>('#order')?.innerText.includes('First wallet') === false, WAIT);
        expect(await buttonState(page)).toEqual({ disabled: false, text: 'Pay 0.05 USDT' });
        expect((await storedOrders(app.fakeDir)).map((order) => order.id)).toEqual([taker]);

        // The next press quotes again and pays the price its button showed.
        await page.click(BUTTON);
        const id = await waitForOrderPage(page);
        expect((await storedOrders(app.fakeDir)).find((order) => order.id === id)).toMatchObject({ amount: 50_000n, promoSlot: null, payer: wallet.address });
        expect(wallet.signatureRequests()).toBe(2);
        expect(blockedRequests()).toEqual([]);
      } finally {
        await browser.close();
      }
    } finally {
      await app.stop();
    }
  });
});
