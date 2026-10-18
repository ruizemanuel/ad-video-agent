import { describe, expect, it } from 'vitest';
import { ClaimSchema, EdlSchema, LineSchema, PIECES, SceneSchema } from '../src/index';
import edlShop from './fixtures/edl-shop.json';

describe('EDL contract', () => {
  it('accepts the shop EDL', () => expect(EdlSchema.parse(edlShop).hooks).toHaveLength(3));

  it('knows the 2a pieces', () =>
    expect(PIECES).toEqual(['KineticHeadline', 'UiFocus', 'UiScroll', 'ClaimStack', 'WordCycle', 'TypeIn', 'EndCard']));

  it('rejects an unknown piece', () => expect(() => SceneSchema.parse({ ...edlShop.body[0], piece: 'Orbit' })).toThrow());

  it('has no post field', () => expect('post' in EdlSchema.shape).toBe(false));

  it('accepts atBeat on a line and variant on a TypeIn scene', () => {
    expect(LineSchema.parse({ text: 'x', kind: 'framing', atBeat: 2 }).atBeat).toBe(2);
    expect(SceneSchema.parse({ piece: 'TypeIn', beats: 3, variant: 'url', lines: [{ text: 'tiendita.example', kind: 'framing' }] }).variant).toBe('url');
  });

  it('rejects a TypeIn variant other than url or prompt', () =>
    expect(() => SceneSchema.parse({ piece: 'TypeIn', beats: 3, variant: 'voice', lines: [] })).toThrow());

  it('rejects an atBeat that is not a whole beat', () => expect(() => LineSchema.parse({ text: 'x', kind: 'framing', atBeat: 1.5 })).toThrow());

  it('rejects a scene whose length is not a whole number of beats', () =>
    expect(() => SceneSchema.parse({ ...edlShop.body[0], beats: 2.5 })).toThrow());

  it('rejects a line kind other than claim or framing', () => expect(() => LineSchema.parse({ text: 'x', kind: 'slogan' })).toThrow());

  it('requires a verbatim quote and a section on every claim', () => {
    expect(() => ClaimSchema.parse({ id: 'c1', text: 'x', sectionId: 's1' })).toThrow();
    expect(ClaimSchema.parse({ id: 'c1', text: 'x', sectionId: 's1', quote: 'x' }).quote).toBe('x');
  });

  it('tells the director that hooks[0] is the main version', () =>
    expect(EdlSchema.shape.hooks.description).toContain('three hooks, strongest first; hooks[0] is the main version'));
});
