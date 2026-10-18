import { describe, expect, it } from 'vitest';
import * as core from '../src/index';
// Type-only imports: `pnpm typecheck` fails here if the package stops exporting one of them.
import type {
  BannedPhrases,
  Box,
  Claim,
  Edl,
  Format,
  FramingItem,
  JudgeItem,
  Line,
  PieceName,
  Problem,
  RejectReason,
  Scene,
  ScenePatch,
  Shot,
  SiteData,
  SiteFont,
  TimedScene,
  TrackChoice,
  TrackMeasure,
  Wav,
} from '../src/index';

export type PublicTypes = [
  BannedPhrases,
  Box,
  Claim,
  Edl,
  Format,
  FramingItem,
  JudgeItem,
  Line,
  PieceName,
  Problem,
  RejectReason,
  Scene,
  ScenePatch,
  Shot,
  SiteData,
  SiteFont,
  TimedScene,
  TrackChoice,
  TrackMeasure,
  Wav,
];

describe('@app/core public surface', () => {
  it('exports what the other packages build on', () => {
    expect(Object.keys(core)).toEqual(
      expect.arrayContaining([
        'BANNED_PHRASES',
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
        'applyPatches',
        'beatsToFrames',
        'chooseTrack',
        'contrast',
        'judgeItems',
        'layoutScenes',
        'measureTrack',
        'musicPrompt',
        'parseWav',
        'retimeForBpm',
        'scenePaths',
        'settledFrame',
        'theme',
        'validateEdl',
      ]),
    );
  });
});
