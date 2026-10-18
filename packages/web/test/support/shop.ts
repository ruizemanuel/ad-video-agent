// The shop of the core tests: a site and an edit list that passes every code check against it (core's validate tests
// keep it so). Read from core's fixtures, so there is one copy of each.
import { readFileSync } from 'node:fs';
import { EdlSchema, type CaptureFile, type Edl, type SiteData } from '@app/core';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../../core/test/fixtures/${name}`, import.meta.url), 'utf8'));

export const siteShop = (): SiteData => fixture('site-shop.json') as SiteData;
export const edlShop = (): Edl => EdlSchema.parse(fixture('edl-shop.json'));

/** What the capture leaves for the director: the site and a small picture of each phone shot. */
export const captureShop = (): CaptureFile => ({
  site: siteShop(),
  directorImages: [
    { shotId: 's1-mobile', jpegBase64: '/9j/AAAA' },
    { shotId: 's4-mobile', jpegBase64: '/9j/BBBB' },
  ],
});
