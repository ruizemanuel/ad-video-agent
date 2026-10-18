import { describe, expect, it } from 'vitest';
import { brandName, closeLogoBox, fitLogo, logoReads, recordedLogoSize, videoShowsLogo } from '../src/video/logo';

// The box the EndCard gives the logo in 9x16: 70% of its 760 px column, 3.2 times the format's logo size.
const box = { width: 532, height: 269 };

describe('the logo of the close', () => {
  it('shows a logo of ordinary proportions, captured at DPR 4, as the image', () => {
    expect(logoReads({ width: 480, height: 160 }, box)).toBe(true);
    expect(logoReads({ width: 200, height: 200 }, box)).toBe(true);
    expect(logoReads({ width: 1440, height: 240 }, box)).toBe(true);
  });

  it('gives way to the name when the logo is missing or could not be read', () => {
    expect(logoReads(null, box)).toBe(false);
    expect(logoReads({ width: 0, height: 0 }, box)).toBe(false);
  });

  it('gives way to the name when the logo is a strip wider than 6:1, such as a whole text header', () => {
    expect(logoReads({ width: 5760, height: 264 }, box)).toBe(false);
    expect(logoReads({ width: 1300, height: 200 }, box)).toBe(false);
  });

  it('gives way to the name when the logo is so small that it would be enlarged more than 3 times', () => {
    expect(logoReads({ width: 64, height: 64 }, box)).toBe(false);
    expect(logoReads({ width: 90, height: 90 }, box)).toBe(true);
  });

  it('fits a logo in its box keeping its proportions', () => {
    expect(fitLogo({ width: 480, height: 160 }, box)).toEqual({ width: 532, height: 532 / 3 });
    expect(fitLogo({ width: 200, height: 200 }, box)).toEqual({ width: 269, height: 269 });
  });
});

describe('the logo of the whole video', () => {
  it('gives the close its box: 70% of the centered column wide and 3.2 times the logo size high', () => {
    expect(closeLogoBox('9x16')).toEqual(box);
    expect(closeLogoBox('16x9')).toEqual({ width: 1260, height: 243 });
    expect(closeLogoBox('4x5')).toEqual({ width: 672, height: 230 });
  });

  it('is decided once, against the box of the close, so the opening and the close agree', () => {
    // 100x60 px reads at the opening's height (84 px, enlarged 1.4 times) but not in the close (4.5 times).
    const small = { width: 100, height: 60 };
    expect(logoReads(small, { width: 860, height: 84 })).toBe(true);
    expect(videoShowsLogo(small, '9x16')).toBe(false);
    expect(videoShowsLogo({ width: 480, height: 160 }, '9x16')).toBe(true);
    expect(videoShowsLogo({ width: 5760, height: 264 }, '9x16')).toBe(false);
    expect(videoShowsLogo(null, '9x16')).toBe(false);
  });

  it('takes the size the capture recorded, when it recorded one', () => {
    expect(recordedLogoSize({ file: 'media/logo.png', kind: 'png', width: 480, height: 160 })).toEqual({ width: 480, height: 160 });
    expect(recordedLogoSize({ file: 'media/logo.png', kind: 'png' })).toBeNull();
    expect(recordedLogoSize({ file: 'media/logo.png', kind: 'png', width: 0, height: 160 })).toBeNull();
    expect(recordedLogoSize(undefined)).toBeNull();
  });
});

describe('the name of the brand', () => {
  it('takes the part of the title that names the site', () => {
    expect(brandName({ title: 'Tiendita | Sell on WhatsApp', url: 'http://127.0.0.1:4173/' })).toBe('Tiendita');
    expect(brandName({ title: 'Cobrame — Cobrá con un link', url: 'https://cobrame.app/' })).toBe('Cobrame');
  });

  it('prefers the part that matches the address, wherever it is in the title', () => {
    expect(brandName({ title: 'Home - Acme', url: 'https://www.acme.com/' })).toBe('Acme');
    expect(brandName({ title: 'Compras online: Mercado Libre', url: 'https://www.mercadolibre.com.ar/' })).toBe('Mercado Libre');
  });

  it('keeps a hyphen inside a name', () => {
    expect(brandName({ title: 'Coca-Cola | Refresca', url: 'https://example.org/' })).toBe('Coca-Cola');
  });

  it('falls back to the address when the title is empty or a sentence', () => {
    expect(brandName({ title: '', url: 'https://www.tiendita.example/' })).toBe('tiendita.example');
    expect(brandName({ title: 'Sell on WhatsApp with no fees at all', url: 'https://tiendita.example/' })).toBe('tiendita.example');
  });
});
