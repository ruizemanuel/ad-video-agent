import { afterEach, describe, expect, it, vi } from 'vitest';
import { averageInk, brandName, closeLogoBox, closeMark, fitLogo, inkReads, logoReads, measuredInk, recordedLogoSize, videoShowsLogo } from '../src/video/logo';

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
    expect(videoShowsLogo(small, '9x16', '#111111', '#ffffff')).toBe(false);
    expect(videoShowsLogo({ width: 480, height: 160 }, '9x16', '#111111', '#ffffff')).toBe(true);
    expect(videoShowsLogo({ width: 5760, height: 264 }, '9x16', '#111111', '#ffffff')).toBe(false);
    expect(videoShowsLogo(null, '9x16', '#111111', '#ffffff')).toBe(false);
  });

  it('shows the name when the ink could not be measured', () => {
    expect(inkReads(null, ['#ffffff'])).toBe(false);
    expect(videoShowsLogo({ width: 480, height: 160 }, '9x16', null, '#ffffff')).toBe(false);
  });

  it("is decided on the page's background, where the branded opening and the chip of the close are", () => {
    // A dark mark that would be a smudge on the brand color still shows: the close sets it on a chip (see closeMark).
    expect(inkReads('#1f2a24', ['#0b7a4b'])).toBe(false);
    expect(videoShowsLogo({ width: 480, height: 160 }, '9x16', '#1f2a24', '#f7f7f2')).toBe(true);
    // A white mark, as one taken from a dark header, would vanish into a light page: the name, everywhere.
    expect(videoShowsLogo({ width: 480, height: 160 }, '9x16', '#ffffff', '#f7f7f2')).toBe(false);
  });

  it('takes the size the capture recorded, when it recorded one', () => {
    expect(recordedLogoSize({ file: 'media/logo.png', kind: 'png', width: 480, height: 160 })).toEqual({ width: 480, height: 160 });
    expect(recordedLogoSize({ file: 'media/logo.png', kind: 'png' })).toBeNull();
    expect(recordedLogoSize({ file: 'media/logo.png', kind: 'png', width: 0, height: 160 })).toBeNull();
    expect(recordedLogoSize(undefined)).toBeNull();
  });
});

describe('the mark of the close', () => {
  it('sets a logo whose ink does not stand out on the close on a chip of the page', () => {
    expect(closeMark('#1f2a24', '#0b7a4b')).toBe('chip'); // a dark mark on a brand green, 2.76:1
    expect(closeMark('#000000', '#000000')).toBe('chip'); // a black mark on a black close
  });

  it('sets a logo whose ink stands out on the close right on it', () => {
    expect(closeMark('#1f2a24', '#f7f7f2')).toBe('logo');
    expect(closeMark('#ffffff', '#0b7a4b')).toBe('logo');
  });
});

describe('the ink of the logo', () => {
  it('averages the ink of the opaque pixels only', () => {
    expect(averageInk(new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 0]))).toBe('#000000');
  });

  it('weights the ink by its alpha', () => {
    // (0 * 255 + 255 * 128) / (255 + 128) = 85.2
    expect(averageInk(new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 128]))).toBe('#555555');
  });

  it('has no ink when no pixel is opaque enough', () => {
    expect(averageInk(new Uint8ClampedArray([10, 20, 30, 0, 40, 50, 60, 127]))).toBeNull();
    expect(averageInk(new Uint8ClampedArray([]))).toBeNull();
  });

  it('reads ink that stands out on every background', () => {
    expect(inkReads('#111111', ['#f7f7f2', '#0b7a4b'])).toBe(true);
  });

  it('does not read a dark logo on a dark brand color', () => {
    expect(inkReads('#1f2a24', ['#0b7a4b'])).toBe(false);
    expect(inkReads('#111111', ['#f7f7f2', '#111111'])).toBe(false);
  });

  describe('as the canvas gives it back', () => {
    afterEach(() => vi.restoreAllMocks());

    it('averages the pixels the canvas gives back, and says nothing', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(measuredInk('media/logo.png', () => new Uint8ClampedArray([0, 0, 0, 255]))).toBe('#000000');
      expect(warn).not.toHaveBeenCalled();
    });

    it('has no ink when the canvas refuses, and says so naming the file, so a canvas that always refuses shows in the log', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const refused = () => {
        throw new DOMException('The canvas has been tainted by cross-origin data.', 'SecurityError');
      };
      expect(measuredInk('media/logo.png', refused)).toBeNull();
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]?.[0])).toContain('media/logo.png');
    });
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
