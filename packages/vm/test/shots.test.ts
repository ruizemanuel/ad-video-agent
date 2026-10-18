import type { Shot } from '@app/core';
import { describe, expect, it } from 'vitest';
import { buildDirectorJpegArgs, shotsForDirector } from '../src/capture/shots';

const shot = (id: string, viewport: Shot['viewport'], sectionId?: string): Shot => ({
  id,
  file: `media/${id}.png`,
  viewport,
  dpr: 2,
  ...(sectionId ? { sectionId } : {}),
  width: 780,
  height: 1688,
});

describe('the pictures for the director', () => {
  it('are the shots of the phone, of the main page and of the extra pages, but not the full-page ones', () => {
    const shots = [
      shot('d-s2', 'desktop', 's2'),
      shot('d-full', 'desktop'),
      shot('m-s2', 'mobile', 's2'),
      shot('m-s3', 'mobile', 's3'),
      shot('m-full', 'mobile'),
      shot('x1-d-s12', 'desktop', 's12'),
      shot('x1-m-s12', 'mobile', 's12'),
      shot('x1-m-full', 'mobile'),
    ];

    expect(shotsForDirector(shots).map((s) => s.id)).toEqual(['m-s2', 'm-s3', 'x1-m-s12']);
  });

  it('are scaled to 480 px wide, as JPEG quality 4', () => {
    expect(buildDirectorJpegArgs('run/media/m-s2.png', 'run/director/m-s2.jpg')).toEqual([
      '-v', 'error', '-y', '-i', 'run/media/m-s2.png', '-vf', 'scale=480:-1', '-q:v', '4', 'run/director/m-s2.jpg',
    ]);
  });
});
