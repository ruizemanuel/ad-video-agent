// What the pre-check learns from a page's HTML without running it: what a visitor reads, how much of it there is,
// and whether the page is a login wall. It is not an HTML parser: it reads tags one after another, in a single pass
// that never goes back, so a page made to be slow (thousands of tags that never close) still costs only its size.
import { findDemoLinks, type Anchor } from '@app/core';

export type PageAnalysis = {
  title: string;
  /** What a visitor reads, in one line: no tags, scripts, styles or comments. */
  text: string;
  words: number;
  /** How many headings (h1 to h6) have something written in them. */
  headings: number;
  anchors: Anchor[];
  loginWall: boolean;
  /** Does the site show little of the product? Null when the page says too little to tell (it builds itself in the browser). */
  thin: boolean | null;
};

// Under this many words a page has not said anything yet: it is a shell that a script fills in.
const UNKNOWN_BELOW_WORDS = 30;
const THIN_BELOW_WORDS = 150;
const THIN_BELOW_HEADINGS = 3;
// A page with a password field is a login wall only if it is mostly the form.
const LOGIN_WALL_BELOW_WORDS = 120;
const LOGIN_PATH = /(login|signin|sign-in|auth)\b/i;

// Elements whose content is not text a visitor reads. They are skipped to their closing tag (or to the end of the
// page, as a browser does when it never comes).
const SKIPPED = new Set(['script', 'style', 'noscript', 'template', 'svg', 'textarea']);
const CLOSING = new Map([...SKIPPED, 'title'].map((name) => [name, new RegExp(`</${name}(?![a-z0-9-])`, 'gi')]));
const HEADING = /^h[1-6]$/;

const ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
]);

function decode(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES.get(entity) ?? whole;
  });
}

const tidy = (text: string): string => text.replace(/\s+/g, ' ').trim();

const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function attributes(source: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = (match[1] ?? '').toLowerCase();
    if (!found.has(name)) found.set(name, decode(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return found;
}

type Tag = { name: string; closing: boolean; attributes: string; end: number };

/** The tag that starts at `start` (a "<"), or null if what follows is not a tag. `end` is where it ends (after the ">"). */
function readTag(html: string, start: number): Tag | null {
  const closing = html[start + 1] === '/';
  const nameAt = start + (closing ? 2 : 1);
  const name = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(html.slice(nameAt, nameAt + 32))?.[0];
  if (name === undefined) return null;

  // To the ">" that is not inside the quotes of an attribute value (a quote opens one only right after "=").
  let quote = '';
  let last = '';
  for (let at = nameAt + name.length; at < html.length; at += 1) {
    const char = html.charAt(at);
    if (quote !== '') {
      if (char === quote) quote = '';
    } else if ((char === '"' || char === "'") && last === '=') {
      quote = char;
    } else if (char === '>') {
      return { name: name.toLowerCase(), closing, attributes: html.slice(nameAt + name.length, at), end: at + 1 };
    }
    if (!/\s/.test(char)) last = char;
  }
  // The tag never ends: the page ends inside it.
  return { name: name.toLowerCase(), closing, attributes: '', end: html.length };
}

type Scan = { title: string; text: string; headings: number; anchors: Anchor[]; hasPasswordField: boolean };

function scan(html: string): Scan {
  const parts: string[] = [];
  const anchors: Anchor[] = [];
  let title: string | undefined;
  let headings = 0;
  let hasPasswordField = false;
  // The text of the heading and of the link that are open.
  let heading: string[] | null = null;
  let anchor: { href: string; parts: string[] } | null = null;

  const closeHeading = () => {
    if (heading !== null && tidy(heading.join('')) !== '') headings += 1;
    heading = null;
  };
  const closeAnchor = () => {
    if (anchor !== null && anchor.href.trim() !== '') anchors.push({ href: anchor.href, text: tidy(anchor.parts.join('')) });
    anchor = null;
  };
  const write = (text: string) => {
    parts.push(text);
    heading?.push(text);
    anchor?.parts.push(text);
  };

  let at = 0;
  while (at < html.length) {
    const open = html.indexOf('<', at);
    const textEnd = open === -1 ? html.length : open;
    if (textEnd > at) write(decode(html.slice(at, textEnd)));
    if (open === -1) break;

    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4);
      at = end === -1 ? html.length : end + 3;
      write(' ');
      continue;
    }
    if (html[open + 1] === '!' || html[open + 1] === '?') {
      // A doctype or a processing instruction.
      const end = html.indexOf('>', open);
      at = end === -1 ? html.length : end + 1;
      continue;
    }
    const tag = readTag(html, open);
    if (tag === null) {
      write('<');
      at = open + 1;
      continue;
    }
    at = tag.end;
    write(' ');

    const closer = CLOSING.get(tag.name);
    if (closer !== undefined && !tag.closing) {
      // <svg ... /> has no content.
      if (tag.name === 'svg' && tag.attributes.trimEnd().endsWith('/')) continue;
      closer.lastIndex = at;
      const found = closer.exec(html);
      if (tag.name === 'title' && title === undefined) title = tidy(decode(html.slice(at, found?.index ?? html.length)));
      if (found === null) {
        at = html.length;
      } else {
        const end = html.indexOf('>', found.index);
        at = end === -1 ? html.length : end + 1;
      }
      continue;
    }

    if (HEADING.test(tag.name)) {
      // A heading that is still open when another starts or ends is over.
      closeHeading();
      if (!tag.closing) heading = [];
    } else if (tag.name === 'a') {
      closeAnchor();
      if (!tag.closing) {
        const href = attributes(tag.attributes).get('href');
        if (href !== undefined) anchor = { href, parts: [] };
      }
    } else if (tag.name === 'input' && !tag.closing) {
      if (attributes(tag.attributes).get('type')?.trim().toLowerCase() === 'password') hasPasswordField = true;
    }
  }
  closeHeading();
  closeAnchor();

  return { title: title ?? '', text: tidy(parts.join('')), headings, anchors, hasPasswordField };
}

const countWords = (text: string): number => text.split(' ').filter((word) => /[\p{L}\p{N}]/u.test(word)).length;

/** `url` is where the page was found (the final one, after the redirects): its links and its path are read against it. */
export function analyzeHtml(html: string, url: string): PageAnalysis {
  const { title, text, headings, anchors, hasPasswordField } = scan(html);
  const words = countWords(text);

  let path = '';
  try {
    path = new URL(url).pathname;
  } catch {
    // Not an address: there is no path to read.
  }
  const loginWall = (hasPasswordField && words < LOGIN_WALL_BELOW_WORDS) || LOGIN_PATH.test(path);

  let thin: boolean | null = null;
  if (words >= UNKNOWN_BELOW_WORDS) {
    const showsTheProduct = findDemoLinks(anchors, url).length > 0;
    thin = (headings < THIN_BELOW_HEADINGS || words < THIN_BELOW_WORDS) && !showsTheProduct;
  }
  return { title, text, words, headings, anchors, loginWall, thin };
}
