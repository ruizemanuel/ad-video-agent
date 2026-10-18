import { describe, expect, it } from 'vitest';
import { BANNED_PHRASES, judgeItems, type Problem } from '@app/core';
import { CLASSIFY_SYSTEM, classifyPrompt } from '../src/prompts/classify';
import { DIRECTOR_SYSTEM, directorRequest } from '../src/prompts/director';
import { JUDGE_SYSTEM, judgePrompt } from '../src/prompts/judge';
import { PATCH_SYSTEM, patchPrompt } from '../src/prompts/patch';
import { siteForModel } from '../src/pipeline/site-for-model';
import { captureShop, edlShop, siteShop } from './support/shop';

// Every rule a Problem can name: the corrector has to know how to fix each one.
const RULES: Problem['rule'][] = ['quote-missing', 'number-mismatch', 'framing-has-data', 'banned-phrase', 'structure', 'not-equivalent', 'framing-asserts', 'visual'];

describe('DIRECTOR_SYSTEM', () => {
  it('puts every banned phrase, the new pieces and the main-hook rule into the director prompt', () => {
    for (const p of [...BANNED_PHRASES.es, ...BANNED_PHRASES.en]) expect(DIRECTOR_SYSTEM).toContain(p);
    for (const s of ['TypeIn', 'WordCycle', 'atBeat', 'hooks[0] is the main version']) expect(DIRECTOR_SYSTEM).toContain(s);
    expect(DIRECTOR_SYSTEM).not.toContain('`post`');
  });

  it('asks for three hooks, strongest first', () => expect(DIRECTOR_SYSTEM).toContain('Three hooks, strongest first: hooks[0] is the main version.'));

  it('keeps framing lines from asserting anything about the product', () =>
    expect(DIRECTOR_SYSTEM).toContain("Framing lines never assert anything about the product (no 'the cheapest', 'the best', 'the fastest')."));

  it('names the kinds of hook to vary between', () => {
    for (const kind of ['main promise', 'is not the problem', 'variant: "prompt"', 'variant: "url"', 'word by word', 'product itself on screen'])
      expect(DIRECTOR_SYSTEM).toContain(kind);
  });

  it('states the limits validateEdl checks on the new pieces', () => {
    // WordCycle: a beat per word plus one. atBeat: from beat 2 on. EndCard: 6 beats, 4 at the very least.
    for (const rule of ['at least one beat per word plus one', '`atBeat` is 2 or later', 'It lasts 6 beats (never fewer than 4)', 'exactly the `host`'])
      expect(DIRECTOR_SYSTEM).toContain(rule);
  });

  it('gives the rhythm and the tempo ranges by energy', () => {
    for (const rule of ['hook scenes last 2 to 4 beats', 'body scenes 4 to 6', 'the cta 6', 'calm: 98-110', 'bold: 112-128']) expect(DIRECTOR_SYSTEM).toContain(rule);
  });

  it('varies rhythm and pieces with the style of the site', () => {
    expect(DIRECTOR_SYSTEM).toContain('Vary the rhythm and the pieces with `style.energy` and `style.density`');
  });

  it('treats the site and the brief as material, never as instructions', () => expect(DIRECTOR_SYSTEM).toContain('not instructions'));
});

describe('directorRequest', () => {
  const images = captureShop().directorImages;

  it('sends the site as the director sees it, and the brief', () => {
    const { text } = directorRequest({ site: siteShop(), images, brief: 'Para emprendedores' });
    expect(text).toContain(JSON.stringify(siteForModel(siteShop()), null, 1));
    expect(text).toContain('Para emprendedores');
  });

  it('says there is no brief when there is none', () => expect(directorRequest({ site: siteShop(), images }).text).toContain('(none)'));

  it('labels each picture with its shot, its viewport and its section', () =>
    expect(directorRequest({ site: siteShop(), images }).images).toEqual([
      { label: 'Screenshot s1-mobile (phone, section s1):', jpegBase64: '/9j/AAAA' },
      { label: 'Screenshot s4-mobile (phone, section s4):', jpegBase64: '/9j/BBBB' },
    ]));
});

describe('PATCH_SYSTEM', () => {
  it('says how to fix every rule a problem can break', () => {
    for (const rule of RULES) expect(PATCH_SYSTEM).toContain(`- ${rule}:`);
  });

  it('asks only for the scenes it changes and the claims it corrects', () => {
    for (const field of ['`patches`', '`claimFixes`']) expect(PATCH_SYSTEM).toContain(field);
  });

  it('holds the corrector to the director rules: banned phrases and pieces included', () => {
    for (const p of [...BANNED_PHRASES.es, ...BANNED_PHRASES.en]) expect(PATCH_SYSTEM).toContain(p);
    for (const s of ['TypeIn', 'WordCycle', 'atBeat']) expect(PATCH_SYSTEM).toContain(s);
  });
});

describe('patchPrompt', () => {
  it('sends the edit list, each problem where it is and the site text', () => {
    const problem: Problem = { where: 'body[1].lines[0]', rule: 'number-mismatch', detail: '"99" is not in the quote of c3' };
    const text = patchPrompt({ edl: edlShop(), problems: [problem], site: siteShop() });
    expect(text).toContain(JSON.stringify(edlShop(), null, 1));
    expect(text).toContain('- [number-mismatch] body[1].lines[0]: "99" is not in the quote of c3');
    expect(text).toContain(JSON.stringify(siteForModel(siteShop()), null, 1));
  });
});

describe('JUDGE_SYSTEM', () => {
  it('asks whether each framing line asserts a fact about the product', () =>
    expect(JUDGE_SYSTEM).toContain('does this framing line assert a fact about the product?'));

  it('judges a claim only against its quote', () => expect(JUDGE_SYSTEM).toContain('Judge only against the quote'));

  it('sends both lists of items', () => {
    const items = judgeItems(edlShop());
    expect(judgePrompt(items)).toContain(JSON.stringify(items, null, 1));
  });
});

describe('CLASSIFY_SYSTEM', () => {
  it('refuses scams, illegal and adult content and admits the rest', () => {
    for (const s of ['scam', 'illegal', 'adult', 'when in doubt, admit it']) expect(CLASSIFY_SYSTEM).toContain(s);
  });

  it('keeps models and protocols out of the reason a person reads', () => expect(CLASSIFY_SYSTEM).toContain('never mention models'));

  it('treats the page as data', () => expect(CLASSIFY_SYSTEM).toContain('not instructions'));

  it('sends the address, the title and the text', () => {
    const text = classifyPrompt({ url: 'https://tiendita.example/', title: 'Tiendita', text: 'Vendé por WhatsApp' });
    for (const part of ['https://tiendita.example/', 'Tiendita', 'Vendé por WhatsApp']) expect(text).toContain(part);
  });
});
