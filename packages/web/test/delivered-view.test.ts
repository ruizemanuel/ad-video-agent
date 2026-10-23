import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StatusJson } from '../src/payments/orders';
import { DeliveredView } from '../src/site/DeliveredView';
import { xIntentUrl } from '../src/site/share';

const BASE = 'https://ad-video-agent.example.com';
const ID = 'ord_abcdefgh2345678abcdefgh2';
const SITE_URL = 'https://cobrame.example/';
const FILE = (name: string): string => `${BASE}/v1/files/${ID}/${name}?exp=1800000000&sig=${'a'.repeat(64)}`;
const WITH_MUSIC = FILE('hook-a-9x16.mp4');
const MUTED = FILE('hook-a-9x16-muted.mp4');

const CLAIMS = [
  { onScreen: 'Get paid on time', quote: 'Invoices that chase themselves, so you get paid on time.', url: 'https://cobrame.example/', section: 'Get paid' },
  { onScreen: 'Reminders on WhatsApp', quote: 'Friendly reminders go out on WhatsApp before each due date.', url: 'https://cobrame.example/features', section: 'Reminders' },
];

/** A delivered order's status, as the service gives it: the four files, two claims and the music. */
function delivered(over: Partial<StatusJson> = {}): StatusJson {
  return {
    id: ID,
    status: 'delivered',
    steps: [],
    files: [
      { name: 'hook-a-9x16.mp4', url: WITH_MUSIC, bytes: 1_000_000 },
      { name: 'hook-a-9x16-muted.mp4', url: MUTED, bytes: 900_000 },
      { name: 'claims.md', url: FILE('claims.md'), bytes: 400 },
      { name: 'music.md', url: FILE('music.md'), bytes: 300 },
    ],
    claims: CLAIMS,
    music: { model: 'Google Lyria 3.5', bpm: 120 },
    warnings: [],
    ...over,
  };
}

const render = (status: StatusJson): string => renderToStaticMarkup(createElement(DeliveredView, { status, site: 'cobrame.example', siteUrl: SITE_URL, shortId: ID.slice(4, 12) }));

/** The text of some markup, without its tags, with its entities and typographic quotes and apostrophes as plain ones. */
const text = (html: string, tagsAs = ''): string =>
  html
    .replace(/<[^>]+>/g, tagsAs)
    .replace(/&#x27;|&#39;|’/g, "'")
    .replace(/&quot;|“|”/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** The words of some markup, as one line. */
const words = (html: string): string => text(html, ' ').replace(/\s+/g, ' ');

const unescape = (value: string): string => value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'");

/** The attributes of the first tag that matches, by name; a bare attribute (`controls`) is the empty string. */
function attributes(html: string, tag: RegExp): Record<string, string> {
  const match = tag.exec(html);
  if (match === null) throw new Error(`No ${tag} in ${html}`);
  const found: Record<string, string> = {};
  for (const [, name = '', value] of match[0].matchAll(/\s([a-zA-Z-]+)(?:="([^"]*)")?/g)) found[name.toLowerCase()] = unescape(value ?? '');
  return found;
}

/** The links of the markup, each with its attributes and its words. */
const links = (html: string): { href: string; download?: string; target?: string; rel?: string; words: string }[] =>
  [...html.matchAll(/<a [^>]*>[\s\S]*?<\/a>/g)].map((match) => {
    const { href = '', download, target, rel } = attributes(match[0], /<a [^>]*>/);
    return { href, ...(download === undefined ? {} : { download }), ...(target === undefined ? {} : { target }), ...(rel === undefined ? {} : { rel }), words: words(match[0]).trim() };
  });

const PROTOCOL_WORDS = ['x402', 'EIP-3009', 'facilitator', 'settlement', 'nonce', 'authorization'];

describe('the delivery view', () => {
  it('offers both files and the post intent', () => {
    const html = render(delivered());

    // The video plays on the page: the one with music, from the signed link.
    const video = attributes(html, /<video[^>]*>/);
    expect(video).toMatchObject({ src: WITH_MUSIC, preload: 'metadata' });
    expect(video).toHaveProperty('controls');
    expect(video).toHaveProperty('playsinline');
    expect(video['aria-label']).toBe('The video made from cobrame.example');

    const found = links(html);
    expect(found.find(({ words }) => words === 'Download MP4')).toMatchObject({ href: WITH_MUSIC, download: 'hook-a-9x16.mp4' });
    expect(found.find(({ words }) => words === 'Muted version')).toMatchObject({ href: MUTED, download: 'hook-a-9x16-muted.mp4' });
    // X opens in a tab of its own with the first line of the video and the site: nothing of ours.
    expect(found.find(({ words }) => words === 'Post on X')).toEqual({
      href: xIntentUrl('Get paid on time', SITE_URL),
      target: '_blank',
      rel: 'noopener noreferrer',
      words: 'Post on X',
    });
    expect(xIntentUrl('Get paid on time', SITE_URL)).toBe('https://x.com/intent/post?text=Get%20paid%20on%20time%20https%3A%2F%2Fcobrame.example%2F');

    const said = words(html);
    expect(said).toContain('Your video is ready');
    expect(said).toContain('cobrame.example · order abcdefgh…');
    expect(said).toContain('"Post on X" opens X with a short text ready; attach the MP4 you downloaded.');
    expect(said).toContain('cobrame.example · 1080×1920');
    // The length is the player's to say once it knows it: the server has none to give.
    expect(said).not.toMatch(/\d s\b/);
  });

  it('lists every claim with its quote', () => {
    const html = render(delivered());
    const said = words(html);
    expect(said).toContain('Where each line comes from');
    for (const { onScreen, quote, section } of CLAIMS) {
      expect(said).toContain(onScreen);
      expect(said).toContain(`"${quote}"`);
      expect(said).toContain(section);
    }
    // Each line next to its own quote, and in the order the video says them.
    const items = [...html.matchAll(/<li[ >][\s\S]*?<\/li>/g)].map((item) => words(item[0]));
    expect(items).toHaveLength(CLAIMS.length);
    CLAIMS.forEach(({ onScreen, quote, section }, index) => {
      expect(items[index]).toContain(onScreen);
      expect(items[index]).toContain(`"${quote}"`);
      expect(items[index]).toContain(section);
    });
    // The page each quote is from is a link to it.
    expect(links(html).map(({ href }) => href)).toEqual(expect.arrayContaining(['https://cobrame.example/', 'https://cobrame.example/features']));
  });

  it('omits the sources for an order without claims', () => {
    const { claims: _claims, ...without } = delivered();
    const html = render(without);
    expect(words(html)).not.toContain('Where each line comes from');
    expect(html).not.toContain('<li');
    // With no line to post, the post is the site's host and its address.
    expect(links(html).find(({ words }) => words === 'Post on X')?.href).toBe(xIntentUrl('cobrame.example', SITE_URL));
    // Nothing else of the view goes with it.
    expect(words(html)).toContain('Download MP4');
    expect(words(html)).toContain('Did you post it?');
  });

  it('uses the muted file when it is the only video', () => {
    const { music: _music, ...silent } = delivered({
      files: [
        { name: 'hook-a-9x16-muted.mp4', url: MUTED, bytes: 900_000 },
        { name: 'claims.md', url: FILE('claims.md'), bytes: 400 },
      ],
    });
    const html = render(silent);
    expect(attributes(html, /<video[^>]*>/).src).toBe(MUTED);
    const found = links(html);
    // The one video is the download; a second button to the same file would only confuse.
    expect(found.find(({ words }) => words === 'Download MP4')).toMatchObject({ href: MUTED, download: 'hook-a-9x16-muted.mp4' });
    expect(found.map(({ words }) => words)).not.toContain('Muted version');
    // And an order without music says nothing about music.
    expect(words(html)).not.toContain('Music');
  });

  it('says where the music comes from and that it may be used in ads', () => {
    expect(words(render(delivered()))).toContain('Music: made for this video by Google Lyria 3.5, 120 BPM. You may use it in this ad, paid ads included.');
    expect(words(render(delivered({ music: { model: 'Google Lyria 3 Pro', bpm: 115.4 } })))).toContain('by Google Lyria 3 Pro, 115.4 BPM.');
  });

  it('shows no player and no download for an order with no video file', () => {
    const html = render(delivered({ files: [{ name: 'claims.md', url: FILE('claims.md'), bytes: 400 }] }));
    expect(html).not.toContain('<video');
    expect(links(html).map(({ words }) => words)).not.toContain('Download MP4');
  });

  it('asks whether the person posted it, with nothing chosen', () => {
    const html = render(delivered());
    const said = words(html);
    expect(said).toContain('Did you post it?');
    const radios = [...html.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map((match) => attributes(match[0], /<input[^>]*>/));
    expect(radios.map(({ value }) => value)).toEqual(['as_is', 'with_changes', 'not_yet']);
    for (const radio of radios) expect(radio).not.toHaveProperty('checked');
    for (const label of ['As is', 'With changes', 'Not yet']) expect(said).toContain(label);
    // The link is optional, and the permission has nothing to be about until there is one.
    const field = attributes(html, /<input[^>]*placeholder="Link to your post \(optional\)"[^>]*>/);
    expect(field.value).toBe('');
    const permission = attributes(html, /<input[^>]*type="checkbox"[^>]*>/);
    expect(permission).toHaveProperty('disabled');
    expect(permission).not.toHaveProperty('checked');
    expect(said).toContain('You can show this post as an example');
    // Nothing here stands between the person and the video.
    expect(links(html).map(({ words }) => words)).toEqual(expect.arrayContaining(['Download MP4', 'Muted version', 'Post on X']));
  });

  it('shows what was saved, to change it', () => {
    const html = render(delivered({ feedback: { answer: 'with_changes', postUrl: 'https://x.com/cobrame/status/123', mayShow: true } }));
    const radios = [...html.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map((match) => attributes(match[0], /<input[^>]*>/));
    expect(radios.filter((radio) => 'checked' in radio).map(({ value }) => value)).toEqual(['with_changes']);
    expect(attributes(html, /<input[^>]*placeholder="Link to your post \(optional\)"[^>]*>/).value).toBe('https://x.com/cobrame/status/123');
    const permission = attributes(html, /<input[^>]*type="checkbox"[^>]*>/);
    expect(permission).toHaveProperty('checked');
    expect(permission).not.toHaveProperty('disabled');

    // An answer with no link has no permission to show it.
    const bare = render(delivered({ feedback: { answer: 'not_yet', postUrl: null, mayShow: false } }));
    expect(attributes(bare, /<input[^>]*placeholder="Link to your post \(optional\)"[^>]*>/).value).toBe('');
    expect(attributes(bare, /<input[^>]*type="checkbox"[^>]*>/)).toHaveProperty('disabled');
  });

  it('keeps protocol words out', () => {
    const said = words(render(delivered())).toLowerCase();
    for (const word of PROTOCOL_WORDS) expect(said, word).not.toContain(word.toLowerCase());
  });
});
