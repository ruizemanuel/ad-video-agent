// Taking an order to a phone's wallet app. A phone's browser holds no wallet: the wallet is an app of its own, with a
// browser inside. So on a phone with no wallet the form offers to open itself in MetaMask's browser, filled in with what
// the person typed: the fields travel in the link's query, and the form reads them back when it opens.

/** The service's limits: a brief of up to 200 characters, and up to 3 extra pages. */
export const BRIEF_MAX = 200;
export const PAGES = 3;

/** What the person types in the order form. */
export type Fields = { url: string; brief: string; pages: string[]; audio: 'music' | 'none' };

export const EMPTY_FIELDS: Fields = { url: '', brief: '', pages: Array.from({ length: PAGES }, () => ''), audio: 'music' };

/** MetaMask's link that opens a page in the app's own browser, or its download page where the app is not installed. */
const METAMASK_DAPP = 'https://link.metamask.io/dapp/';
/** The home's section that holds the form. */
const FORM_SECTION = '#order';

/**
 * The fields as a query: those the person filled in, with music left out, as the form starts with it. The pages keep
 * their order, the empty ones left out.
 */
function fieldsQuery(fields: Fields): string {
  const query = new URLSearchParams();
  if (fields.url.trim() !== '') query.set('url', fields.url.trim());
  if (fields.brief.trim() !== '') query.set('brief', fields.brief.trim());
  for (const page of fields.pages) if (page.trim() !== '') query.append('page', page.trim());
  if (fields.audio === 'none') query.set('audio', 'none');
  return query.toString();
}

/**
 * The link that opens the home on `host`, at the form and filled in with `fields`, in MetaMask's browser. MetaMask opens
 * whatever follows `/dapp/`, its query and fragment included, over https.
 */
export function metaMaskLink(host: string, fields: Fields): string {
  const query = fieldsQuery(fields);
  return `${METAMASK_DAPP}${host}/${query === '' ? '' : `?${query}`}${FORM_SECTION}`;
}

/** The fields a query carries (`search`, as `location.search` gives it), kept to what the form can hold. */
export function fieldsFromQuery(search: string): Fields {
  const query = new URLSearchParams(search);
  const pages = query.getAll('page').slice(0, PAGES);
  return {
    url: query.get('url') ?? '',
    brief: (query.get('brief') ?? '').slice(0, BRIEF_MAX),
    pages: [...pages, ...EMPTY_FIELDS.pages].slice(0, PAGES),
    audio: query.get('audio') === 'none' ? 'none' : 'music',
  };
}

/**
 * Whether the page runs in MiniPay's own browser: its wallet says so on window.ethereum (`ethereum`). MiniPay signs no
 * typed data, so it cannot sign the payment: a signature asked of it never comes back.
 */
export function isMiniPay(ethereum: unknown): boolean {
  return typeof ethereum === 'object' && ethereum !== null && (ethereum as { isMiniPay?: unknown }).isMiniPay === true;
}

/** What the page reads of the browser to tell a phone. */
type Device = { userAgent: string; maxTouchPoints: number; userAgentData?: { mobile: boolean } };

/**
 * Whether the page runs on a phone or a tablet, where a wallet is an app and not part of the browser: the browser says
 * so (Chromium), or its user agent names one. An iPad's Safari says it is a Mac, and is told by its touch screen.
 */
export function isPhone(device: Device): boolean {
  if (device.userAgentData?.mobile === true) return true;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(device.userAgent)) return true;
  return /Macintosh/.test(device.userAgent) && device.maxTouchPoints > 1;
}
