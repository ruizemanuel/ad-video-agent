// Whether a page is a wall for automated visitors (an anti-bot challenge, a captcha, an access-denied page) and not
// the site. A video of the wall must never be delivered. Pure: the pre-check and the capture on the VM both use it.

// What Cloudflare, Akamai and the captcha services put in the title or the body of their pages. They are in English
// because the pre-check asks for English pages (Accept-Language).
const PHRASES = ['just a moment', 'attention required', 'access denied', 'verify you are human', 'captcha'];

// A challenge is a stub. A real page can mention a captcha in its footer ("protected by reCAPTCHA"), so the phrases are
// only read in the text of a page this short.
const CHALLENGE_TEXT_MAX = 1000;

// An error that comes with (almost) no text at all: nothing of the site is there.
const STUB_TEXT_MAX = 80;

const says = (haystack: string): boolean => {
  const lower = haystack.toLowerCase();
  return PHRASES.some((phrase) => lower.includes(phrase));
};

export function detectBlocked({ title, text, status }: { title: string; text: string; status: number }): boolean {
  if (says(title)) return true;
  if (text.length < CHALLENGE_TEXT_MAX && says(text)) return true;
  return text.length < STUB_TEXT_MAX && status >= 400;
}
