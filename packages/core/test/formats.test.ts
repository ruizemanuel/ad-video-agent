import { describe, expect, it } from 'vitest';
import { FORMATS, PREFERRED_VIEWPORT, TYPE, safeWidth, type Format } from '../src/index';

const formats = Object.keys(FORMATS).sort() as Format[];

describe('formats', () => {
  it('describes the same formats everywhere', () => {
    expect(formats).toEqual(['16x9', '4x5', '9x16']);
    expect(Object.keys(TYPE).sort()).toEqual(formats);
    expect(Object.keys(PREFERRED_VIEWPORT).sort()).toEqual(formats);
  });

  it('leaves 860 px of width inside the 9:16 safe zone', () => expect(safeWidth('9x16')).toBe(860));

  it('never sets a headline smaller than the smallest legible text', () => {
    for (const f of formats) expect(TYPE[f].headline).toBeGreaterThan(TYPE[f].min);
  });
});
