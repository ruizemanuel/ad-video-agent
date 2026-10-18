// A small edit list, and the run folder a capture leaves, for the tests of the tasks that render.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Edl, Scene } from '@app/core';

const framing = (text: string) => ({ text, kind: 'framing' as const });
const scene = (piece: Scene['piece'], beats: number, text: string): Scene => ({ piece, beats, lines: [framing(text)] });

/** 14 beats at 120 bpm: 7 seconds, 210 frames. */
export const fixtureEdl = (): Edl => ({
  lang: 'en',
  bpm: 120,
  style: { energy: 'bold', density: 'airy' },
  hooks: [[scene('KineticHeadline', 4, 'Sell with no fees')]],
  body: [scene('ClaimStack', 6, 'One link')],
  cta: { ...scene('EndCard', 4, 'Start free'), transitionIn: 'wipe' },
  claims: [],
  musicPrompt: 'upbeat',
});

export const FIXTURE_SECONDS = 7;
export const FIXTURE_FRAMES = 210;

/** A site, as little as `site.json` can hold. */
export const fixtureSite = () => ({ url: 'https://x.example/', lang: 'en', title: 'X', description: '', sections: [], brand: { colors: [], fonts: [] }, shots: [], boxes: [], recordings: [] });

/** Writes the site.json a capture leaves in `runDir`. */
export function writeCapturedSite(runDir: string): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'site.json'), JSON.stringify(fixtureSite()));
}
