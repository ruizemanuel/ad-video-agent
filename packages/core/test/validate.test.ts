import { describe, expect, it } from 'vitest';
import {
  BANNED_PHRASES,
  EdlSchema,
  FPS,
  applyPatches,
  judgeItems,
  layoutScenes,
  scenePaths,
  siteHost,
  timedScenePath,
  validateEdl,
  type Block,
  type Box,
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
  beats: 5,
  shotId: 's1-mobile',
  boxIndex: 0,
  lines: [claimLine('Tu tienda, lista en minutos.', 'c2')],
  ...extra,
});
// In body[1], which a cut follows: the wipe after body[0] would take the end of its last word (see the reading tests).
const wordCycle = (words: string[], prefix: Line = framing('Pagá con'), beats = 6): Case =>
  shop(withBody(1, { piece: 'WordCycle', beats, lines: [prefix, ...words.map((w) => claimLine(w, 'c5'))] }));
// 8 beats: what it types, up to 26 characters, is then read before the wipe into body[1] (see the reading tests).
const typeIn = (lines: Line[], variant?: 'url' | 'prompt', site: SiteData = siteShop): Case =>
  inBody({ piece: 'TypeIn', beats: 8, variant, lines }, site);
const atBeat = (value: number, beats: number): Case =>
  inBody(uiFocus({ beats, lines: [claimLine('Tu tienda, lista en minutos.', 'c2'), claimLine('Sin comisiones.', 'c1', { atBeat: value })] }));
// The problems that are not about how long a text stays on screen.
const notReading = (c: Case) => problemsOf(c).filter((p) => !p.detail.includes(' is readable '));

// A video of exactly `total` beats (4 in the hook, 6 in the cta, the rest in filler body scenes of 3 to 8 beats, each long
// enough for its word to be read).
const ofBeats = (total: number, bpm: number): Case => {
  const rest = total - 10;
  const count = Math.ceil(rest / 8);
  const sizes = Array.from({ length: count }, (_, i) => Math.floor(rest / count) + (i < rest % count ? 1 : 0));
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
    // 50 characters: the scene is long enough for them to be read.
    const problems = problemsOf(shop(withBody(1, headline([framing('Llevá tu marca al siguiente nivel y revolucionario')], 8))));
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

  it('requires the EndCard to last 4 beats or more, so that its two steps have room', () => {
    structure(shop({ ...edlShop, cta: { ...edlShop.cta, beats: 3 } }));
    clean(shop({ ...edlShop, cta: { ...edlShop.cta, beats: 4 } }));
    expect(problemsOf(shop({ ...edlShop, cta: { ...edlShop.cta, beats: 3 } })).map((p) => p.where)).toEqual(['cta']);
  });

  it('requires the cta to be an EndCard with 1 or 2 lines', () => {
    structure(shop({ ...edlShop, cta: { ...edlShop.cta, piece: 'KineticHeadline' } }));
    structure(shop({ ...edlShop, cta: { ...edlShop.cta, lines: [] } }));
    structure(shop({ ...edlShop, cta: { ...edlShop.cta, lines: [framing('Uno'), framing('Dos'), framing('Tres')] } }));
    clean(shop({ ...edlShop, cta: { ...edlShop.cta, lines: [get(edlShop.cta.lines, 0), framing('Sin letra chica')] } }));
  });

  it.each([89, 129, 0, Number.NaN])('rejects %s bpm', (bpm) => structure(shop({ ...edlShop, bpm })));
  it.each([90, 100.5, 128])('accepts %s bpm', (bpm) => clean(shop({ ...edlShop, bpm })));

  // The range of a scene's length. Whether its text is read in that length is the reading rule's (no text is, in 2 beats at
  // 112 bpm: see the reading tests).
  const outOfRange = (beats: number) =>
    problemsOf(shop(withBody(0, { ...get(edlShop.body, 0), beats }))).filter((p) => p.detail === `${beats} beats (expected 2-8)`);
  it.each([1, 9])('rejects a scene of %s beats', (beats) => expect(outOfRange(beats)).toEqual([{ where: 'body[0]', rule: 'structure', detail: `${beats} beats (expected 2-8)` }]));
  it.each([2, 8])('accepts a scene of %s beats', (beats) => expect(outOfRange(beats)).toEqual([]));

  describe('UiFocus and UiScroll', () => {
    it('requires UiFocus to have a boxIndex', () => structure(inBody(uiFocus({ boxIndex: undefined }))));
    it('requires UiScroll to have a boxIndex', () => structure(inBody({ piece: 'UiScroll', beats: 4, shotId: 's1-mobile', lines: [framing('Mirá')] })));
    it('accepts a UiScroll aimed at product UI', () => clean(inBody({ piece: 'UiScroll', beats: 4, shotId: 's1-mobile', boxIndex: 2, lines: [framing('Mirá')] })));
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

  describe('UiFocus and UiScroll film product UI', () => {
    const SHOT = 'm-s7';
    const heading: Box = { shotId: SHOT, sectionId: 's3', kind: 'heading', text: 'Cobrás como querés', x: 80, y: 300, w: 600, h: 100 };
    const picture: Box = { shotId: SHOT, sectionId: 's2', kind: 'image', x: 80, y: 700, w: 600, h: 400 };
    // The shop, plus a phone shot of a section with these boxes and these blocks.
    const withShot = (boxes: Box[], blocks?: Block[]): SiteData => ({
      ...siteShop,
      shots: [...siteShop.shots, { id: SHOT, file: 'media/m-s7.png', viewport: 'mobile', dpr: 2, sectionId: 's3', width: 780, height: 1688 }],
      boxes: [...siteShop.boxes, ...boxes],
      ...(blocks ? { blocks } : {}),
    });
    const focus = (site: SiteData, boxIndex = 0): Case => inBody(uiFocus({ shotId: SHOT, boxIndex }), site);
    const scroll = (site: SiteData, boxIndex = 0): Case =>
      inBody({ piece: 'UiScroll', beats: 4, shotId: SHOT, boxIndex, lines: [framing('Mirá')] }, site);
    const detail = (c: Case): string[] => problemsOf(c).map((p) => p.detail);
    const marketing =
      'UiFocus must film product UI: box 0 ("Cobrás como querés") of m-s7 has no image or price in its section or card; state this claim in a type scene or aim at product UI';

    it('reports a heading whose section has only text, with what the corrector can do about it', () => {
      structure(focus(withShot([heading])));
      expect(detail(focus(withShot([heading])))).toEqual([marketing]);
      expect(problemsOf(focus(withShot([heading])))).toEqual([{ where: 'body[0]', rule: 'structure', detail: marketing }]);
    });

    it('accepts the same heading when its section has a price', () =>
      clean(focus(withShot([heading, { shotId: SHOT, sectionId: 's3', kind: 'price', text: '$4.990', x: 80, y: 500, w: 300, h: 80 }]))));

    it('reports a feature card whose only "price" is a percentage: the capture calls "0% de comisión" a price', () => {
      const stat: Box = { shotId: SHOT, sectionId: 's3', kind: 'price', text: '0% de comisión', x: 80, y: 300, w: 600, h: 100 };
      structure(focus(withShot([{ ...heading, text: '0% de comisión' }, stat])));
      structure(scroll(withShot([stat])));
      clean(focus(withShot([{ ...heading, text: '0% de comisión' }, stat, { ...stat, text: 'US$ 10', y: 500 }])));
    });

    it('accepts the same heading when its section has an image', () => clean(focus(withShot([heading, { ...picture, sectionId: 's3' }]))));

    it('accepts a heading inside a block that also holds an image, whatever the sections', () =>
      clean(focus(withShot([heading, picture], [{ shotId: SHOT, x: 40, y: 250, w: 700, h: 1000 }]))));

    it('reports a heading whose block holds no image, the image being in a block of its own', () =>
      structure(focus(withShot([heading, picture], [{ shotId: SHOT, x: 40, y: 250, w: 700, h: 200 }, { shotId: SHOT, x: 40, y: 650, w: 700, h: 500 }]))));

    it('reports a heading whose section has only a cta: a button over text is marketing', () =>
      structure(focus(withShot([heading, { shotId: SHOT, sectionId: 's3', kind: 'cta', text: 'Crear mi tienda', x: 80, y: 500, w: 300, h: 100 }]))));

    it('lets the section alone decide when the capture has no blocks', () => {
      structure(focus(withShot([heading, picture])));
      clean(focus(withShot([heading, { ...picture, sectionId: 's3' }])));
    });

    it('reports a UiScroll that lands on a text card, naming the piece', () => {
      structure(scroll(withShot([heading])));
      expect(detail(scroll(withShot([heading])))).toEqual([marketing.replace('UiFocus', 'UiScroll')]);
    });

    it('accepts a UiScroll that lands on product UI', () => clean(scroll(withShot([heading, picture]), 1)));

    it('names the kind of a box that has no text', () => {
      const cta: Box = { shotId: SHOT, sectionId: 's3', kind: 'cta', x: 80, y: 500, w: 300, h: 100 };
      expect(detail(focus(withShot([cta])))).toEqual([expect.stringContaining('box 0 (cta) of m-s7')]);
    });

    it('reports a box out of range once, not also as marketing', () => {
      expect(detail(focus(withShot([heading]), 5))).toEqual(['boxIndex 5 out of range for m-s7']);
      expect(detail(scroll(withShot([heading]), 5))).toEqual(['boxIndex 5 out of range for m-s7']);
    });

    it('reports an unknown shot and a missing boxIndex without looking for product UI', () => {
      expect(detail(inBody(uiFocus({ shotId: 's9-mobile', boxIndex: 0 })))).toEqual(['UiFocus with unknown shotId s9-mobile']);
      expect(detail(inBody(uiFocus({ boxIndex: undefined })))).toEqual(['UiFocus needs a boxIndex']);
      expect(detail(inBody({ piece: 'UiScroll', beats: 4, shotId: 's1-mobile', lines: [framing('Mirá')] }))).toEqual(['UiScroll needs a boxIndex']);
    });

    it('keeps the order of the checks: the shot, the range of the box, the boxIndex, the product', () => {
      const unknown = inBody({ piece: 'UiScroll', beats: 4, shotId: 's9-mobile', lines: [framing('Mirá')] });
      expect(detail(unknown)).toEqual(['UiScroll with unknown shotId s9-mobile', 'UiScroll needs a boxIndex']);
    });
  });

  describe('UiFocus and UiScroll frame their target cleanly in 9x16', () => {
    // The demo store of paid run 5: a phone page of 3072 px whose last cards sit in the bottom of the page, which never gets
    // above the platform UI without the top edge cutting the "Guía" card, and the phone screen of s15.
    const page = 'x1-m-full';
    const screen = 'x1-m-s15';
    const row = (shotId: string, sectionId: string, text: string, y: number): Box => ({ shotId, sectionId, kind: 'price', text, x: 66, y, w: 648, h: 80 });
    const store: SiteData = {
      ...siteShop,
      shots: [
        ...siteShop.shots,
        { id: screen, file: `media/${screen}.png`, viewport: 'mobile', dpr: 2, sectionId: 's15', width: 780, height: 1688 },
        { id: page, file: `media/${page}.png`, viewport: 'mobile', dpr: 2, width: 780, height: 3072 },
      ],
      boxes: [
        ...siteShop.boxes,
        { shotId: screen, sectionId: 's15', kind: 'heading', text: 'Guía: Monetiza tu Instagram', x: 66, y: 407, w: 648, h: 48 },
        row(screen, 's15', '$ 8.900 Agregar', 533),
        row(screen, 's16', '$ 3.000 Agregar', 838),
        row(page, 's15', '$ 8.900 Agregar', 1917),
        row(page, 's16', '$ 3.000 Agregar', 2222),
        { shotId: page, sectionId: 's17', kind: 'heading', text: 'Text card', x: 66, y: 2400, w: 648, h: 48 },
        row(page, 's18', '$ 15.000 Pedir', 2879),
      ],
      blocks: [
        { shotId: screen, x: 32, y: 0, w: 716, h: 647, clippedTop: true },
        { shotId: screen, x: 32, y: 679, w: 716, h: 274 },
        { shotId: page, x: 32, y: 1312, w: 716, h: 719 },
        { shotId: page, x: 32, y: 2063, w: 716, h: 274 },
        { shotId: page, x: 32, y: 2368, w: 716, h: 274 },
        { shotId: page, x: 32, y: 2674, w: 716, h: 319 },
      ],
    };
    const ui = (piece: 'UiFocus' | 'UiScroll', shotId: string, boxIndex: number): Case =>
      inBody({ piece, beats: 4, shotId, boxIndex, lines: [framing('Mirá')] }, store);
    const unframeable = (piece: string, boxIndex: number, shotId: string) =>
      `${piece} cannot frame box ${boxIndex} of ${shotId} cleanly in 9x16 (a card would be cut at the top or the target hidden under the platform UI): aim at another box with product: true`;

    it("reports run 5's UiFocus, whose target cannot get above the platform UI without a card cut at the top, with what the corrector can do", () => {
      // "$ 3.000 Agregar" on the screen of s15: UiFocus takes the full page, where its card stays under the platform UI.
      expect(problemsOf(ui('UiFocus', screen, 2))).toEqual([{ where: 'body[0]', rule: 'structure', detail: unframeable('UiFocus', 2, screen) }]);
    });

    it("reports run 5's UiScroll to the last card of the page", () => {
      expect(problemsOf(ui('UiScroll', page, 3))).toEqual([{ where: 'body[0]', rule: 'structure', detail: unframeable('UiScroll', 3, page) }]);
    });

    it('accepts a product box the camera frames cleanly, for either piece', () => {
      for (const piece of ['UiFocus', 'UiScroll'] as const) {
        clean(ui(piece, page, 0));
        clean(ui(piece, screen, 1));
      }
    });

    // A page of another site: a two-column card near the end of its phone page, which a UiFocus frames at 1.12x and a
    // UiScroll at its base scale cannot bring above the platform UI, and a phone screen whose price the full page lacks.
    const other: SiteData = {
      ...siteShop,
      shots: [
        ...siteShop.shots,
        { id: 'x2-m-s1', file: 'media/x2-m-s1.png', viewport: 'mobile', dpr: 2, sectionId: 's1', width: 780, height: 1688 },
        { id: 'x2-m-full', file: 'media/x2-m-full.png', viewport: 'mobile', dpr: 2, width: 780, height: 3000 },
      ],
      boxes: [
        ...siteShop.boxes,
        { shotId: 'x2-m-s1', sectionId: 's1', kind: 'price', text: '$ 9.990', x: 80, y: 300, w: 290, h: 60 },
        { shotId: 'x2-m-full', sectionId: 's2', kind: 'price', text: '$ 4.500', x: 80, y: 2560, w: 290, h: 60 },
      ],
      blocks: [{ shotId: 'x2-m-full', x: 60, y: 2180, w: 330, h: 500 }],
    };
    const onOther = (piece: 'UiFocus' | 'UiScroll', shotId: string): Case => inBody({ piece, beats: 4, shotId, boxIndex: 0, lines: [framing('Mirá')] }, other);

    it('asks each piece its own camera: a UiScroll the narrow card defeats is reported, with the UiFocus that frames it as a way out', () => {
      clean(onOther('UiFocus', 'x2-m-full'));
      expect(problemsOf(onOther('UiScroll', 'x2-m-full'))).toEqual([
        { where: 'body[0]', rule: 'structure', detail: `${unframeable('UiScroll', 0, 'x2-m-full')}, or make it a UiFocus on this box` },
      ]);
    });

    it('reports a UiScroll whose full page has no such element in words of its own', () => {
      clean(onOther('UiFocus', 'x2-m-s1'));
      expect(problemsOf(onOther('UiScroll', 'x2-m-s1'))).toEqual([
        {
          where: 'body[0]',
          rule: 'structure',
          detail:
            'UiScroll cannot scroll to box 0 of x2-m-s1: the full page it scrolls in 9x16 has no element of the same kind and text; aim at a box of a full page (an id ending in -full) with product: true, or make it a UiFocus on this box',
        },
      ]);
    });

    it('reports a text card once, as marketing, not also as unframeable', () => {
      expect(problemsOf(ui('UiFocus', page, 2)).map((p) => p.detail)).toEqual([expect.stringContaining('UiFocus must film product UI: box 2 ("Text card")')]);
    });
  });

  describe('ClaimStack', () => {
    const means = ['Mercado Pago', 'Transferencia', 'Efectivo', 'Débito'];
    // 8 beats: the last of 3 lines keeps 4, enough to be read before the wipe into body[1].
    const stack = (n: number): Case => inBody({ piece: 'ClaimStack', beats: 8, lines: means.slice(0, n).map((m) => claimLine(m, 'c5')) });
    it.each([1, 4])('rejects %s lines', (n) => expect(notReading(stack(n))).toEqual([{ where: 'body[0]', rule: 'structure', detail: 'ClaimStack needs 2 or 3 lines' }]));
    it.each([2, 3])('accepts %s lines', (n) => clean(stack(n)));
  });

  describe('WordCycle', () => {
    it('requires WordCycle to have a framing prefix plus 2 or 3 words', () => {
      structure(wordCycle(['MP']));
      // Four words, given the 8 beats a scene lasts at most: they cannot hold two beats each (nor be read: see the reading tests).
      expect(notReading(wordCycle(['MP', 'Transferencia', 'Efectivo', 'Débito'], framing('Pagá con'), 8)).map((p) => p.rule)).toEqual(['structure']);
      expect(notReading(wordCycle(['MP', 'Transferencia', 'Efectivo', 'Débito', 'Crédito'], framing('Pagá con'), 8)).map((p) => p.rule)).toEqual(['structure']);
      structure(wordCycle(['MP', 'Transferencia'], claimLine('Pagá con', 'c5')));
      clean(wordCycle(['MP', 'Transferencia']));
      clean(wordCycle(['MP', 'Transferencia', 'Efectivo'], framing('Pagá con'), 7));
    });
    it('says what it wants when a WordCycle has too many words: the beats it needs once the count is valid, never more than a scene lasts', () => {
      const four = notReading(wordCycle(['MP', 'Transferencia', 'Efectivo', 'Débito'], framing('Pagá con'), 6));
      expect(four.map((p) => p.detail)).toEqual([
        'WordCycle needs 2 or 3 words after its framing line, got 4: cut it to 3 words and give it at least 7 beats, or 2 words and 5 beats',
      ]);
      // The same with 5 words, and with the 8 beats a scene lasts at most: the count is what is wrong.
      const five = notReading(wordCycle(['MP', 'Transferencia', 'Efectivo', 'Débito', 'Crédito'], framing('Pagá con'), 8));
      expect(five.map((p) => p.detail)).toEqual([
        'WordCycle needs 2 or 3 words after its framing line, got 5: cut it to 3 words and give it at least 7 beats, or 2 words and 5 beats',
      ]);
    });
    it('says what it wants when a WordCycle has too few words, in the same terms', () => {
      const one = problemsOf(wordCycle(['MP'], framing('Pagá con'), 6));
      expect(one.map((p) => p.detail)).toEqual([
        'WordCycle needs 2 or 3 words after its framing line, got 1: make it 2 words with at least 5 beats, or 3 words with at least 7 beats',
      ]);
    });
    it('flags a WordCycle without lines', () => expect(rules(inBody({ piece: 'WordCycle', beats: 6, lines: [] }))).toEqual(['structure', 'structure']));
    it('requires two beats per word plus one, so that every word stays on screen for two beats within the scene', () => {
      // Too short a scene leaves its words too short to be read as well: the reading rule refuses them on their lines.
      expect(notReading(wordCycle(['MP', 'Transferencia'], framing('Pagá con'), 4)).map((p) => p.rule)).toEqual(['structure']);
      clean(wordCycle(['MP', 'Transferencia'], framing('Pagá con'), 5));
      expect(notReading(wordCycle(['MP', 'Transferencia', 'Efectivo'], framing('Pagá con'), 6)).map((p) => p.rule)).toEqual(['structure']);
      clean(wordCycle(['MP', 'Transferencia', 'Efectivo'], framing('Pagá con'), 7));
      clean(wordCycle(['MP', 'Transferencia', 'Efectivo'], framing('Pagá con'), 8));
      expect(notReading(wordCycle(['MP', 'Transferencia', 'Efectivo'], framing('Pagá con'), 6)).map((p) => p.where)).toEqual(['body[1]']);
    });
    it('names the minimum in the message', () => {
      const [short] = problemsOf(wordCycle(['MP', 'Transferencia'], framing('Pagá con'), 4));
      expect(short?.detail).toBe('WordCycle needs two beats per word plus one (5), got 4');
      const [three] = problemsOf(wordCycle(['MP', 'Transferencia', 'Efectivo'], framing('Pagá con'), 6));
      expect(three?.detail).toBe('WordCycle needs two beats per word plus one (7), got 6');
    });
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

    describe('the typed address is judged only by its equality with the host', () => {
      const at = (host: string): SiteData => ({ ...siteShop, url: `https://${host}/` });

      it.each(['club365.com', '24horas.com.ar', 'unlock.xyz', 'seamless.io', 'game-changer.io'])('accepts the host %s', (host) =>
        clean(typeIn([framing(host)], 'url', at(host))),
      );

      it('still flags a typed address that is not the host, and only for that reason', () => {
        structure(typeIn([framing('club366.com')], 'url', at('club365.com')));
        structure(typeIn([framing('lock.xyz')], 'url', at('unlock.xyz')));
      });

      it('still checks a prompt line for numbers and banned phrases', () => {
        expect(rules(typeIn([framing('¿Cobrás 3 % por venta?')], 'prompt'))).toEqual(['framing-has-data']);
        // 44 characters are not read once typed in 8 beats either: the reading rule says so on its own.
        expect(notReading(typeIn([framing('¿Querés llevar tu tienda al siguiente nivel?')], 'prompt')).map((p) => p.rule)).toEqual(['banned-phrase']);
      });

      it('still checks the framing lines of every other piece', () => {
        expect(rules(withFraming('club365.com'))).toEqual(['framing-has-data']);
        expect(rules(withFraming('unlock.xyz'))).toEqual(['banned-phrase']);
      });

      it('still checks the second line of a url scene, which is already a structure problem', () => {
        expect(rules(typeIn([framing('tiendita.example'), framing('El 90 % de las tiendas')], 'url'))).toEqual(['framing-has-data', 'structure']);
      });
    });

    it('flags a url that cannot be compared when the site address is not valid', () =>
      structure(typeIn([framing('tiendita.example')], 'url', { ...siteShop, url: 'not a url' })));
  });

  describe('atBeat', () => {
    it('requires atBeat between 2 and beats-1, only on UiFocus/UiScroll', () => {
      const outside = (value: number) => notReading(atBeat(value, 8)).map((p) => [p.where, p.detail]);
      expect(outside(8)).toEqual([['body[0].lines[1]', 'atBeat 8 outside 2-7']]);
      expect(outside(0)).toEqual([['body[0].lines[1]', 'atBeat 0 outside 2-7']]);
      expect(outside(1)).toEqual([['body[0].lines[1]', 'atBeat 1 outside 2-7']]);
      for (const value of [2, 7]) expect(outside(value)).toEqual([]);
    });

    it('needs a scene of 7 beats or more for a second caption, and says how to fix it', () => {
      const swap = (beats: number) =>
        `a second caption (atBeat) needs a scene of 7 beats or more, got ${beats}: drop the second caption, or give the scene 7 beats or more`;
      expect(notReading(atBeat(3, 6))).toEqual([{ where: 'body[0].lines[1]', rule: 'structure', detail: swap(6) }]);
      expect(notReading(atBeat(2, 4))).toEqual([{ where: 'body[0].lines[1]', rule: 'structure', detail: swap(4) }]);
      // Both: an atBeat outside the scene, in a scene too short for two captions.
      expect(notReading(atBeat(4, 4)).map((p) => p.detail)).toEqual(['atBeat 4 outside 2-3', swap(4)]);
      // In 8 beats, with the second caption on beat 5, both are on screen long enough to be read (see the reading tests).
      clean(atBeat(5, 8));
    });

    it('allows atBeat on the second line of a UiScroll', () =>
      clean(inBody({ piece: 'UiScroll', beats: 7, shotId: 's1-mobile', boxIndex: 0, lines: [framing('Mirá'), framing('Y seguí', { atBeat: 3 })] })));

    it('rejects atBeat on any line but the second', () => {
      structure(inBody(uiFocus({ lines: [claimLine('Tu tienda, lista en minutos.', 'c2', { atBeat: 2 })] })));
      expect(notReading(inBody(uiFocus({ beats: 8, lines: [framing('Uno'), framing('Dos'), framing('Tres', { atBeat: 2 })] }))).map((p) => p.detail)).toEqual([
        'atBeat belongs only on the second line of a UiFocus or UiScroll scene',
      ]);
    });

    it('rejects atBeat on other pieces', () => structure(inBody(headline([framing('Uno'), framing('Dos', { atBeat: 2 })], 4))));
  });

  describe('length of the main video', () => {
    it('requires hook 0 to last 15-30 s', () => {
      // 2 scenes of 2 beats and a cta of 4 beats at 128 bpm: 8 beats in all, 113 frames (too short for their texts too).
      const short = shop({ ...edlShop, bpm: 128, hooks: [[headline([framing('Uno')], 2), headline([framing('Dos')], 2)]], body: [], cta: { ...edlShop.cta, beats: 4 } });
      expect(problemsOf(short).filter((p) => p.where === 'edl')).toEqual([{ where: 'edl', rule: 'structure', detail: 'the video with hook 0 lasts 3.77 s (expected 15-30)' }]);
    });

    const lengthProblems = (c: Case) => problemsOf(c).filter((p) => p.where === 'edl').map((p) => p.detail);

    it.each([
      [29, 'the video with hook 0 lasts 14.50 s (expected 15-30)'],
      [61, 'the video with hook 0 lasts 30.50 s (expected 15-30)'],
    ])('measures a video of %s beats at 120 bpm against the band, as planned', (beats, detail) => {
      expect(layoutScenes(ofBeats(beats, 120).edl, 0).total / FPS).toBe(beats / 2);
      expect(lengthProblems(ofBeats(beats, 120))).toEqual([detail]);
    });

    it.each([
      [60, 'the video with hook 0 lasts 30.00 s, and up to 30.53 s once moved to the tempo its music comes at (within 15 % of 120 bpm; expected 15-30): take 2 beats off its scenes'],
      [59, 'the video with hook 0 lasts 29.50 s, and up to 30.03 s once moved to the tempo its music comes at (within 15 % of 120 bpm; expected 15-30): take 1 beat off its scenes'],
      [30, 'the video with hook 0 lasts 15.00 s, and down to 14.47 s once moved to the tempo its music comes at (within 15 % of 120 bpm; expected 15-30): add 2 beats to its scenes'],
    ])('keeps a video of %s beats at 120 bpm in the band once retimed to any tempo its music can come at, naming the beats', (beats, detail) =>
      expect(lengthProblems(ofBeats(beats, 120))).toEqual([detail]));

    it.each([32, 58])('takes a video of %s beats at 120 bpm, in the band at every tempo its music can come at', (beats) =>
      expect(lengthProblems(ofBeats(beats, 120))).toEqual([]));

    it('takes every plan of 18 to 22 s, at every tempo the director can ask for', () => {
      for (const bpm of [90, 98, 104, 112, 120, 128]) {
        const shortest = Math.ceil((18 * bpm) / 60);
        const longest = Math.floor((22 * bpm) / 60);
        for (const beats of [shortest, Math.round((shortest + longest) / 2), longest]) expect(lengthProblems(ofBeats(beats, bpm)), `${beats} beats at ${bpm} bpm`).toEqual([]);
      }
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
      { id: 'hooks[0][0]:framing:0', text: '¿Cuánto te cobran', context: ['por cada venta?'] },
      { id: 'hooks[0][0]:framing:1', text: 'por cada venta?', context: ['¿Cuánto te cobran'] },
    ]);
  });

  it('counts the line index inside the scene even when claim lines come first', () => {
    const edl = withBody(0, headline([claimLine('0% de comisión.', 'c3'), framing('¿Te animás?')]));
    expect(judgeItems(edl).framing).toContainEqual({ id: 'body[0]:framing:1', text: '¿Te animás?', context: ['0% de comisión.'] });
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

  // "Nadie más te da" says nothing alone, and "0% de comisión." is backed; together they claim no one else does it.
  it('gives each framing item the other lines of its scene, in order, so the judge reads it with what it introduces', () => {
    const edl = withBody(0, headline([framing('Nadie más te da'), claimLine('0% de comisión.', 'c3'), framing('¿Te animás?')]));
    expect(judgeItems(edl).framing.filter((f) => f.id.startsWith('body[0]'))).toEqual([
      { id: 'body[0]:framing:0', text: 'Nadie más te da', context: ['0% de comisión.', '¿Te animás?'] },
      { id: 'body[0]:framing:2', text: '¿Te animás?', context: ['Nadie más te da', '0% de comisión.'] },
    ]);
  });

  // Its only rule is being the host (validateEdl): a judge could read a bare domain as a product claim, and no fix could
  // satisfy both.
  it('leaves the address a TypeIn url types out of the framing items', () => {
    const edl = withBody(0, { piece: 'TypeIn', beats: 4, variant: 'url', lines: [framing('tiendita.example')] });
    expect(judgeItems(edl).framing.filter((f) => f.id.startsWith('body[0]'))).toEqual([]);
  });

  it('still judges the question a TypeIn prompt types', () => {
    const edl = withBody(0, { piece: 'TypeIn', beats: 4, variant: 'prompt', lines: [framing('¿Cuánto cobrás por venta?')] });
    expect(judgeItems(edl).framing).toContainEqual({ id: 'body[0]:framing:0', text: '¿Cuánto cobrás por venta?', context: [] });
  });
});

describe('siteHost', () => {
  it('is the host a TypeIn url has to type: no www, no path, lower case', () =>
    expect(siteHost('https://www.Tiendita.example/precios?x=1')).toBe('tiendita.example'));

  it('is undefined for an address that is not a URL', () => expect(siteHost('not a url')).toBeUndefined());
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

describe('timedScenePath', () => {
  it('names the scenes of the video of a hook as scenePaths does: that hook, the body, the cta', () => {
    const all = scenePaths(edlShop).map((p) => p.path);
    edlShop.hooks.forEach((_hook, h) => {
      const paths = layoutScenes(edlShop, h).scenes.map((timed) => timedScenePath(edlShop, h, timed));
      expect(paths).toEqual(all.filter((path) => !path.startsWith('hooks[') || path.startsWith(`hooks[${h}][`)));
    });
  });

  it('points at the scene that was laid out', () => {
    const byPath = new Map(scenePaths(edlShop).map((p) => [p.path, p.scene]));
    for (const timed of layoutScenes(edlShop, 2).scenes) expect(byPath.get(timedScenePath(edlShop, 2, timed))).toBe(timed.scene);
  });

  it('gives paths that applyPatches accepts', () => {
    const [timed] = layoutScenes(edlShop, 2).scenes.slice(-2);
    if (!timed) throw new Error('no scene');
    const scene = { ...timed.scene, beats: timed.scene.beats + 1 };
    const patched = applyPatches(edlShop, [{ path: timedScenePath(edlShop, 2, timed), scene }], []);
    expect(layoutScenes(patched, 2).scenes.map((t) => t.scene)).toContain(scene);
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
