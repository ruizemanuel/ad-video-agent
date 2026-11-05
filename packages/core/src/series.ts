// The cards of a video: two or three PointCards in a row are one series, which the renderer sets as one set (its titles
// at one size, its text at one height), whatever the director cuts.
import type { Scene } from './edl';

/** Where a PointCard stands in its series: card `at` (from 1) of `of`, the series starting at index `first` of the list. */
export type SeriesPlace = { at: number; of: number; first: number };

/** For each scene, its place in the run of consecutive PointCards it belongs to (a series); undefined for any other piece. */
export const pointSeries = (scenes: readonly Scene[]): (SeriesPlace | undefined)[] => {
  const places: (SeriesPlace | undefined)[] = [];
  for (let first = 0; first < scenes.length; ) {
    if (scenes[first]?.piece !== 'PointCard') {
      places.push(undefined);
      first++;
      continue;
    }
    let of = 1;
    while (scenes[first + of]?.piece === 'PointCard') of++;
    for (let at = 1; at <= of; at++) places.push({ at, of, first });
    first += of;
  }
  return places;
};
