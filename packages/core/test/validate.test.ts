import { describe, expect, it } from 'vitest';
import {
  BANNED_PHRASES,
  EdlSchema,
  FPS,
  applyPatches,
  judgeItems,
  layoutScenes,
  scenePaths,
  validateEdl,
  type Claim,
  type Edl,
  type Line,
  type Scene,
  type SiteData,
} from '../src/index';
import edlShopJson from './fixtures/edl-shop.json';
import siteShopJson from './fixtures/site-shop.json';

const edlShop = EdlSchema.parse(edlShopJson);
const siteShop = siteShopJson as SiteData;

const get = <T>(items: readonly T[], index: number): T => {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at ${index}`);
  return item;
};

// A scenario is an edit list together with the site it is checked against.
type Case = { edl: Edl; site: SiteData };
const shop = (edl: Edl = edlShop, site: SiteData = siteShop): Case => ({ edl, site });
const problemsOf = ({ edl, site }: Case) => validateEdl(edl, site);
const rules = (c: Case) => problemsOf(c).map((p) => p.rule);

const framing = (text: string, extra: Partial<Line> = {}): Line => ({ text, kind: 'framing', ...extra });
const claimLine = (text: string, claimId: string, extra: Partial<Line> = {}): Line => ({ text, kind: 'claim', claimId, ...extra });
const headline = (lines: Line[], beats = 5): Scene => ({ piece: 'KineticHeadline', beats, lines });
const withBody = (index: number, scene: Scene): Edl => ({ ...edlShop, body: edlShop.body.map((s, i) => (i === index ? scene : s)) });

// body[1] becomes a headline with this one framing line.
const withFraming = (text: string): Case => shop(withBody(1, headline([framing(text)])));
// body[1] becomes a headline with this one claim line, backed by a claim whose quote the site really contains.
const withLine = (text: string, quote: string): Case => {
  const site: SiteData = { ...siteShop, sections: siteShop.sections.map((s) => (s.id === 's2' ? { ...s, text: `${s.text}\n${quote}` } : s)) };
  const claim: Claim = { id: 'cx', text: 'x', sectionId: 's2', quote };
  return shop({ ...withBody(1, headline([claimLine(text, 'cx')])), claims: [...edlShop.claims, claim] }, site);
};
const withQuote = (id: string, quote: string): Case =>
  shop({ ...edlShop, claims: edlShop.claims.map((c) => (c.id === id ? { ...c, quote } : c)) });

// A single scene in body[0]; the shop video stays within 15-30 s for 1 to 9 beats there.
const inBody = (scene: Scene, site: SiteData = siteShop): Case => shop(withBody(0, scene), site);
const uiFocus = (extra: Partial<Scene> = {}): Scene => ({
  piece: 'UiFocus',
  beats: 4,
  shotId: 's1-mobile',
  boxIndex: 0,
  lines: [claimLine('Tu tienda, lista en minutos.', 'c2')],
  ...extra,
});
const wordCycle = (words: string[], prefix: Line = framing('Pagá con')): Case =>
  inBody({ piece: 'WordCycle', beats: 6, lines: [prefix, ...words.map((w) => claimLine(w, 'c5'))] });
const typeIn = (lines: Line[], variant?: 'url' | 'prompt', site: SiteData = siteShop): Case =>
  inBody({ piece: 'TypeIn', beats: 4, variant, lines }, site);
const atBeat = (value: number, beats: number): Case =>
  inBody(uiFocus({ beats, lines: [claimLine('Tu tienda, lista en minutos.', 'c2'), claimLine('Sin comisiones.', 'c1', { atBeat: value })] }));

// A video of exactly `total` beats (4 in the hook, 6 in the cta, the rest in filler body scenes of 2 to 8 beats).
const ofBeats = (total: number, bpm: number): Case => {
  const rest = total - 10;
  const sizes = [...Array.from({ length: Math.floor(rest / 8) }, () => 8), ...(rest % 8 ? [rest % 8] : [])];
  return shop({
    ...edlShop,
    bpm,
    hooks: [[headline([framing('Hola')], 4)]],
    body: sizes.map((beats) => headline([framing('Hola')], beats)),
  });
};

describe('validateEdl: the shop fixture', () => {
  it('is clean', () => expect(validateEdl(edlShop, siteShop)).toEqual([]));
});

describe('validateEdl: quotes', () => {
  it('flags a quote that is not verbatim in its section', () => expect(rules(withQuote('c1', 'texto inventado'))).toEqual(['quote-missing']));

  it('flags a claim whose section does not exist', () => {
    const c = shop({ ...edlShop, claims: edlShop.claims.map((x) => (x.id === 'c1' ? { ...x, sectionId: 's99' } : x)) });
    expect(rules(c)).toEqual(['quote-missing']);
  });

  it('flags an empty quote, which would otherwise be found in every section', () => expect(rules(withQuote('c1', '  '))).toEqual(['quote-missing']));

  it('ignores case, spacing, non-breaking spaces and typographic quotes when comparing', () => {
    const site: SiteData = { ...siteShop, sections: siteShop.sections.map((s) => (s.id === 's1' ? { ...s, text: `${s.text}\nDijo “hola” y l’app andaba` } : s)) };
    expect(rules(shop(withQuote('c1', 'VENDÉ  por WHATSAPP   sin comisiones').edl, site))).toEqual([]);
    expect(rules(shop(withQuote('c1', 'Dijo "hola" y l\'app andaba').edl, site))).toEqual([]);
  });

  it('finds a quote that spans the heading and the text of a section', () =>
    expect(rules(withQuote('c1', 'Vendé por WhatsApp sin comisiones Armá tu tienda en minutos'))).toEqual([]));

  it('does not tolerate a changed word or accent', () => expect(rules(withQuote('c1', 'Vende por WhatsApp sin comisiones'))).toEqual(['quote-missing']));

  it('flags a claim line without an existing claimId', () => {
    const c = shop(withBody(1, headline([claimLine('0% de comisión.', 'c99'), { text: 'Sin id', kind: 'claim' }])));
    expect(rules(c)).toEqual(['quote-missing', 'quote-missing']);
  });
});

describe('validateEdl: numbers', () => {
  it('flags "3 %" against a quote with "2,9 %"', () => expect(rules(withLine('3 %', 'Comisión de 2,9 %'))).toEqual(['number-mismatch']));
  it('accepts "0 %" against "0%"', () => expect(rules(withLine('0 %', 'Comisión de 0%'))).toEqual([]));
  it('accepts "2,9%" against "2,9 %"', () => expect(rules(withLine('Solo 2,9%', 'Comisión de 2,9 %'))).toEqual([]));
  it('flags a number that is not in the quote at all', () => expect(rules(withLine('Desde $5.990', 'Plan Pro a $4.990 por mes'))).toEqual(['number-mismatch']));
  it('accepts a number that is in the quote', () => expect(rules(withLine('Desde $4.990', 'Plan Pro a $4.990 por mes'))).toEqual([]));
  it('flags numbers in a framing line', () => expect(rules(withFraming('El 90 % de las tiendas'))).toEqual(['framing-has-data']));
  it('accepts a framing line without numbers', () => expect(rules(withFraming('¿Cuánto te cobran por vender?'))).toEqual([]));
});

describe('validateEdl: banned phrases', () => {
  it('flags banned phrases with or without accents', () => {
    expect(rules(withFraming('Llevá tu negocio al siguiente nivel'))).toContain('banned-phrase');
    expect(rules(withFraming('Lleva tu negocio al siguiente nivel'))).toContain('banned-phrase');
    expect(rules(withFraming('posibilidades infinitas'))).toContain('banned-phrase');
    expect(rules(withFraming('Posibilidades infinitás'))).toContain('banned-phrase');
  });

  it('ignores case and typographic apostrophes', () => {
    expect(rules(withFraming('LET’S MAKE IT HAPPEN'))).toEqual(['banned-phrase']);
    expect(rules(withFraming("Let's make it happen"))).toEqual(['banned-phrase']);
  });

  it.each([...BANNED_PHRASES.es, ...BANNED_PHRASES.en])('flags "%s"', (phrase) =>
    expect(new Set(rules(withFraming(`Con ${phrase} hoy`)))).toEqual(new Set(['banned-phrase'])),
  );

  it('flags a banned phrase in a claim line too', () => {
    const c = shop(withBody(1, headline([claimLine('0% de comisión, increíble', 'c3')])));
    expect(rules(c)).toEqual(['banned-phrase']);
  });

  it('carries the phrases found in the video examples', () => {
    expect(BANNED_PHRASES.en).toEqual(
      expect.arrayContaining(["let's make it happen", 'endless possibilities', 'ready to launch', 'boost your sales', 'show what matters']),
    );
    expect(BANNED_PHRASES.es).toEqual(
      expect.arrayContaining(['hagámoslo realidad', 'posibilidades infinitas', 'listo para lanzar', 'mostrá lo que importa']),
    );
  });

  it('reports one problem per line, however many phrases or spellings match', () => {
    const problems = problemsOf(withFraming('Llevá tu marca al siguiente nivel y revolucionario'));
    expect(problems.map((p) => [p.where, p.rule])).toEqual([['body[1].lines[0]', 'banned-phrase']]);
    for (const phrase of ['llevá tu', 'al siguiente nivel', 'revolucionario']) expect(problems[0]?.detail).toContain(phrase);
  });

  it('uses the list it is given instead of the default one', () => {
    const { edl } = withFraming('Llevá tu marca al siguiente nivel');
    expect(validateEdl(edl, siteShop).map((p) => p.rule)).toEqual(['banned-phrase']);
    expect(validateEdl(edl, siteShop, { es: [], en: [] })).toEqual([]);
    expect(validateEdl(edlShop, siteShop, { es: ['tienda'], en: [] }).map((p) => p.rule)).toContain('banned-phrase');
  });
});

describe('validateEdl: structure', () => {
  const clean = (c: Case) => expect(rules(c)).toEqual([]);
  const structure = (c: Case) => expect(rules(c)).toEqual(['structure']);

  it('requires an accent to be a substring of its line', () => {
    structure(shop(withBody(1, headline([claimLine('0% de comisión.', 'c3', { accent: '1%' })]))));
    clean(shop(withBody(1, headline([claimLine('0% de comisión.', 'c3', { accent: '0%' })]))));
  });

  it('requires 1 to 3 hooks', () => {
    structure(shop({ ...edlShop, hooks: [] }));
    structure(shop({ ...edlShop, hooks: [...edlShop.hooks, get(edlShop.hooks, 0)] }));
    clean(shop({ ...edlShop, hooks: [get(edlShop.hooks, 0)] }));
    clean(shop({ ...edlShop, hooks: edlShop.hooks.slice(0, 2) }));
  });

  it('requires the cta to be an EndCard with 1 or 2 lines', () => {
    structure(shop({ ...edlShop, cta: { ...edlShop.cta, piece: 'KineticHeadline' } }));
    structure(shop({ ...edlShop, cta: { ...edlShop.cta, lines: [] } }));
    structure(shop({ ...edlShop, cta: { ...edlShop.cta, lines: [framing('Uno'), framing('Dos'), framing('Tres')] } }));
    clean(shop({ ...edlShop, cta: { ...edlShop.cta, lines: [get(edlShop.cta.lines, 0), framing('Sin letra chica')] } }));
  });

  it.each([89, 129, 0, Number.NaN])('rejects %s bpm', (bpm) => structure(shop({ ...edlShop, bpm })));
  it.each([90, 100.5, 128])('accepts %s bpm', (bpm) => clean(shop({ ...edlShop, bpm })));

  it.each([1, 9])('rejects a scene of %s beats', (beats) => structure(shop(withBody(0, { ...get(edlShop.body, 0), beats }))));
  it.each([2, 8])('accepts a scene of %s beats', (beats) => clean(shop(withBody(0, { ...get(edlShop.body, 0), beats }))));

  describe('UiFocus and UiScroll', () => {
    it('requires UiFocus to have a boxIndex', () => structure(inBody(uiFocus({ boxIndex: undefined }))));
    it('accepts UiScroll without a boxIndex', () => clean(inBody({ piece: 'UiScroll', beats: 4, shotId: 's1-mobile', lines: [framing('Mirá')] })));
    it('requires a shotId that exists', () => {
      structure(inBody(uiFocus({ shotId: 's9-desktop' })));
      structure(inBody(uiFocus({ shotId: undefined })));
    });
    it('requires a boxIndex that exists in that shot', () => {
      structure(inBody(uiFocus({ boxIndex: 3 })));
      structure(inBody(uiFocus({ boxIndex: -1 })));
      structure(inBody({ piece: 'UiScroll', beats: 4, shotId: 's1-mobile', boxIndex: 3, lines: [framing('Mirá')] }));
      clean(inBody(uiFocus({ boxIndex: 2 })));
    });
  });

  describe('ClaimStack', () => {
    const means = ['Mercado Pago', 'Transferencia', 'Efectivo', 'Débito'];
    const stack = (n: number): Case => inBody({ piece: 'ClaimStack', beats: 6, lines: means.slice(0, n).map((m) => claimLine(m, 'c5')) });
    it.each([1, 4])('rejects %s lines', (n) => structure(stack(n)));
    it.each([2, 3])('accepts %s lines', (n) => clean(stack(n)));
  });

  describe('WordCycle', () => {
    it('requires WordCycle to have a framing prefix plus 2 to 5 words', () => {
      structure(wordCycle(['MP']));
      structure(wordCycle(['MP', 'Transferencia', 'Efectivo', 'Débito', 'Crédito', 'Cheque']));
      structure(wordCycle(['MP', 'Transferencia'], claimLine('Pagá con', 'c5')));
      clean(wordCycle(['MP', 'Transferencia']));
      clean(wordCycle(['MP', 'Transferencia', 'Efectivo', 'Débito', 'Crédito']));
    });
    it('flags a WordCycle without lines', () => expect(rules(inBody({ piece: 'WordCycle', beats: 6, lines: [] }))).toEqual(['structure', 'structure']));
  });

  describe('TypeIn', () => {
    it('requires exactly one line and a variant', () => {
      structure(typeIn([], 'prompt'));
      structure(typeIn([framing('¿Cuánto cobrás?'), framing('¿Y la comisión?')], 'prompt'));
      structure(typeIn([framing('¿Cuánto cobrás?')], undefined));
      clean(typeIn([framing('¿Cuánto cobrás por venta?')], 'prompt'));
    });

    it('requires a TypeIn url to be the site host', () => {
      structure(typeIn([framing('otro.com')], 'url'));
      clean(typeIn([framing('tiendita.example')], 'url'));
    });

    it('ignores www, the path and the case of the site address', () => {
      const site = { ...siteShop, url: 'https://www.Tiendita.example/precios?x=1' };
      clean(typeIn([framing('tiendita.example')], 'url', site));
      structure(typeIn([framing('www.tiendita.example')], 'url', site));
    });

    it('requires the url line to be framing, not a claim', () => structure(typeIn([claimLine('tiendita.example', 'c1')], 'url')));

    it('flags a url that cannot be compared when the site address is not valid', () =>
      structure(typeIn([framing('tiendita.example')], 'url', { ...siteShop, url: 'not a url' })));
  });

  describe('atBeat', () => {
    it('requires atBeat between 1 and beats-1, only on UiFocus/UiScroll', () => {
      structure(atBeat(4, 4));
      structure(atBeat(0, 4));
      clean(atBeat(1, 4));
      clean(atBeat(3, 4));
    });

    it('allows atBeat on the second line of a UiScroll', () =>
      clean(inBody({ piece: 'UiScroll', beats: 4, shotId: 's1-mobile', lines: [framing('Mirá'), framing('Y seguí', { atBeat: 2 })] })));

    it('rejects atBeat on any line but the second', () => {
      structure(inBody(uiFocus({ lines: [claimLine('Tu tienda, lista en minutos.', 'c2', { atBeat: 2 })] })));
      structure(inBody(uiFocus({ lines: [framing('Uno'), framing('Dos'), framing('Tres', { atBeat: 2 })] })));
    });

    it('rejects atBeat on other pieces', () => structure(inBody(headline([framing('Uno'), framing('Dos', { atBeat: 2 })], 4))));
  });

  describe('length of the main video', () => {
    it('requires hook 0 to last 15-30 s', () => {
      // 2 scenes of 2 beats and a cta of 2 beats at 128 bpm: 6 beats in all, 2.8 s.
      structure(shop({ ...edlShop, bpm: 128, hooks: [[headline([framing('Uno')], 2), headline([framing('Dos')], 2)]], body: [], cta: { ...edlShop.cta, beats: 2 } }));
    });

    it.each([
      [30, 120, true],
      [29, 120, false],
      [60, 120, true],
      [61, 120, false],
    ])('measures a video of %s beats at %s bpm: ok is %s', (beats, bpm, ok) => {
      const c = ofBeats(beats, bpm);
      const seconds = layoutScenes(c.edl, 0).total / FPS;
      expect(seconds).toBe(beats / 2);
      expect(rules(c)).toEqual(ok ? [] : ['structure']);
    });

    it('counts the body and the cta, not just the hook', () => {
      const { scenes, total } = layoutScenes(edlShop, 0);
      expect(get(scenes, 0).duration / FPS).toBeLessThan(15);
      expect(total / FPS).toBeGreaterThanOrEqual(15);
      expect(rules(shop())).toEqual([]);
    });

    it('does not measure a video whose tempo makes no sense', () => structure(shop({ ...edlShop, bpm: 0 })));
  });
});

describe('validateEdl: where', () => {
  const where = (c: Case) => problemsOf(c).map((p) => p.where);

  it('puts the scene path first and the line after it', () => {
    expect(where(withLine('3 %', 'Comisión de 2,9 %'))).toEqual(['body[1].lines[0]']);
    expect(where(shop(withBody(1, headline([framing('Uno'), framing('El 90 %')]))))).toEqual(['body[1].lines[1]']);
  });

  it('names hook scenes and the cta', () => {
    const hooks = edlShop.hooks.map((h, i) => (i === 2 ? h.map((s, j) => (j === 1 ? headline([framing('Llevá tu marca')], s.beats) : s)) : h));
    expect(where(shop({ ...edlShop, hooks }))).toEqual(['hooks[2][1].lines[0]']);
    expect(where(shop({ ...edlShop, cta: { ...edlShop.cta, lines: [framing('Pasá al siguiente nivel')] } }))).toEqual(['cta.lines[0]']);
    expect(where(shop({ ...edlShop, cta: { ...edlShop.cta, beats: 9 } }))).toEqual(['cta']);
  });

  it('never leaks the line text into the path', () => {
    const c = shop(withBody(1, headline([framing('Sin comisiones. 100 % libre.')])));
    expect(problemsOf(c).map((p) => p.where.split('.')[0])).toEqual(['body[1]']);
  });

  it('uses "edl" for problems that are not about one scene', () => {
    expect(where(shop({ ...edlShop, hooks: [] }))).toEqual(['edl']);
    expect(where(shop({ ...edlShop, bpm: 140 }))).toEqual(['edl']);
    expect(where(ofBeats(61, 120))).toEqual(['edl']);
    expect(problemsOf(withQuote('c1', 'texto inventado')).map((p) => [p.where, p.detail.includes('c1')])).toEqual([['edl', true]]);
  });
});

describe('judgeItems', () => {
  it('builds framing items for the judge', () =>
    expect(judgeItems(edlShop).framing.map((f) => f.text)).toContain(get(get(edlShop.hooks, 0), 0).lines[0]?.text));

  it('identifies a framing item by scene path and line index', () => {
    const { framing: items } = judgeItems(edlShop);
    expect(items.filter((f) => f.id.startsWith('hooks[0][0]'))).toEqual([
      { id: 'hooks[0][0]:framing:0', text: '¿Cuánto te cobran' },
      { id: 'hooks[0][0]:framing:1', text: 'por cada venta?' },
    ]);
  });

  it('counts the line index inside the scene even when claim lines come first', () => {
    const edl = withBody(0, headline([claimLine('0% de comisión.', 'c3'), framing('¿Te animás?')]));
    expect(judgeItems(edl).framing).toContainEqual({ id: 'body[0]:framing:1', text: '¿Te animás?' });
  });

  it('joins the lines of a scene that state the same claim into one item', () => {
    const { claims } = judgeItems(edlShop);
    expect(claims).toContainEqual({ id: 'hooks[1][0]:c1', onScreen: 'Vendé por WhatsApp sin comisiones.', quote: 'Vendé por WhatsApp sin comisiones' });
    expect(claims).toContainEqual({ id: 'body[3]:c4', onScreen: 'Plan Pro $4.990 por mes.', quote: 'Plan Pro a $4.990 por mes' });
  });

  it('makes one item per claim in a scene and one per scene for a repeated claim', () => {
    const edl = withBody(0, headline([claimLine('Sin comisiones.', 'c1'), claimLine('Plan Pro', 'c4'), claimLine('Gratis', 'c1')]));
    const ids = judgeItems(edl).claims.filter((i) => i.id.startsWith('body[0]')).map((i) => i.id);
    expect(ids).toEqual(['body[0]:c1', 'body[0]:c4']);
    expect(judgeItems(edl).claims.find((i) => i.id === 'body[0]:c1')?.onScreen).toBe('Sin comisiones. Gratis');
    expect(judgeItems(edlShop).claims.filter((i) => i.id.endsWith(':c1')).map((i) => i.id)).toEqual(['hooks[1][0]:c1', 'hooks[2][1]:c1']);
  });

  it('leaves out claim lines whose claim does not exist, since the code validation reports them', () => {
    const edl = withBody(0, headline([claimLine('Algo', 'c99')]));
    expect(judgeItems(edl).claims.some((i) => i.id.startsWith('body[0]'))).toBe(false);
  });

  it('has no framing items in a video made only of claims', () => {
    const edl: Edl = { ...edlShop, hooks: [get(edlShop.hooks, 1)], body: [], cta: { ...edlShop.cta, lines: [claimLine('Crear mi tienda', 'c7')] } };
    expect(judgeItems(edl).framing).toEqual([]);
  });
});

describe('scenePaths', () => {
  it('lists every hook scene, the body and the cta in playing order', () => {
    expect(scenePaths(edlShop).map((p) => p.path)).toEqual([
      'hooks[0][0]',
      'hooks[1][0]',
      'hooks[2][0]',
      'hooks[2][1]',
      'body[0]',
      'body[1]',
      'body[2]',
      'body[3]',
      'cta',
    ]);
  });

  it('returns the scenes themselves', () => {
    const byPath = new Map(scenePaths(edlShop).map((p) => [p.path, p.scene]));
    expect(byPath.get('hooks[2][1]')).toBe(get(get(edlShop.hooks, 2), 1));
    expect(byPath.get('body[2]')).toBe(get(edlShop.body, 2));
    expect(byPath.get('cta')).toBe(edlShop.cta);
  });
});

describe('applyPatches', () => {
  const newScene = headline([framing('Una escena nueva')], 4);

  it('applies a patch to one scene only and upserts claims by id', () => {
    const out = applyPatches(edlShop, [{ path: 'body[1]', scene: newScene }], [{ ...get(edlShop.claims, 0), quote: 'otra' }]);
    expect(out.body[1]).toEqual(newScene);
    expect(out.body[0]).toEqual(edlShop.body[0]);
    expect(out.claims.find((c) => c.id === get(edlShop.claims, 0).id)?.quote).toBe('otra');
  });

  it('changes nothing else', () => {
    const out = applyPatches(edlShop, [{ path: 'body[1]', scene: newScene }], []);
    expect(out).toEqual({ ...edlShop, body: edlShop.body.map((s, i) => (i === 1 ? newScene : s)) });
  });

  it('patches hook scenes and the cta by path', () => {
    const out = applyPatches(
      edlShop,
      [
        { path: 'hooks[2][1]', scene: newScene },
        { path: 'cta', scene: { ...edlShop.cta, beats: 8 } },
      ],
      [],
    );
    expect(get(get(out.hooks, 2), 1)).toEqual(newScene);
    expect(get(get(out.hooks, 2), 0)).toEqual(get(get(edlShop.hooks, 2), 0));
    expect(out.cta.beats).toBe(8);
    expect(out.hooks.slice(0, 2)).toEqual(edlShop.hooks.slice(0, 2));
  });

  it('keeps the position of a fixed claim and adds a claim with a new id at the end', () => {
    const added: Claim = { id: 'c8', text: 'x', sectionId: 's2', quote: '0% de comisión' };
    const out = applyPatches(edlShop, [], [{ ...get(edlShop.claims, 2), quote: 'otra' }, added]);
    expect(out.claims.map((c) => c.id)).toEqual([...edlShop.claims.map((c) => c.id), 'c8']);
    expect(out.claims[2]?.quote).toBe('otra');
  });

  it('returns an equal edit list when there is nothing to apply', () => expect(applyPatches(edlShop, [], [])).toEqual(edlShop));

  it('does not modify the edit list it is given', () => {
    const before = structuredClone(edlShop);
    applyPatches(edlShop, [{ path: 'hooks[0][0]', scene: newScene }, { path: 'body[0]', scene: newScene }], [{ ...get(edlShop.claims, 0), quote: 'otra' }]);
    expect(edlShop).toEqual(before);
  });

  it('lets the last patch for a path win', () => {
    const other = headline([framing('Otra más')], 3);
    const out = applyPatches(edlShop, [{ path: 'body[0]', scene: newScene }, { path: 'body[0]', scene: other }], []);
    expect(out.body[0]).toEqual(other);
  });

  it.each(['body[9]', 'hooks[0][5]', 'hooks[7][0]', 'cta[0]', 'body', 'body[-1]', 'scene 2', ''])('rejects the path "%s"', (path) =>
    expect(() => applyPatches(edlShop, [{ path, scene: newScene }], [])).toThrow(RangeError),
  );

  it('lets the validation pass once a bad scene is patched', () => {
    const bad = withLine('3 %', 'Comisión de 2,9 %');
    expect(rules(bad)).toEqual(['number-mismatch']);
    const fixed = applyPatches(bad.edl, [{ path: 'body[1]', scene: headline([claimLine('2,9 %', 'cx')]) }], []);
    expect(rules(shop(fixed, bad.site))).toEqual([]);
    expect(EdlSchema.parse(fixed)).toEqual(fixed);
  });

  it('lets the validation pass once a bad claim is fixed', () => {
    const bad = withQuote('c1', 'texto inventado');
    expect(rules(bad)).toEqual(['quote-missing']);
    expect(rules(shop(applyPatches(bad.edl, [], [get(edlShop.claims, 0)])))).toEqual([]);
  });
});
