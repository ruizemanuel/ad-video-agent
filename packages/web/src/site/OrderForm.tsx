'use client';
// The order form of the home. One press of its button runs the whole order: the free quote, the wallet (connected and
// moved to Celo), that wallet's own quote and price, the token it holds enough of, one signature, and the order page.
// A site that shows little stops it once, before the wallet, to suggest adding pages; the next press goes on.
// Wherever the order cannot go on, it stops, keeps everything the person typed and says why. It is rendered in the
// browser only: everything it does needs the person's wallet, which the server cannot see.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { ResourceUnavailableRpcError, UserRejectedRequestError, type Address } from 'viem';
import { useConfig, useConnection } from 'wagmi';
import type { TokenSymbol } from '../payments/tokens';
import { ORDER_FORM } from './copy';
import styles from './OrderForm.module.css';
import { chooseToken, PaymentNotConfirmed, payOrder } from './pay';
import { normalizeUrl, requestOffer, requestQuote, type OrderInput, type Quote } from './quote';
import { connectWallet, onCelo, switchToCelo, tokenBalances, walletSigner, WalletProviders } from './wallet';

/** The service's limits: a brief of up to 200 characters, and up to 3 extra pages. */
const BRIEF_MAX = 200;
const PAGES = 3;
const OFFER_KEY = ['offer'];

type Props = {
  /** The full price as the home writes it ("0.05"), shown until GET /v1/offer answers. */
  price: string;
  /** How many wallets the first-video promo is for (PROMO_SLOTS). */
  promoSlots: number;
};

const noUpdates = () => () => {};

export function OrderForm(props: Props) {
  const inBrowser = useSyncExternalStore(
    noUpdates,
    () => true,
    () => false,
  );
  // On the server, and until the page runs: an empty place of the form's height, so nothing moves when it appears.
  if (!inBrowser) return <div className={styles.placeholder} />;
  return (
    <WalletProviders>
      <Form {...props} />
    </WalletProviders>
  );
}

type Fields = { url: string; brief: string; pages: string[]; audio: 'music' | 'none' };
/** The field that holds no address the service could take. */
type Invalid = { field: 'url' } | { field: 'page'; index: number };
type Notice = { tone: 'progress' | 'error' | 'done'; text: string; href?: string };
/** Where the order was when it stopped: what to tell the person depends on it. */
type Stage = 'quote' | 'connect' | 'switch' | 'balances' | 'sign';
/** The connected wallet's own price, once its quote is in, and the token it pays with once that is known. */
type WalletPrice = { address: Address; price: string; token?: TokenSymbol };

const EMPTY: Fields = { url: '', brief: '', pages: Array.from({ length: PAGES }, () => ''), audio: 'music' };

/** The order the fields make, leaving out what is empty; or the first field that is not an address. */
function orderInput(fields: Fields): { ok: true; input: OrderInput } | { ok: false; invalid: Invalid } {
  const url = normalizeUrl(fields.url);
  if (url === null) return { ok: false, invalid: { field: 'url' } };
  const extraUrls: string[] = [];
  for (const [index, page] of fields.pages.entries()) {
    if (page.trim() === '') continue;
    const normalized = normalizeUrl(page);
    if (normalized === null) return { ok: false, invalid: { field: 'page', index } };
    extraUrls.push(normalized);
  }
  const brief = fields.brief.trim();
  return { ok: true, input: { url, ...(brief !== '' && { brief }), ...(extraUrls.length > 0 && { extraUrls }), audio: fields.audio } };
}

/** The error and each error it was caused by, outermost first. */
function causes(error: unknown): unknown[] {
  const found: unknown[] = [];
  for (let current = error; current !== null && current !== undefined && found.length < 10; current = (current as { cause?: unknown }).cause) {
    found.push(current);
  }
  return found;
}
const hasCode = (error: unknown, code: number): boolean => causes(error).some((cause) => (cause as { code?: unknown }).code === code);
const hasName = (error: unknown, name: string): boolean => causes(error).some((cause) => (cause as { name?: unknown }).name === name);

/** What to tell the person when the order stopped at `stage`. Only a payment that was sent can have been charged. */
function stoppedText(error: unknown, stage: Stage): string {
  if (error instanceof PaymentNotConfirmed) return ORDER_FORM.errors.notConfirmed;
  if (hasName(error, 'ProviderNotFoundError')) return ORDER_FORM.errors.noWallet;
  if (hasCode(error, UserRejectedRequestError.code)) {
    if (stage === 'connect') return ORDER_FORM.errors.connectCancelled;
    if (stage === 'sign') return ORDER_FORM.errors.signatureCancelled;
  }
  if (hasCode(error, ResourceUnavailableRpcError.code)) return ORDER_FORM.errors.walletBusy;
  if (stage === 'switch') return ORDER_FORM.errors.wrongNetwork;
  return ORDER_FORM.errors.generic;
}

const progress = (text: string): Notice => ({ tone: 'progress', text });
const stopped = (text: string): Notice => ({ tone: 'error', text });

function Form({ price, promoSlots }: Props) {
  const config = useConfig();
  const connection = useConnection();
  const router = useRouter();
  const queryClient = useQueryClient();
  const offer = useQuery({ queryKey: OFFER_KEY, queryFn: () => requestOffer() });

  const [fields, setFields] = useState<Fields>(EMPTY);
  const [invalid, setInvalid] = useState<Invalid | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [thin, setThin] = useState(false);
  // The site (its address as quoted) the form already stopped for because it shows little: the next press goes on.
  const [thinPausedFor, setThinPausedFor] = useState<string | null>(null);
  const [briefOpen, setBriefOpen] = useState(false);
  const [pagesOpen, setPagesOpen] = useState(false);
  const [walletPrice, setWalletPrice] = useState<WalletPrice | null>(null);
  const [busy, setBusy] = useState(false);
  // Set at once on a press, before React renders the button disabled: a second press in between finds it set.
  const inFlight = useRef(false);
  const urlField = useRef<HTMLInputElement>(null);
  const pageFields = useRef<(HTMLInputElement | null)[]>([]);
  const id = useId();
  const ids = { url: `${id}-url`, urlError: `${id}-url-error`, brief: `${id}-brief`, count: `${id}-count`, pages: `${id}-pages`, pageError: `${id}-page-error`, notice: `${id}-notice` };

  const update = (patch: Partial<Fields>) => {
    setFields((current) => ({ ...current, ...patch }));
    setInvalid(null);
  };

  function showInvalid(found: Invalid) {
    setInvalid(found);
    setNotice(null);
    if (found.field === 'url') {
      urlField.current?.focus();
    } else {
      setPagesOpen(true);
      requestAnimationFrame(() => pageFields.current[found.index]?.focus());
    }
  }

  /** Whether the quote has a price; if not, the person is told why. */
  function priced(quote: Quote): quote is Extract<Quote, { kind: 'priced' }> {
    if (quote.kind === 'refused') setNotice(stopped(quote.reason));
    else if (quote.kind === 'unavailable') setNotice(stopped(ORDER_FORM.errors.unavailable(quote.retryAfterSeconds)));
    return quote.kind === 'priced';
  }

  /** The whole order. True once it is placed and the page is on its way to it. */
  async function placeOrder(): Promise<boolean> {
    const built = orderInput(fields);
    if (!built.ok) {
      showInvalid(built.invalid);
      return false;
    }
    const { input } = built;
    let stage: Stage = 'quote';
    try {
      // The site first: one that cannot be ordered never brings the wallet out.
      setNotice(progress(ORDER_FORM.progress.checking));
      const first = await requestQuote(input);
      if (!priced(first)) return false;
      setThin(first.thin);
      // A site that shows little: before any wallet prompt, the person gets the chance to add pages, once per site.
      // The next press goes on with whatever the form holds then (added pages are checked by that press's quote; they
      // cannot make the site itself less thin, so it never stops twice).
      if (first.thin && thinPausedFor !== input.url) {
        setThinPausedFor(input.url);
        setPagesOpen(true);
        setNotice(progress(ORDER_FORM.progress.thinPaused));
        return false;
      }

      stage = 'connect';
      setNotice(progress(ORDER_FORM.progress.connecting));
      const address = await connectWallet(config);
      stage = 'switch';
      if (!onCelo(config)) {
        setNotice(progress(ORDER_FORM.progress.switching));
        await switchToCelo(config);
      }

      // The price this wallet pays: the first-video price when the promo takes it.
      stage = 'quote';
      const quote = await requestQuote(input, address);
      if (!priced(quote)) return false;
      setWalletPrice({ address, price: quote.price });

      stage = 'balances';
      const token = chooseToken(await tokenBalances(config, address), quote.amountAtomic);
      if (token === null) {
        setNotice(stopped(ORDER_FORM.errors.noFunds(quote.price)));
        return false;
      }
      setWalletPrice({ address, price: quote.price, token });

      stage = 'sign';
      setNotice(progress(ORDER_FORM.progress.signing));
      const wallet = walletSigner(config, address);
      const signer = {
        address,
        signTypedData: async (typed: Parameters<typeof wallet.signTypedData>[0]) => {
          const signature = await wallet.signTypedData(typed);
          setNotice(progress(ORDER_FORM.progress.placing));
          return signature;
        },
      };
      const result = await payOrder({ input, required: quote.required, token, signer });
      if (!result.ok) {
        setNotice(stopped(result.reason));
        // The promo may have just run out: the banner and the next quote say so.
        void queryClient.invalidateQueries({ queryKey: OFFER_KEY });
        return false;
      }
      const href = `/o/${encodeURIComponent(result.orderId)}`;
      // The link stays here too, should the page not get there.
      setNotice({ tone: 'done', text: ORDER_FORM.progress.placed, href });
      router.push(href);
      return true;
    } catch (error) {
      setNotice(stopped(stoppedText(error, stage)));
      return false;
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // One order at a time: a press while one is on its way does nothing, so no payment is ever signed or sent twice.
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    let leaving = false;
    try {
      leaving = await placeOrder();
    } finally {
      if (!leaving) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }

  const fullPrice = offer.data?.price ?? price;
  const own = walletPrice !== null && walletPrice.address === connection.address ? walletPrice : null;
  const shownPrice = own?.price ?? fullPrice;
  const token = own?.token ?? 'USDT';
  const paused = thinPausedFor !== null && normalizeUrl(fields.url) === thinPausedFor;
  const label = paused
    ? ORDER_FORM.button.continueAndPay(shownPrice, token)
    : connection.isConnected
      ? ORDER_FORM.button.pay(shownPrice, token)
      : ORDER_FORM.button.connectAndPay(shownPrice, token);
  const promo = offer.data?.promo;
  const banner = promo !== null && promo !== undefined && promo.left > 0 && promoSlots > 0 ? ORDER_FORM.promo(promoSlots, promo.price, promo.left) : null;

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      <label className={styles.hidden} htmlFor={ids.url}>
        {ORDER_FORM.url.label}
      </label>
      <input
        id={ids.url}
        ref={urlField}
        name="url"
        className={styles.url}
        type="text"
        inputMode="url"
        autoComplete="url"
        autoCapitalize="none"
        spellCheck={false}
        placeholder={ORDER_FORM.url.placeholder}
        value={fields.url}
        onChange={(event) => update({ url: event.target.value })}
        aria-invalid={invalid?.field === 'url' ? true : undefined}
        aria-describedby={invalid?.field === 'url' ? ids.urlError : undefined}
      />
      {invalid?.field === 'url' ? (
        <p id={ids.urlError} className={styles.fieldError}>
          {ORDER_FORM.errors.url}
        </p>
      ) : null}

      <details className={styles.more} data-part="brief" open={briefOpen} onToggle={(event) => setBriefOpen(event.currentTarget.open)}>
        <summary>
          <span id={ids.brief}>{ORDER_FORM.brief.label}</span>
          <span className={styles.note}>{ORDER_FORM.brief.note}</span>
        </summary>
        <div className={styles.moreBody}>
          <textarea
            name="brief"
            className={styles.field}
            rows={2}
            maxLength={BRIEF_MAX}
            placeholder={ORDER_FORM.brief.placeholder}
            value={fields.brief}
            onChange={(event) => update({ brief: event.target.value })}
            aria-labelledby={ids.brief}
            aria-describedby={ids.count}
          />
          <p id={ids.count} className={styles.count}>
            {ORDER_FORM.brief.count(fields.brief.length, BRIEF_MAX)}
          </p>
        </div>
      </details>

      {thin ? <p className={styles.hint}>{ORDER_FORM.thin}</p> : null}

      <details className={styles.more} data-part="pages" open={pagesOpen} onToggle={(event) => setPagesOpen(event.currentTarget.open)}>
        <summary>
          <span id={ids.pages}>{ORDER_FORM.pages.label}</span>
          <span className={styles.note}>{ORDER_FORM.pages.note}</span>
        </summary>
        <div className={styles.moreBody} role="group" aria-labelledby={ids.pages}>
          {fields.pages.map((page, index) => {
            const wrong = invalid?.field === 'page' && invalid.index === index;
            return (
              <input
                // The three fields never move: their place is their identity.
                key={index}
                ref={(element) => {
                  pageFields.current[index] = element;
                }}
                name={`extraUrls.${index}`}
                className={styles.field}
                type="text"
                inputMode="url"
                autoCapitalize="none"
                spellCheck={false}
                placeholder={ORDER_FORM.pages.placeholder}
                value={page}
                onChange={(event) => update({ pages: fields.pages.map((current, at) => (at === index ? event.target.value : current)) })}
                aria-label={ORDER_FORM.pages.pageLabel(index + 1)}
                aria-invalid={wrong ? true : undefined}
                aria-describedby={wrong ? ids.pageError : undefined}
              />
            );
          })}
          {invalid?.field === 'page' ? (
            <p id={ids.pageError} className={styles.fieldError}>
              {ORDER_FORM.errors.page}
            </p>
          ) : null}
        </div>
      </details>

      <div className={styles.row}>
        <fieldset className={styles.audio}>
          <legend className={styles.hidden}>{ORDER_FORM.audio.legend}</legend>
          {(['music', 'none'] as const).map((value) => (
            <label key={value} className={styles.choice}>
              <input type="radio" name="audio" value={value} checked={fields.audio === value} onChange={() => update({ audio: value })} />
              {ORDER_FORM.audio[value]}
            </label>
          ))}
        </fieldset>
        {banner === null ? null : <p className={styles.promo}>{banner}</p>}
      </div>

      <button type="submit" className={styles.pay} disabled={busy} aria-busy={busy}>
        {label}
      </button>
      <p id={ids.notice} className={notice?.tone === 'error' ? `${styles.notice} ${styles.error}` : styles.notice} role="status">
        {notice?.text}
        {notice?.href === undefined ? null : (
          <>
            {' '}
            <a href={notice.href}>{ORDER_FORM.progress.openOrder}</a>
          </>
        )}
      </p>
    </form>
  );
}
