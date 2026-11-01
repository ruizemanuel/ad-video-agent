import { describe, expect, it } from 'vitest';
import { pointSeries, type PieceName, type Scene } from '../src/index';

const scenesOf = (...pieces: PieceName[]): Scene[] => pieces.map((piece) => ({ piece, beats: 4, lines: [] }));

describe('pointSeries', () => {
  it('numbers each run of consecutive PointCards', () =>
    expect(pointSeries(scenesOf('ClaimStack', 'PointCard', 'PointCard', 'UiFocus', 'PointCard', 'PointCard', 'PointCard'))).toEqual([
      undefined,
      { at: 1, of: 2, first: 1 },
      { at: 2, of: 2, first: 1 },
      undefined,
      { at: 1, of: 3, first: 4 },
      { at: 2, of: 3, first: 4 },
      { at: 3, of: 3, first: 4 },
    ]));

  it('makes a lone card a series of one', () => expect(pointSeries(scenesOf('PointCard'))).toEqual([{ at: 1, of: 1, first: 0 }]));
});
