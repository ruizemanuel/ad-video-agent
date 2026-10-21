// The pieces animate their text with the timing core checks the edit list against (see textWindows): these tests pin
// what a piece really draws to the constant core reads, so that the render and the reading check cannot drift apart.
import { CAPTION_SWAP, FPS, REVEAL_FRAMES } from '@app/core';
import { describe, expect, it } from 'vitest';
import { captionFade, revealDrop } from '../src/video/pieces/common';

describe('a line revealed through its mask', () => {
  it('is in place REVEAL_FRAMES frames after it starts to rise, and not before', () => {
    expect(revealDrop(10, 10, FPS)).toBe(1);
    expect(revealDrop(10 + REVEAL_FRAMES, 10, FPS)).toBeLessThan(0.005);
    expect(revealDrop(10 + REVEAL_FRAMES - 4, 10, FPS)).toBeGreaterThan(0.005);
  });
});

describe('a caption replaced on its beat', () => {
  const swap = 60;

  it('has the caption that goes out within CAPTION_SWAP.out frames of the beat', () => {
    expect(captionFade(swap, swap).out).toBe(0);
    expect(captionFade(swap + CAPTION_SWAP.out - 1, swap).out).toBeLessThan(1);
    expect(captionFade(swap + CAPTION_SWAP.out, swap).out).toBe(1);
  });

  it('has the caption that comes in from CAPTION_SWAP.in.from to CAPTION_SWAP.in.to frames after the beat', () => {
    expect(captionFade(swap + CAPTION_SWAP.in.from, swap).come).toBe(0);
    expect(captionFade(swap + CAPTION_SWAP.in.to - 1, swap).come).toBeLessThan(1);
    expect(captionFade(swap + CAPTION_SWAP.in.to, swap).come).toBe(1);
  });

  it('shows the first caption alone when nothing replaces it', () => expect(captionFade(200, undefined)).toEqual({ out: 0, come: 0 }));
});
