import { describe, expect, it } from 'vitest';
import { OrderRequestSchema } from '../src/index';

describe('OrderRequestSchema', () => {
  it('accepts a bare url and defaults the audio to music', () => {
    expect(OrderRequestSchema.parse({ url: 'https://example.com' })).toEqual({ url: 'https://example.com', audio: 'music' });
  });

  it('trims the brief', () => {
    expect(OrderRequestSchema.parse({ url: 'https://example.com', brief: '  Launch week  ' }).brief).toBe('Launch week');
  });

  it('keeps the extra urls and the chosen audio', () => {
    const request = OrderRequestSchema.parse({ url: 'https://example.com', extraUrls: ['https://example.com/app'], audio: 'none' });
    expect(request).toMatchObject({ extraUrls: ['https://example.com/app'], audio: 'none' });
  });

  it.each([
    ['a url that is not one', { url: 'nope' }],
    ['a missing url', {}],
    ['a url over 2048 characters', { url: `https://example.com/${'a'.repeat(2048)}` }],
    ['a brief over 200 characters', { url: 'https://example.com', brief: 'a'.repeat(201) }],
    ['more than 3 extra urls', { url: 'https://example.com', extraUrls: Array.from({ length: 4 }, (_, i) => `https://example.com/${i}`) }],
    ['an extra url that is not one', { url: 'https://example.com', extraUrls: ['nope'] }],
    ['an unknown audio', { url: 'https://example.com', audio: 'loud' }],
  ])('rejects %s', (_label, body) => {
    expect(OrderRequestSchema.safeParse(body).success).toBe(false);
  });

  it('measures the brief after trimming it', () => {
    expect(OrderRequestSchema.safeParse({ url: 'https://example.com', brief: `  ${'a'.repeat(200)}  ` }).success).toBe(true);
  });
});
