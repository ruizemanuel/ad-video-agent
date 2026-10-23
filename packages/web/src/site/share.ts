// What the delivery view does around sharing: the text X opens with, and the link to the person's own post as the service
// takes it. Pure functions, with nothing of the browser in them.

const X_INTENT = 'https://x.com/intent/post';
/** The most characters a post on X has. */
const MAX_POST_LENGTH = 280;
/** The longest link the service takes for a post (the feedback route's own limit). */
const MAX_POST_URL_LENGTH = 2048;

/** A text as one line: its runs of white space, line breaks included, are single spaces. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The host of an address, or nothing when it is not an address. */
function hostOf(address: string): string {
  try {
    return new URL(address).host;
  } catch {
    return '';
  }
}

/**
 * `line` in `room` characters: whole when it fits, otherwise cut, with an ellipsis. It is cut between characters, never
 * through one that takes two (an emoji), and counts as a string does, so it is never over what X counts.
 */
function fitted(line: string, room: number): string {
  if (line.length <= room) return line;
  let kept = '';
  for (const character of line) {
    if (kept.length + character.length > room - 1) break;
    kept += character;
  }
  return `${kept.trimEnd()}…`;
}

/**
 * The link that opens X with a post ready to send: the first line of the video, a space and the site, so that the post
 * is no longer than X takes. The line is the one that gives way (cut, with an ellipsis, when it does not fit), and the
 * site's address is never touched. With no line (an order with no claims, or one that is blank) the line is the site's
 * host. X will not take a video from a link, so the person attaches the one they downloaded.
 */
export function xIntentUrl(firstLine: string, siteUrl: string): string {
  const room = MAX_POST_LENGTH - siteUrl.length - 1;
  // An address so long that no line fits beside it goes alone.
  const line = room < 2 ? '' : fitted(oneLine(firstLine) || hostOf(siteUrl), room);
  const post = line === '' ? siteUrl : `${line} ${siteUrl}`;
  return `${X_INTENT}?text=${encodeURIComponent(post)}`;
}

/**
 * The link to the person's post as the service takes it: an https address, with no spaces, no user name or password and
 * at most 2048 characters. What the person typed may leave out the scheme (https:// is added). Null for anything else,
 * and for a blank field: there is no link to give, which is not a wrong one.
 */
export function postUrlOf(typed: string): string | null {
  const trimmed = typed.trim();
  if (trimmed === '' || /\s/.test(trimmed)) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname === '' || url.username !== '' || url.password !== '') return null;
  return url.href.length <= MAX_POST_URL_LENGTH ? url.href : null;
}
