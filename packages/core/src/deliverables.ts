// The texts that go to the client with the video: claims.md, every claim the video makes with the words on the site that
// back it, and music.md, where the music comes from and how it may be used. Both are built from what the checks read:
// the lines on screen and their quotes, never a claim's own `text`, which no check looks at.
import type { Edl } from './edl';
import type { SiteData } from './site';
import { layoutScenes } from './timing';

/** The muted version of the main video, which every order gets. */
const MUTED_FILE = 'hook-a-9x16-muted.mp4';

// What Markdown would read as formatting in a text from the site or the model, escaped; whitespace (a quote may hold a
// line break) folded into single spaces, so each item keeps its two lines.
const plain = (text: string): string =>
  text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\`*_[\]<>]/g, (char) => `\\${char}`);

/**
 * claims.md for the video of `hook`: that hook, the body and the cta, in playing order. One item per scene and claim, with
 * the lines of the scene that state the claim as the viewer reads them, the quote that backs them, the site and the
 * section the quote is from. The same words for the same claim are listed once. A hook the edit list does not have is a
 * RangeError.
 */
export function claimsMarkdown(edl: Edl, site: SiteData, hook = 0): string {
  const claims = new Map(edl.claims.map((claim) => [claim.id, claim]));
  const listed = new Set<string>();
  const items: string[] = [];
  for (const { scene } of layoutScenes(edl, hook).scenes) {
    // The lines of the scene that state each claim, read together, in the order the claims first appear in it.
    const stated = new Map<string, string[]>();
    for (const line of scene.lines) {
      if (line.kind !== 'claim' || line.claimId === undefined || !claims.has(line.claimId)) continue;
      stated.set(line.claimId, [...(stated.get(line.claimId) ?? []), line.text]);
    }
    for (const [id, texts] of stated) {
      const claim = claims.get(id);
      if (claim === undefined) continue;
      const onScreen = plain(texts.join(' '));
      const key = JSON.stringify([id, onScreen]);
      if (listed.has(key)) continue;
      listed.add(key);
      const heading = site.sections.find((section) => section.id === claim.sectionId)?.heading ?? claim.sectionId;
      items.push(`- **${onScreen}**\n  Source: "${plain(claim.quote)}" (${site.url}, section "${plain(heading)}")`);
    }
  }
  const intro =
    items.length > 0
      ? 'Every claim the video makes about the product, as it reads on screen, with the words on the site it comes from.'
      : 'The video makes no claims about the product: every line is a question, a pain or a call to action.';
  return [`# Claims`, '', intro, '', ...items, ''].join('\n');
}

/** A measured tempo, to a tenth of a beat per minute. */
const bpmText = (bpm: number): string => (Number.isInteger(bpm) ? String(bpm) : bpm.toFixed(1));

/**
 * The model that makes each candidate track, in the order the candidates are asked for (the first candidate is the first
 * model): two of Lyria 3.5 and one of Lyria 3 Pro, since 5 of the 8 Lyria 3.5 tracks measured skipped once in the part the
 * video plays and the 2 Lyria 3 Pro tracks did not. It is here, and not with the music step, because music.md names the
 * model of the track that was chosen and this package cannot read the service's. The ids are the Gemini API's.
 */
export const MUSIC_MODELS = ['lyria-3.5', 'lyria-3.5', 'lyria-3-pro-preview'] as const;
export type MusicModel = (typeof MUSIC_MODELS)[number];

/** What music.md calls each model. */
const MUSIC_MODEL_NAMES: Record<MusicModel, string> = {
  'lyria-3.5': 'Google Lyria 3.5',
  'lyria-3-pro-preview': 'Google Lyria 3 Pro',
};

/**
 * music.md, for an order delivered with music: the model that made the track, the direction it was made from, the
 * tempo measured on it, and how it may be used.
 */
export function musicMarkdown({ measuredBpm, musicPrompt, model }: { measuredBpm: number; musicPrompt: string; model: MusicModel }): string {
  return [
    '# Music',
    '',
    `The music of hook-a-9x16.mp4 was made for this video by ${MUSIC_MODEL_NAMES[model]}, an AI music model, from this direction:`,
    '',
    ...musicPrompt
      .trim()
      .split('\n')
      .map((line) => `> ${line}`),
    '',
    `Tempo: ${bpmText(measuredBpm)} BPM, measured on the track. The cuts of the video land on its beats.`,
    '',
    'The track carries SynthID, an inaudible watermark that marks it as made by AI. You may use it in this ad, paid ads',
    'included. Some platforms ask you to say when an ad uses AI-generated content: check their rules.',
    '',
    `To use music of your own, start from ${MUTED_FILE}: the same video, without sound.`,
    '',
  ].join('\n');
}
