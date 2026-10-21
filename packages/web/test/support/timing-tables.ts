// The tables of the director's prompt that say what fits in a scene at each tempo, computed from the reading rule itself
// (core's captionRoom, textRoom and fewestBeats). The prompt carries them as literals, since computing them costs about
// half a second at load; the prompt tests compare the two, so that the prompt cannot drift from what validateEdl checks.
// Each row holds at every half bpm of its band (the worst of them) and wherever the scene plays (first in the video or
// later, before a wipe), so the prompt never suggests what validateEdl refuses.
import { captionRoom, fewestBeats, textRoom, type Line, type Scene } from '@app/core';
import { TABLE_LIMITS, TEMPO_BANDS } from '../../src/prompts/director';

type Band = readonly [number, number];
type Column = { head: string; value: (bpm: number) => number | undefined };
export type Row = { band: Band; values: (number | undefined)[] };

// Every half bpm of a band, its ends included.
const temposOf = ([low, high]: Band): number[] => Array.from({ length: (high - low) * 2 + 1 }, (_, i) => low + i / 2);

/** A text of `chars` characters and `words` words: what it says does not count, only how long it is. */
export const sample = (chars: number, words: number): Line => {
  const letters = chars - (words - 1);
  const lengths = Array.from({ length: words }, (_, i) => Math.floor(letters / words) + (i < letters % words ? 1 : 0));
  return { text: lengths.map((length) => 'a'.repeat(length)).join(' '), kind: 'framing' };
};

const ui = (beats: number, captions: 1 | 2, head: string): Column => ({ head, value: (bpm) => captionRoom(beats, bpm, captions) });
const typed = (beats: number, head: string): Column => ({ head, value: (bpm) => textRoom({ piece: 'TypeIn', beats, variant: 'url', lines: [sample(1, 1)] }, bpm)[0] });
const close = (line: 0 | 1, head: string): Column => ({ head, value: (bpm) => textRoom({ piece: 'EndCard', beats: 6, lines: [sample(1, 1), sample(1, 1)] }, bpm)[line] });

/** The most characters a text can have, by the beats of its scene. */
export const CHARACTER_COLUMNS: Column[] = [
  ui(3, 1, 'caption in 3 beats'),
  ui(4, 1, '4 beats'),
  ui(5, 1, '5 beats'),
  ui(6, 1, '6 beats'),
  ui(8, 1, '8 beats'),
  ui(7, 2, 'each of 2 captions in 7 beats'),
  ui(8, 2, '8 beats'),
  typed(5, 'typed in 5 beats'),
  typed(6, '6 beats'),
  typed(8, '8 beats'),
  close(0, 'button of a 6-beat close'),
  close(1, 'its tagline'),
];

const lines = (count: number, limit: { chars: number; words: number }): Line[] => Array.from({ length: count }, () => sample(limit.chars, limit.words));
const needs = (head: string, scene: Omit<Scene, 'beats'>): Column => ({ head, value: (bpm) => fewestBeats({ ...scene, beats: 2 }, bpm) });
const cycle = (words: number): Omit<Scene, 'beats'> => ({
  piece: 'WordCycle',
  lines: [sample(TABLE_LIMITS.prefix.chars, TABLE_LIMITS.prefix.words), ...lines(words, TABLE_LIMITS.word)],
});

/** The fewest beats a type piece needs, its lines at the limits the prompt states (TABLE_LIMITS). */
export const BEAT_COLUMNS: Column[] = [
  needs('headline of 1 line', { piece: 'KineticHeadline', lines: lines(1, TABLE_LIMITS.headline) }),
  needs('2 lines', { piece: 'KineticHeadline', lines: lines(2, TABLE_LIMITS.headline) }),
  needs('3 lines', { piece: 'KineticHeadline', lines: lines(3, TABLE_LIMITS.headline) }),
  needs('stack of 2 lines', { piece: 'ClaimStack', lines: lines(2, TABLE_LIMITS.stack) }),
  needs('3 lines', { piece: 'ClaimStack', lines: lines(3, TABLE_LIMITS.stack) }),
  needs('WordCycle of 2 words', cycle(2)),
  needs('3 words', cycle(3)),
];

/**
 * A row per band: the worst value of a column over the tempos of the band, the fewest characters (`room`) or the most
 * beats (`beats`); undefined beats when at some tempo of the band no length a scene may have reads the piece.
 */
const rowsOf = (columns: Column[], worst: 'room' | 'beats'): Row[] =>
  TEMPO_BANDS.map((band) => ({
    band,
    values: columns.map((column) => {
      const values = temposOf(band).map(column.value);
      if (worst === 'room') return Math.min(...values.map((value) => value ?? 0));
      return values.some((value) => value === undefined) ? undefined : Math.max(...values.map((value) => value ?? 0));
    }),
  }));

export const characterRows = (): Row[] => rowsOf(CHARACTER_COLUMNS, 'room');
export const beatRows = (): Row[] => rowsOf(BEAT_COLUMNS, 'beats');

/** A table in Markdown, indented to sit in a list item. A dash where nothing can be read. */
const markdown = (columns: Column[], rows: Row[]): string =>
  [
    `| bpm | ${columns.map((column) => column.head).join(' | ')} |`,
    `|${' --- |'.repeat(columns.length + 1)}`,
    ...rows.map(({ band, values }) => `| ${band[0]}-${band[1]} | ${values.map((value) => (value ? String(value) : '–')).join(' | ')} |`),
  ]
    .map((row) => `  ${row}`)
    .join('\n');

export const characterTable = (rows: Row[] = characterRows()): string => markdown(CHARACTER_COLUMNS, rows);
export const beatTable = (rows: Row[] = beatRows()): string => markdown(BEAT_COLUMNS, rows);
