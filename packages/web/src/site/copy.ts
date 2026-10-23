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
