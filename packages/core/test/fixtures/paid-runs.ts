// The edit lists of two paid runs on cobrame.app, as they were rendered (after the retime to the tempo measured on their
// music), reconstructed frame by frame from their videos: run 7 (104 bpm), whose texts went by too fast, and run 4 (111
// bpm). Their UI scenes film the shop fixture's shots, which pass the shot checks, and their quotes are in a section of
// cobrame's own added to the shop site: so validateEdl finds nothing in them but how long their texts stay on screen.
import type { Claim, Edl, Line, Scene, SiteData } from '../../src/index';
import siteShopJson from './site-shop.json';

const ui = (piece: 'UiFocus' | 'UiScroll', beats: number, lines: Line[]): Scene =>
  piece === 'UiFocus' ? { piece, beats, lines, shotId: 's1-mobile', boxIndex: 0 } : { piece, beats, lines, shotId: 's1-mobile', boxIndex: 2 };
export const claim = (text: string, claimId: string, atBeat?: number): Line => ({ text, kind: 'claim', claimId, ...(atBeat === undefined ? {} : { atBeat }) });
export const framing = (text: string, atBeat?: number): Line => ({ text, kind: 'framing', ...(atBeat === undefined ? {} : { atBeat }) });

const QUOTES: Record<string, string> = {
  c1: 'La plata va directo a tu cuenta — nosotros no tocamos un peso.',
  c2: '0% de comisión',
  c3: 'Tu tienda de productos digitales y sesiones 1:1 en un solo link.',
  c4: 'Un solo link para tu bio: productos, precios y pago.',
  c5: 'Mercado Pago o transferencia directa a tu cuenta.',
  c6: 'Confirmado el pago, la entrega sale sola: la descarga o el turno agendado.',
  c7: 'Creá tu tienda gratis',
  c8: 'Lo armás en minutos, sin saber nada de tecnología.',
  c9: 'Vendé lo tuyo. Cobrás todo.',
};
const claims = (ids: string[]): Claim[] => ids.map((id) => ({ id, text: QUOTES[id] ?? '', sectionId: 'cobrame', quote: QUOTES[id] ?? '' }));

/** The shop site with a section of cobrame's that holds every quote of both runs. */
export const paidRunsSite = (): SiteData => {
  const shop = siteShopJson as SiteData;
  return { ...shop, sections: [...shop.sections, { id: 'cobrame', heading: 'Vendé lo tuyo. Cobrás todo.', text: Object.values(QUOTES).join('\n'), ctas: [] }] };
};

/** Run 7 (a0f1b70): 32 beats at 104 bpm, 18.47 s. Its hook and its UiScroll replace their caption at beat 3. */
export const run7 = (): Edl => ({
  lang: 'es',
  bpm: 104,
  style: { energy: 'calm', density: 'airy' },
  hooks: [[ui('UiFocus', 4, [framing('¿Cuánto te queda de cada venta?'), claim('La plata va directo a tu cuenta.', 'c1', 3)])]],
  body: [
    { piece: 'KineticHeadline', beats: 4, lines: [claim('0% de', 'c2'), claim('comisión.', 'c2')], transitionIn: 'wipe' },
    ui('UiScroll', 6, [claim('Productos digitales y sesiones 1:1.', 'c3'), claim('Un solo link para tu bio.', 'c4', 3)]),
    { piece: 'WordCycle', beats: 6, lines: [framing('Cobrás con'), claim('Mercado Pago', 'c5'), claim('transferencia', 'c5')] },
    { ...ui('UiFocus', 6, [claim('Pagan y la descarga sale sola.', 'c6')]), shotId: 's4-mobile', boxIndex: 1 },
  ],
  cta: { piece: 'EndCard', beats: 6, lines: [claim('Creá tu tienda gratis', 'c7'), framing('Dejá de regalar tu comisión.')], transitionIn: 'wipe' },
  claims: claims(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']),
  musicPrompt: 'Warm, calm acoustic pop.',
});

/** Run 4 (a2f4681): 34 beats at 111 bpm, 18.37 s, laid out by today's WordCycle rule. */
export const run4 = (): Edl => ({
  lang: 'es',
  bpm: 111,
  style: { energy: 'bold', density: 'airy' },
  hooks: [[ui('UiFocus', 4, [claim('Productos digitales y sesiones 1:1.', 'c3')])]],
  body: [
    { piece: 'KineticHeadline', beats: 4, lines: [claim('0% de comisión.', 'c2')], transitionIn: 'wipe' },
    ui('UiScroll', 8, [claim('Productos, precios y pago en un link.', 'c4'), claim('Lo armás en minutos.', 'c8', 4)]),
    { piece: 'WordCycle', beats: 5, lines: [framing('Cobrás por'), claim('Mercado Pago', 'c5'), claim('transferencia', 'c5')] },
    { piece: 'ClaimStack', beats: 7, lines: [claim('Confirmado el pago,', 'c6'), claim('la entrega sale sola:', 'c6'), claim('descarga o turno', 'c6')] },
  ],
  cta: { piece: 'EndCard', beats: 6, lines: [claim('Creá tu tienda gratis', 'c7'), claim('Vendé lo tuyo. Cobrás todo.', 'c9')], transitionIn: 'wipe' },
  claims: claims(['c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9']),
  musicPrompt: 'Bright, bold electronic pop.',
});
