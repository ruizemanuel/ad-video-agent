import { describe, expect, it } from 'vitest';
import { EdlSchema, MUSIC_MODELS, claimsMarkdown, musicMarkdown, type Edl, type Scene, type SiteData } from '../src/index';
import edlShopJson from './fixtures/edl-shop.json';
import siteShopJson from './fixtures/site-shop.json';

const edlShop = EdlSchema.parse(edlShopJson);
const siteShop = siteShopJson as SiteData;
const SITE = 'https://tiendita.example';

const item = (text: string, quote: string, heading: string): string => `- **${text}**\n  Source: "${quote}" (${SITE}, section "${heading}")`;

// The items of a claims.md, each with its two lines.
const items = (markdown: string): string[] => markdown.split('\n').flatMap((line, k, all) => (line.startsWith('- ') ? [`${line}\n${all[k + 1] ?? ''}`] : []));

describe('claimsMarkdown', () => {
  it('lists the claims of hook 0, the body and the cta in playing order, as they read on screen, with their source', () => {
    expect(items(claimsMarkdown(edlShop, siteShop))).toEqual([
      item('Tus clientes piden por WhatsApp.', 'piden por WhatsApp y vos confirmás el pedido', 'Mirá una tienda de ejemplo'),
      item('0% de comisión.', '0% de comisión', 'Precios'),
      item('Mercado Pago. Transferencia. Efectivo al retirar.', 'Mercado Pago, transferencia y efectivo al retirar', 'Medios de pago'),
      item('Plan Pro $4.990 por mes.', 'Plan Pro a $4.990 por mes', 'Precios'),
      item('Crear mi tienda', 'Crear mi tienda', 'Vendé por WhatsApp sin comisiones'),
    ]);
  });

  it('leaves out the claims that only the other hooks make', () => {
    // c1 ("sin comisiones") and c2 ("en minutos") are only in hooks[1] and hooks[2].
    const markdown = claimsMarkdown(edlShop, siteShop);
    expect(markdown).not.toContain('Source: "Vendé por WhatsApp sin comisiones"');
    expect(markdown).not.toContain('minutos');
  });

  it('lists the claims of the hook it is asked for', () => {
    expect(items(claimsMarkdown(edlShop, siteShop, 1))[0]).toBe(item('Vendé por WhatsApp sin comisiones.', 'Vendé por WhatsApp sin comisiones', 'Vendé por WhatsApp sin comisiones'));
  });

  it('shows what the screen says, never the claim text the checks do not read', () => {
    const edl: Edl = { ...edlShop, claims: edlShop.claims.map((c) => (c.id === 'c3' ? { ...c, text: 'Never commissions, for anyone, ever.' } : c)) };
    expect(claimsMarkdown(edl, siteShop)).not.toContain('Never commissions');
  });

  it('lists a claim once when two scenes say it the same way, and each wording when they differ', () => {
    const again: Scene = { piece: 'KineticHeadline', beats: 4, lines: [{ text: '0% de comisión.', kind: 'claim', claimId: 'c3' }] };
    const reworded: Scene = { piece: 'KineticHeadline', beats: 4, lines: [{ text: 'Cero comisión: 0%.', kind: 'claim', claimId: 'c3' }] };
    const texts = items(claimsMarkdown({ ...edlShop, body: [...edlShop.body, again, reworded] }, siteShop)).filter((i) => i.includes('"0% de comisión"'));
    expect(texts).toEqual([item('0% de comisión.', '0% de comisión', 'Precios'), item('Cero comisión: 0%.', '0% de comisión', 'Precios')]);
  });

  it('escapes what Markdown would read as formatting, and keeps each item on its two lines', () => {
    const site: SiteData = { ...siteShop, sections: siteShop.sections.map((s) => (s.id === 's2' ? { ...s, text: `${s.text} Plan *Pro* <b>\nnuevo` } : s)) };
    const edl: Edl = {
      ...edlShop,
      body: edlShop.body.map((scene, k) => (k === 1 ? { ...scene, lines: [{ text: '0% de *comisión*.', kind: 'claim', claimId: 'c3' }] } : scene)),
      claims: edlShop.claims.map((c) => (c.id === 'c3' ? { ...c, quote: 'Plan *Pro* <b>\nnuevo' } : c)),
    };
    expect(claimsMarkdown(edl, site)).toContain('- **0% de \\*comisión\\*.**\n  Source: "Plan \\*Pro\\* \\<b\\> nuevo"');
  });

  it('says so when the video claims nothing', () => {
    const framingOnly: Edl = { ...edlShop, hooks: [edlShop.hooks[0] ?? []], body: [], cta: { ...edlShop.cta, lines: [{ text: 'Probalo', kind: 'framing' }] }, claims: [] };
    const markdown = claimsMarkdown(framingOnly, siteShop);
    expect(items(markdown)).toEqual([]);
    expect(markdown).toMatch(/no claims/i);
  });

  it('refuses a hook the edit list does not have', () => {
    expect(() => claimsMarkdown(edlShop, siteShop, 3)).toThrow(RangeError);
  });
});

describe('MUSIC_MODELS', () => {
  it('lists the model of each candidate in the order they are asked for: Lyria 3.5, Lyria 3 Pro, and Lyria 3.5 again for the one asked for last', () => {
    expect(MUSIC_MODELS).toEqual(['lyria-3.5', 'lyria-3-pro-preview', 'lyria-3.5']);
  });
});

describe('musicMarkdown', () => {
  const markdown = musicMarkdown({ measuredBpm: 112, musicPrompt: edlShop.musicPrompt, model: 'lyria-3.5' });

  it('names the model, the tempo, the watermark, the use in paid ads and the version without music', () => {
    for (const text of ['Google Lyria 3.5', '112 BPM', 'SynthID', 'paid ads', 'hook-a-9x16-muted.mp4']) expect(markdown).toContain(text);
  });

  it('names Lyria 3 Pro, and not Lyria 3.5, when the track came from it', () => {
    const pro = musicMarkdown({ measuredBpm: 112, musicPrompt: edlShop.musicPrompt, model: 'lyria-3-pro-preview' });
    expect(pro).toContain('made for this video by Google Lyria 3 Pro, an AI music model');
    expect(pro).not.toContain('3.5');
  });

  it('names Lyria 3.5, and not Lyria 3 Pro, when the track came from it', () => {
    expect(markdown).toContain('made for this video by Google Lyria 3.5, an AI music model');
    expect(markdown).not.toContain('3 Pro');
  });

  it('says the same of the watermark and of the use of the track, whichever model made it', () => {
    const pro = musicMarkdown({ measuredBpm: 112, musicPrompt: edlShop.musicPrompt, model: 'lyria-3-pro-preview' });
    const lines = (text: string): string =>
      text
        .split('\n')
        .filter((line) => /SynthID|paid ads|AI-generated/.test(line))
        .join('\n');
    expect(lines(pro)).toBe(lines(markdown));
    expect(lines(pro)).toContain('SynthID');
  });

  it('quotes the direction the music was made from', () => {
    expect(markdown).toContain(edlShop.musicPrompt);
  });

  it('gives a measured tempo to a tenth of a beat per minute', () => {
    expect(musicMarkdown({ measuredBpm: 113.19, musicPrompt: 'Calm piano.', model: 'lyria-3.5' })).toContain('113.2 BPM');
  });
});
