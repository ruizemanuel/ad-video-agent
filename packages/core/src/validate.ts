// Checks an edit list by code, before any model reviews it or any frame is rendered: quotes are verbatim, numbers
// on screen are in their quote, framing lines carry no data, no filler phrases, and the structure the schema
// leaves open. The same module builds what the semantic judge reads and applies the fixes a corrector returns.
import { BANNED_PHRASES, type BannedPhrases } from './banned-phrases';
import type { Claim, Edl, Scene } from './edl';
import { isProductTarget } from './product';
import type { SiteData } from './site';
import { FPS, layoutScenes, MIN_AT_BEAT, MIN_ENDCARD_BEATS, wordCycleMinBeats, type TimedScene } from './timing';

export type Problem = {
  /**
   * The scene path (`hooks[i][j]`, `body[j]` or `cta`), optionally followed by a detail such as `.lines[2]`, so
   * `where.split('.')[0]` is always the scene path. A problem that is not about one scene says `edl`.
   */
  where: string;
  rule: 'quote-missing' | 'number-mismatch' | 'framing-has-data' | 'banned-phrase' | 'structure' | 'not-equivalent' | 'framing-asserts' | 'visual';
  detail: string;
};
export type JudgeItem = { id: string; onScreen: string; quote: string };
/** A framing line, and the other lines of its scene in order: read together, two lines can claim what neither does alone. */
export type FramingItem = { id: string; text: string; context: string[] };
export type ScenePatch = { path: string; scene: Scene };

const HOOKS = { min: 1, max: 3 };
const BPM = { min: 90, max: 128 };
const SCENE_BEATS = { min: 2, max: 8 };
// Three words is the most that hold two beats each in the longest scene (7 of its 8 beats).
const CYCLE_WORDS = { min: 2, max: 3 };
const VIDEO_SECONDS = { min: 15, max: 30 };

type Report = (where: string, rule: Problem['rule'], detail: string) => void;

// ---------- text ----------

// Case, spacing (non-breaking spaces included) and typographic quotes don't count as differences.
const norm = (s: string): string =>
  s
    .normalize('NFC')
    .replace(/[“”«»„]/g, '"')
    .replace(/[‘’‚]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
// Also accent-insensitive, for banned phrases.
const fold = (s: string): string => norm(s).normalize('NFD').replace(/\p{M}/gu, '');

const NUMBER = /\d+([.,]\d+)?\s?%?/g;
// "0 %" and "0%" are the same number; "3 %" and "2,9 %" are not.
const numbers = (s: string): string[] => (s.match(NUMBER) ?? []).map((n) => n.replace(/\s/g, ''));

/** The address a TypeIn "url" scene types: the host of the site, without "www.", in lower case. Undefined for a bad URL. */
export const siteHost = (url: string): string | undefined => {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return undefined;
  }
};

// ---------- scenes ----------

// The line a TypeIn url scene types is the site address: its only rule is being equal to the host (checkTypeIn).
const isTypedAddress = (scene: Scene, k: number): boolean => scene.piece === 'TypeIn' && scene.variant === 'url' && k === 0;

export const scenePaths = (edl: Edl): { path: string; scene: Scene }[] => [
  ...edl.hooks.flatMap((hook, i) => hook.map((scene, j) => ({ path: `hooks[${i}][${j}]`, scene }))),
  ...edl.body.map((scene, j) => ({ path: `body[${j}]`, scene })),
  { path: 'cta', scene: edl.cta },
];

// The scene path of a scene of the video of `hook`, as layoutScenes laid it out (that hook, the body, the cta).
// The VM labels each key frame with it and the code checks report it, so both name a scene the way validateEdl does.
export const timedScenePath = (edl: Edl, hook: number, timed: TimedScene): string => {
  if (timed.role === 'cta') return 'cta';
  if (timed.role === 'hook') return `hooks[${hook}][${timed.index}]`;
  const hookScenes = edl.hooks[hook];
  if (!hookScenes) throw new RangeError(`There is no hook ${hook}; the edit list has ${edl.hooks.length}.`);
  return `body[${timed.index - hookScenes.length}]`;
};

// ---------- validateEdl ----------

// Step 1: each quote is verbatim in its section.
const checkClaims = (edl: Edl, site: SiteData, report: Report): void => {
  for (const claim of edl.claims) {
    const section = site.sections.find((s) => s.id === claim.sectionId);
    if (!section) report('edl', 'quote-missing', `claim ${claim.id}: section ${claim.sectionId} does not exist`);
    else if (!norm(claim.quote)) report('edl', 'quote-missing', `claim ${claim.id}: the quote is empty`);
    else if (!norm(`${section.heading}\n${section.text}`).includes(norm(claim.quote)))
      report('edl', 'quote-missing', `claim ${claim.id}: quote not found verbatim in ${claim.sectionId}: "${claim.quote}"`);
  }
};

// Steps 2 and 3, line by line: numbers, framing without data, banned phrases.
const checkLines = (path: string, scene: Scene, claims: Map<string, Claim>, banned: [string, string][], report: Report): void => {
  scene.lines.forEach((line, k) => {
    const at = `${path}.lines[${k}]`;
    // A host such as club365.com or unlock.xyz must not trip the rules for copy.
    const typedAddress = isTypedAddress(scene, k);
    if (line.kind === 'claim') {
      const claim = line.claimId === undefined ? undefined : claims.get(line.claimId);
      if (!claim) report(at, 'quote-missing', `claim line "${line.text}" has no existing claimId (${line.claimId ?? 'none'})`);
      else {
        // Numbers on screen must appear in the quote exactly.
        const inQuote = new Set(numbers(claim.quote));
        for (const n of numbers(line.text))
          if (!inQuote.has(n)) report(at, 'number-mismatch', `"${n}" is not in the quote of ${claim.id}: "${claim.quote}"`);
      }
    } else if (!typedAddress && numbers(line.text).length) {
      report(at, 'framing-has-data', `framing line "${line.text}" contains numbers: ${numbers(line.text).join(', ')}`);
    }
    if (line.accent !== undefined && !line.text.includes(line.accent))
      report(at, 'structure', `accent "${line.accent}" is not a substring of the line`);

    const folded = fold(line.text);
    const found = typedAddress ? [] : banned.filter(([, phrase]) => folded.includes(phrase)).map(([original]) => `"${original}"`);
    if (found.length) report(at, 'banned-phrase', `"${line.text}" contains ${found.join(', ')}`);
  });
};

// A UiFocus or a UiScroll films the page: its target is a box of the shot, and the box has to be product UI, because a
// text card (a feature, a "why us" section) filmed under a caption reads as the product the caption talks about.
const checkShot = (path: string, scene: Scene, site: SiteData, report: Report): void => {
  const shot = site.shots.find((s) => s.id === scene.shotId);
  const target = shot && scene.boxIndex !== undefined ? site.boxes.filter((b) => b.shotId === shot.id)[scene.boxIndex] : undefined;
  if (!shot) report(path, 'structure', `${scene.piece} with unknown shotId ${scene.shotId ?? 'none'}`);
  else if (scene.boxIndex !== undefined && !target) report(path, 'structure', `boxIndex ${scene.boxIndex} out of range for ${shot.id}`);
  if (scene.boxIndex === undefined) report(path, 'structure', `${scene.piece} needs a boxIndex`);
  if (shot && target && scene.boxIndex !== undefined && !isProductTarget(site, shot.id, scene.boxIndex)) {
    const named = target.text === undefined ? target.kind : `"${target.text}"`;
    report(
      path,
      'structure',
      `${scene.piece} must film product UI: box ${scene.boxIndex} (${named}) of ${shot.id} has no image or price in its section or card; state this claim in a type scene or aim at product UI`,
    );
  }
};

const checkTypeIn = (path: string, scene: Scene, site: SiteData, report: Report): void => {
  if (scene.lines.length !== 1) report(path, 'structure', `TypeIn needs exactly 1 line, got ${scene.lines.length}`);
  if (!scene.variant) {
    report(path, 'structure', 'TypeIn needs a variant ("url" or "prompt")');
    return;
  }
  const line = scene.lines[0];
  if (scene.variant !== 'url' || !line) return;
  if (line.kind !== 'framing') report(`${path}.lines[0]`, 'structure', 'the line of a TypeIn url must be framing');
  const host = siteHost(site.url);
  if (host === undefined) report(path, 'structure', `the site address "${site.url}" is not a valid URL`);
  else if (norm(line.text) !== host) report(`${path}.lines[0]`, 'structure', `a TypeIn url must type the site host "${host}", got "${line.text}"`);
};

const checkAtBeat = (path: string, scene: Scene, report: Report): void => {
  const allowed = scene.piece === 'UiFocus' || scene.piece === 'UiScroll';
  scene.lines.forEach((line, k) => {
    if (line.atBeat === undefined) return;
    const at = `${path}.lines[${k}]`;
    if (!allowed || k !== 1) report(at, 'structure', 'atBeat belongs only on the second line of a UiFocus or UiScroll scene');
    else if (line.atBeat < MIN_AT_BEAT || line.atBeat >= scene.beats) report(at, 'structure', `atBeat ${line.atBeat} outside ${MIN_AT_BEAT}-${scene.beats - 1}`);
  });
};

// Structure of one scene that the schema leaves open.
const checkScene = (path: string, scene: Scene, site: SiteData, report: Report): void => {
  if (scene.beats < SCENE_BEATS.min || scene.beats > SCENE_BEATS.max)
    report(path, 'structure', `${scene.beats} beats (expected ${SCENE_BEATS.min}-${SCENE_BEATS.max})`);
  if (scene.piece === 'UiFocus' || scene.piece === 'UiScroll') checkShot(path, scene, site, report);
  if (scene.piece === 'ClaimStack' && (scene.lines.length < 2 || scene.lines.length > 3)) report(path, 'structure', 'ClaimStack needs 2 or 3 lines');
  if (scene.piece === 'WordCycle') {
    const [prefix, ...words] = scene.lines;
    if (prefix?.kind !== 'framing') report(path, 'structure', 'WordCycle needs a framing line first');
    const count = words.length;
    if (count < CYCLE_WORDS.min || count > CYCLE_WORDS.max) report(path, 'structure', `WordCycle needs ${CYCLE_WORDS.min} or ${CYCLE_WORDS.max} words after its framing line, got ${count}`);
    // The words are spread over the scene, each holding two beats at least (see wordEnterFrame): that takes two beats per word
    // plus one. Said only for a count of words the scene could have, so that it never asks for more beats than a scene lasts.
    else if (scene.beats < wordCycleMinBeats(count)) report(path, 'structure', `WordCycle needs two beats per word plus one (${wordCycleMinBeats(count)}), got ${scene.beats}`);
  }
  if (scene.piece === 'TypeIn') checkTypeIn(path, scene, site, report);
  checkAtBeat(path, scene, report);
};

// Structure of the whole edit list.
const checkEdl = (edl: Edl, report: Report): void => {
  if (edl.hooks.length < HOOKS.min || edl.hooks.length > HOOKS.max)
    report('edl', 'structure', `expected ${HOOKS.min} to ${HOOKS.max} hooks, got ${edl.hooks.length}`);
  if (edl.cta.piece !== 'EndCard') report('cta', 'structure', `cta must be an EndCard, got ${edl.cta.piece}`);
  else {
    if (edl.cta.lines.length < 1 || edl.cta.lines.length > 2) report('cta', 'structure', `an EndCard needs 1 or 2 lines, got ${edl.cta.lines.length}`);
    if (edl.cta.beats < MIN_ENDCARD_BEATS) report('cta', 'structure', `an EndCard needs ${MIN_ENDCARD_BEATS} beats or more for its two steps, got ${edl.cta.beats}`);
  }
  if (!(edl.bpm >= BPM.min && edl.bpm <= BPM.max)) report('edl', 'structure', `bpm ${edl.bpm} outside ${BPM.min}-${BPM.max}`);
  // The main video is the one built with hook 0: that hook, the body and the cta.
  if (edl.hooks[0] && Number.isFinite(edl.bpm) && edl.bpm > 0) {
    const seconds = layoutScenes(edl, 0).total / FPS;
    if (seconds < VIDEO_SECONDS.min || seconds > VIDEO_SECONDS.max)
      report('edl', 'structure', `the video with hook 0 lasts ${seconds.toFixed(2)} s (expected ${VIDEO_SECONDS.min}-${VIDEO_SECONDS.max})`);
  }
};

export const validateEdl = (edl: Edl, site: SiteData, banned: BannedPhrases = BANNED_PHRASES): Problem[] => {
  const problems: Problem[] = [];
  const report: Report = (where, rule, detail) => problems.push({ where, rule, detail });
  const claims = new Map(edl.claims.map((c) => [c.id, c]));
  // Distinct folded phrases, the first spelling of each: the lists spell some phrases with and without accent.
  const bannedFolded: [string, string][] = [];
  for (const phrase of [...banned.es, ...banned.en]) {
    const folded = fold(phrase);
    if (!bannedFolded.some(([, seen]) => seen === folded)) bannedFolded.push([phrase, folded]);
  }

  checkClaims(edl, site, report);
  for (const { path, scene } of scenePaths(edl)) {
    checkLines(path, scene, claims, bannedFolded, report);
    checkScene(path, scene, site, report);
  }
  checkEdl(edl, report);
  return problems;
};

// ---------- the semantic judge ----------

// What the judge reads: one item per (scene, claim) with the lines that state it read together, and one per framing
// line, with the rest of its scene, which must not assert anything about the product. The address a TypeIn url types
// is left out: its only rule is being the host (checkTypeIn), and a judge could read a bare domain as a claim that no
// fix could take back.
export const judgeItems = (edl: Edl): { claims: JudgeItem[]; framing: FramingItem[] } => {
  const known = new Map(edl.claims.map((c) => [c.id, c]));
  const items: { claims: JudgeItem[]; framing: FramingItem[] } = { claims: [], framing: [] };
  for (const { path, scene } of scenePaths(edl)) {
    const stated = new Map<string, { claim: Claim; texts: string[] }>();
    scene.lines.forEach((line, k) => {
      if (line.kind === 'framing') {
        const context = scene.lines.filter((_, j) => j !== k).map((neighbour) => neighbour.text);
        if (!isTypedAddress(scene, k)) items.framing.push({ id: `${path}:framing:${k}`, text: line.text, context });
        return;
      }
      const claim = line.claimId === undefined ? undefined : known.get(line.claimId);
      // A claim line without a claim is a problem validateEdl reports; there is nothing to judge it against.
      if (claim) stated.set(claim.id, { claim, texts: [...(stated.get(claim.id)?.texts ?? []), line.text] });
    });
    for (const { claim, texts } of stated.values()) items.claims.push({ id: `${path}:${claim.id}`, onScreen: texts.join(' '), quote: claim.quote });
  }
  return items;
};

// ---------- fixes ----------

const SCENE_PATH = /^(?:hooks\[(\d+)\]\[(\d+)\]|body\[(\d+)\]|cta)$/;

// Puts each patched scene at its path and upserts the corrected claims by id (a new id goes at the end).
// The edit list it is given is not modified. A path that names no scene is a RangeError: patches come from a model.
export const applyPatches = (edl: Edl, patches: ScenePatch[], claimFixes: Claim[]): Edl => {
  const hooks = edl.hooks.map((hook) => [...hook]);
  const body = [...edl.body];
  let cta = edl.cta;
  for (const { path, scene } of patches) {
    const match = SCENE_PATH.exec(path);
    if (!match) throw new RangeError(`"${path}" is not a scene path (hooks[i][j], body[j] or cta).`);
    const [, hookIndex, sceneIndex, bodyIndex] = match;
    if (path === 'cta') cta = scene;
    else if (hookIndex !== undefined && sceneIndex !== undefined) {
      const hook = hooks[Number(hookIndex)];
      if (!hook || Number(sceneIndex) >= hook.length) throw new RangeError(`There is no scene at ${path}.`);
      hook[Number(sceneIndex)] = scene;
    } else {
      if (Number(bodyIndex) >= body.length) throw new RangeError(`There is no scene at ${path}.`);
      body[Number(bodyIndex)] = scene;
    }
  }
  const claims = [...edl.claims];
  for (const fix of claimFixes) {
    const at = claims.findIndex((c) => c.id === fix.id);
    if (at >= 0) claims[at] = fix;
    else claims.push(fix);
  }
  return { ...edl, hooks, body, cta, claims };
};
