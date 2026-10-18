import { safeWidth, TYPE } from '@app/core';
import { describe, expect, it } from 'vitest';
import { fitAddress, fitHeadline, glyphOverhang, layoutCaptions, layoutLines, lineSources, lineText, pillSize, toWords, type Measure } from '../src/video/type';

// A stand-in for the browser's measure: every character is 0.6 em wide.
const perChar: Measure = (text) => text.length * 0.6;
const words = (...lines: string[]) => lines.map((text) => toWords({ text, kind: 'framing' }));

describe('the headline size', () => {
  it('sizes the headline by line count', () => {
    expect(fitHeadline(['Una', 'Dos', 'Tres'], '9x16')).toBeLessThan(fitHeadline(['Una'], '9x16'));
    // One or two lines get the full size; three a step less and four or more another (as in the hand-made cobrame ads).
    expect(fitHeadline(['Una'], '9x16')).toBe(TYPE['9x16'].headline);
    expect(fitHeadline(['Una', 'Dos'], '9x16')).toBe(TYPE['9x16'].headline);
    expect(fitHeadline(['Una', 'Dos', 'Tres'], '9x16')).toBe(Math.floor(TYPE['9x16'].headline * 0.88));
    expect(fitHeadline(['Una', 'Dos', 'Tres', 'Cuatro'], '9x16')).toBe(Math.floor(TYPE['9x16'].headline * 0.74));
  });

  it('caps the headline at the size of its format', () => {
    expect(fitHeadline(['Una'], '16x9', perChar)).toBe(TYPE['16x9'].headline);
    expect(fitHeadline(['Una'], '4x5', perChar)).toBe(TYPE['4x5'].headline);
  });

  it('never sets a line wider than the safe width', () => {
    const line = 'Productos digitales';
    const size = fitHeadline([line], '9x16', perChar);
    expect(size).toBeLessThan(TYPE['9x16'].headline);
    expect(size * perChar(line)).toBeLessThanOrEqual(safeWidth('9x16'));
  });

  it('never goes below the smallest size of the format', () => {
    expect(fitHeadline(['A line far too long to fit any frame at a readable size at all'], '9x16', perChar)).toBe(TYPE['9x16'].min);
  });
});

describe('setting lines', () => {
  const headline = { width: safeWidth('9x16'), max: TYPE['9x16'].headline, min: TYPE['9x16'].min, maxLines: 3, measure: perChar };

  it('keeps short lines as they are, at one size for all', () => {
    const set = layoutLines(words('Vendé lo tuyo.', 'Cobrás todo.'), headline);
    expect(set.lines.map(lineText)).toEqual(['Vendé lo tuyo.', 'Cobrás todo.']);
    expect(set.size).toBe(fitHeadline(['Vendé lo tuyo.', 'Cobrás todo.'], '9x16', perChar));
  });

  it('splits a line that would be set too small at its most balanced space, never inside a word', () => {
    const set = layoutLines(words('Un solo link para tu bio con productos'), headline);
    expect(set.lines.length).toBeGreaterThan(1);
    expect(set.lines.map(lineText).join(' ')).toBe('Un solo link para tu bio con productos');
    expect(set.lines.map(lineText)[0]).toBe('Un solo link para');
    // The block is set at the size its final lines fit at.
    expect(set.size).toBe(fitHeadline(set.lines.map(lineText), '9x16', perChar));
    for (const line of set.lines) expect(set.size * perChar(lineText(line))).toBeLessThanOrEqual(headline.width);
  });

  it('stops at the most lines it is allowed', () => {
    const set = layoutLines(words('Un solo link para tu bio con productos, precios y pago'), { ...headline, maxLines: 2 });
    expect(set.lines).toHaveLength(2);
  });

  it('keeps a block of fixed height whole, glyphs included, by setting its lines smaller', () => {
    // The caption of a 16:9 UI scene: 190 px high, in a font whose lines are 1.12 em apart.
    const caption = { width: 1620, max: TYPE['16x9'].caption, min: TYPE['16x9'].min, maxLines: 2, measure: perChar, box: { height: 190, lineHeight: 1.12 } };
    const two = layoutLines(words('Pro plan: $4.990 / mes', 'Everything included'), caption);
    expect(two.size).toBeLessThan(TYPE['16x9'].caption);
    // Two lines, plus what the glyphs (up to 1.3 em tall) reach past the first and the last line.
    expect(two.size * (2 * 1.12 + (1.3 - 1.12))).toBeLessThanOrEqual(190);
    // One line fits at the full size.
    expect(layoutLines(words('Pro plan: $4.990 / mes'), caption).size).toBe(TYPE['16x9'].caption);
  });

  it('leaves out empty lines', () => {
    expect(layoutLines([[], ...words('Cobrás todo.')], headline).lines.map(lineText)).toEqual(['Cobrás todo.']);
  });

  it('tells which line of the edit list each set line starts in, through splits and empty lines', () => {
    const source = words('Your shop', 'in one link for your whole catalog');
    const split = layoutLines(source, headline);
    expect(split.lines.map(lineText)).toEqual(['Your shop', 'in one link for', 'your whole catalog']);
    expect(lineSources(split.lines, source)).toEqual([0, 1, 1]);
    const withEmpty = [[], ...words('One', 'Two')];
    expect(lineSources(layoutLines(withEmpty, headline).lines, withEmpty)).toEqual([1, 2]);
  });
});

describe('captions that replace one another', () => {
  // The caption of a 9:16 UI scene: as wide as the safe zone, in a block 300 px high.
  const caption = { width: safeWidth('9x16'), max: TYPE['9x16'].caption, min: TYPE['9x16'].min, maxLines: 2, measure: perChar, box: { height: 300, lineHeight: 1.12 } };

  it('sets them at one size, splitting a caption that would otherwise hold the other one down', () => {
    // On its own, "Everything included" stays on one line at 73 px; split, it is set as large as the first caption.
    expect(layoutLines(words('Everything included'), caption)).toMatchObject({ size: 73 });
    const set = layoutCaptions([words('Sell on WhatsApp with no fees'), words('Everything included')], caption);
    expect(set.lines.map((lines) => lines.map(lineText))).toEqual([
      ['Sell on WhatsApp', 'with no fees'],
      ['Everything', 'included'],
    ]);
    expect(set.size).toBe(layoutLines(words('Sell on WhatsApp with no fees'), caption).size);
  });

  it('splits nothing when every caption fits on one line at the full size', () => {
    const set = layoutCaptions([words('Pro plan'), words('All included')], caption);
    expect(set.lines.map((lines) => lines.map(lineText))).toEqual([['Pro plan'], ['All included']]);
    expect(set.size).toBe(TYPE['9x16'].caption);
  });

  it('never sets them below the smallest size of the format', () => {
    const long = words('A caption far too long to be set at any readable size in this block');
    expect(layoutCaptions([words('Pro plan'), long], caption).size).toBe(TYPE['9x16'].min);
  });
});

describe('a site address', () => {
  const sizes = { max: 80, min: 44 };

  it('stays on one line, as large as fits up to its largest size', () => {
    expect(fitAddress('cobrame.ar', 534, sizes, perChar)).toEqual({ parts: ['cobrame.ar'], size: 80 });
    // 16 characters, 9.6 em: 534 * 0.98 / 9.6 = 54.5.
    expect(fitAddress('tiendita.example', 534, sizes, perChar)).toEqual({ parts: ['tiendita.example'], size: 54 });
  });

  it('breaks before a dot when one line would be set below the smallest size, the parts as even as they can be', () => {
    expect(fitAddress('distribuidoradelnorte.com.ar', 700, sizes, perChar)).toEqual({ parts: ['distribuidoradelnorte', '.com.ar'], size: 54 });
  });

  it('breaks after a hyphen too', () => {
    expect(fitAddress('distribuidoradelnorte-mayorista.com.ar', 700, sizes, perChar)).toEqual({ parts: ['distribuidoradelnorte-', 'mayorista.com.ar'], size: 51 });
  });

  it('breaks inside a name too long for any line at the smallest size, so the whole address is always on screen', () => {
    const host = 'superlongbrandnamewithoutanydotsatall.com';
    const set = fitAddress(host, 534, sizes, perChar);
    expect(set.size).toBe(44);
    expect(set.parts.join('')).toBe(host);
    for (const part of set.parts) expect(44 * perChar(part)).toBeLessThanOrEqual(534 * 0.98);
  });
});

describe('the glyphs past the line', () => {
  it('reaches past a tight line by half of what the glyphs (1.3 em) exceed it, above and below', () => {
    expect(glyphOverhang(1)).toBeCloseTo(0.15);
    expect(glyphOverhang(1.12)).toBeCloseTo(0.09);
    expect(glyphOverhang(1.3)).toBe(0);
    expect(glyphOverhang(1.5)).toBe(0);
  });
});

describe('the accent', () => {
  it('marks the words the accent covers, even when it ends inside one', () => {
    const line = toWords({ text: 'Productos digitales y sesiones 1:1.', kind: 'framing', accent: 'sesiones 1:1' });
    expect(line.filter((w) => w.accent).map((w) => w.text)).toEqual(['sesiones', '1:1.']);
  });

  it('marks nothing when there is no accent or it is not in the line', () => {
    expect(toWords({ text: 'Cobrás todo.', kind: 'framing' }).some((w) => w.accent)).toBe(false);
    expect(toWords({ text: 'Cobrás todo.', kind: 'framing', accent: 'nada' }).some((w) => w.accent)).toBe(false);
  });
});

describe('the call to action pill', () => {
  const column = 760;

  it('sets a short call to action at the caption size', () => {
    expect(pillSize('Go', column, '9x16', perChar)).toBe(TYPE['9x16'].caption);
  });

  it('sets a longer one as large as fits the pill, padding included, in 96% of the column', () => {
    const size = pillSize('Start free', column, '9x16', perChar);
    expect(size).toBeLessThan(TYPE['9x16'].caption);
    // The pill is padded 1.1 em on each side.
    expect(size * perChar('Start free') + 2.2 * size).toBeLessThanOrEqual(0.96 * column);
  });

  it('never sets it below the smallest size of the format', () => {
    expect(pillSize('Create your online shop for free today', column, '9x16', perChar)).toBe(TYPE['9x16'].min);
  });
});
