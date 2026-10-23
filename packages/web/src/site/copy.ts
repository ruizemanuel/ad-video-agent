// The fixed texts of the page for people. They speak of a wallet, USDT or USDC and Celo; the protocol's own words
// (x402, the payment's signature and how it is settled) appear only in the section for agents.

export const BRAND = 'Ad Video Agent';

/** The header's links to the sections of the home, which work from any page. */
export const NAV = [
  { href: '/#examples', label: 'Examples' },
  { href: '/#how', label: 'How it works' },
  { href: '/#agents', label: 'For agents' },
] as const;

export const HOME = {
  /** The headline, one line each. */
  title: ['Your site, as a video ad.', 'Ready to post.'],
  lede: 'Paste your URL. In about 8 minutes you get a vertical video made from your real product, with the source of every line it says.',

  included: {
    title: 'What’s included',
    /** After the price from the settings: "2 USDT or USDC per video". */
    perVideo: 'per video',
    items: ['A 9:16 MP4 with licensed music', 'A muted version', 'Every claim with its source'],
  },

  /** The section the order form goes in, under this title. */
  order: { title: 'Order your video' },

  finePrint: 'Pay with USDT or USDC on Celo. No gas, no account. If we can’t deliver, the payment goes back to your wallet automatically.',
  terms: { before: 'By paying you accept the ', link: 'terms', after: '.' },

  examples: {
    title: 'Made from the site alone, no editing',
    /** Under the example of a site that is not ours. */
    publicSite: 'Made from the public site, no editing',
  },

  how: {
    title: 'How it works',
    steps: [
      { title: 'Paste and pay', text: 'Your URL, a wallet, one payment. Nothing to sign up for.' },
      { title: 'Come back in ~8 min', text: 'You get a link to your order. Close the tab if you like.' },
      { title: 'Download or post', text: 'MP4 ready for X, Reels, TikTok and Shorts.' },
    ],
  },
} as const;

/** How long to wait before trying again, as a person reads it: "in a minute", "in 5 minutes", "in 3 hours". */
function againIn(seconds: number): string {
  if (seconds <= 90) return 'in a minute';
  if (seconds < 3600) return `in ${Math.ceil(seconds / 60)} minutes`;
  const hours = Math.ceil(seconds / 3600);
  return hours === 1 ? 'in an hour' : `in ${hours} hours`;
}

/**
 * The order form. The price comes as text ("0.05"), the token as its symbol. A reason the service gives for refusing
 * an order is shown as it comes, not from here.
 */
export const ORDER_FORM = {
  url: { label: 'Your site’s address', placeholder: 'https://yourproject.xyz' },
  brief: {
    label: 'What should it highlight?',
    note: 'optional · audience, tone, language',
    placeholder: 'For freelancers, in a friendly tone, in Spanish',
    /** The characters used of the 200 the brief may have. */
    count: (used: number, max: number) => `${used}/${max}`,
  },
  pages: {
    label: 'Product behind “Connect wallet”? Add up to 3 public pages',
    note: 'optional',
    placeholder: 'https://yourproject.xyz/app',
    pageLabel: (n: number) => `Public page ${n}`,
  },
  audio: { legend: 'Audio', music: 'With music', none: 'No audio' },
  /** The first-video promo, while it has slots left. */
  promo: (slots: number, price: string, left: number) => `${slots === 1 ? 'First wallet' : `First ${slots} wallets`}: ${price} USDT · ${left} left`,
  button: {
    connectAndPay: (price: string, token: string) => `Connect wallet and pay ${price} ${token}`,
    pay: (price: string, token: string) => `Pay ${price} ${token}`,
    /** After the form stopped to suggest more pages for a site that shows little. */
    continueAndPay: (price: string, token: string) => `Continue and pay ${price} ${token}`,
  },
  /** What is going on while the button waits. */
  progress: {
    checking: 'Checking your site…',
    /** The form stopped before the wallet, for a site that shows little. */
    thinPaused: 'Add pages above if you can, or continue as it is.',
    connecting: 'Connect your wallet to go on…',
    switching: 'Switch your wallet to Celo to go on…',
    signing: 'Confirm the payment in your wallet. It’s one signature, with no gas.',
    placing: 'Placing your order…',
    placed: 'Order placed. Opening it…',
    openOrder: 'Open your order',
  },
  thin: 'Your site shows little of the product. Adding up to 3 public pages makes a better video.',
  errors: {
    url: 'Enter your site’s address, like yourproject.xyz.',
    page: 'Enter a public page’s address, like yourproject.xyz/app.',
    /** The service refused the order without saying why (it always says why). */
    refused: 'We can’t make a video of this site. Nothing was charged.',
    unavailable: (retryAfterSeconds: number) => `We can’t check sites right now. Try again ${againIn(retryAfterSeconds)}.`,
    noFunds: (price: string) => `You need ${price} USDT or USDC on Celo.`,
    /** The wallet's quote asks more than the button said (the promo ran out, the price changed): nothing was signed. */
    priceRaised: (price: string) => `The price for your wallet is now ${price} USDT or USDC. Nothing was charged. Press the button again to pay it.`,
    signatureCancelled: 'You cancelled the signature. Nothing was charged.',
    connectCancelled: 'You didn’t connect a wallet. Nothing was charged.',
    wrongNetwork: 'Your wallet has to be on Celo to pay. Nothing was charged.',
    noWallet: 'We found no wallet in this browser. Add one, like MetaMask or Rabby, to pay.',
    walletBusy: 'Your wallet has a request open. Finish it there, then try again. Nothing was charged.',
    /** The service turned the payment down and gave no reason of its own: it took nothing. */
    paymentRefused: 'The payment didn’t go through. Nothing was charged. Try again.',
    /** The payment left the page and no answer came back: it may or may not have gone through. */
    notConfirmed: 'We couldn’t confirm your order. Check your wallet before you try again, so you don’t pay twice.',
    /** Anything else that went wrong before a payment was sent. */
    generic: 'Something went wrong. Nothing was charged. Try again.',
  },
} as const;

/** The section for agents: the same service, as an API paid per call. Text between backticks is shown as code. */
export const AGENTS = {
  title: 'For agents',
  lede: 'The same service is an API that agents pay per call with x402, in USDT or USDC on Celo. No key, no account.',
  steps: [
    {
      title: 'Quote',
      text: 'Send `POST /v1/videos` with `{"url": "https://yourproject.xyz"}` and, if you like, a `brief` of up to 200 characters, up to 3 more public pages in `extraUrls` and `audio` (`"music"` or `"none"`). The answer is a free `402` with the price and the terms.',
    },
    {
      title: 'Pay',
      text: 'Send the same request with an x402 payment in USDT or USDC on Celo, in the `PAYMENT-SIGNATURE` header. The answer is a `202` with the order’s `statusUrl`.',
    },
    {
      title: 'Collect',
      text: 'Read the `statusUrl` every few seconds until it says `delivered`: signed links to the video, its muted version, `claims.md` and `music.md`, for 30 days. An order that can’t be delivered is refunded to the wallet that paid, automatically.',
    },
  ],
  example: {
    intro: 'With the buy CLI, one command gets the quote, pays it and places the order:',
    command: `npx @celo/buy curl --token USDT --max-amount 2 -X POST -H 'content-type: application/json' \\
  --data '{"url":"https://yourproject.xyz"}' https://ad-video-agent-ten.vercel.app/v1/videos`,
  },
} as const;
