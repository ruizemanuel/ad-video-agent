import { describe, expect, it } from 'vitest';
import * as core from '../src/index';
// Type-only imports: `pnpm typecheck` fails here if the package stops exporting one of them.
import type { Box, Claim, Edl, Format, Line, PieceName, Scene, Shot, SiteData, SiteFont, TimedScene } from '../src/index';

export type PublicTypes = [Box, Claim, Edl, Format, Line, PieceName, Scene, Shot, SiteData, SiteFont, TimedScene];

describe('@app/core public surface', () => {
  it('exports what the other packages build on', () => {
    expect(Object.keys(core)).toEqual(
      expect.arrayContaining([
        'ClaimSchema',
        'EdlSchema',
        'FORMATS',
        'FPS',
        'LineSchema',
        'MIN_CONTRAST',
        'PIECES',
        'PREFERRED_VIEWPORT',
        'SceneSchema',
        'TYPE',
        'WIPE_FRAMES',
        'beatsToFrames',
        'contrast',
        'layoutScenes',
        'retimeForBpm',
        'settledFrame',
        'theme',
      ]),
    );
  });
});
