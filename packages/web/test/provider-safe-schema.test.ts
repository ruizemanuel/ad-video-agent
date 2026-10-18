import type { JSONSchema7 } from 'ai';
import { describe, expect, it } from 'vitest';
import { EdlSchema } from '@app/core';
import { modelSchema, providerSafeSchema } from '../src/adapters/real/provider-safe-schema';
import { edlShop } from './support/shop';

// The keywords providers commonly reject in a structured-output schema.
const BOUNDS = ['exclusiveMinimum', 'exclusiveMaximum', 'minimum', 'maximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'format'];
const bounded = { exclusiveMinimum: 0, exclusiveMaximum: 9, minimum: 1, maximum: 8, multipleOf: 1, minLength: 1, maxLength: 9, minItems: 1, maxItems: 9, pattern: '^a', format: 'uri' };
// Every keyword a schema node of the JSON Schema says, anywhere in it (property names are not keywords).
const keywordsOf = (node: unknown): string[] => {
  if (Array.isArray(node)) return node.flatMap(keywordsOf);
  if (typeof node !== 'object' || node === null) return [];
  return Object.entries(node).flatMap(([key, value]) =>
    key === 'properties' ? Object.values(value as object).flatMap(keywordsOf) : [key, ...keywordsOf(value)],
  );
};

describe('providerSafeSchema', () => {
  it('drops every bound keyword, at the top, in nested objects, in array items and in anyOf, allOf and oneOf', () => {
    const schema: JSONSchema7 = {
      type: 'object',
      ...bounded,
      properties: {
        n: { type: 'number', ...bounded },
        nested: { type: 'object', properties: { deep: { type: 'string', ...bounded } } },
        list: { type: 'array', ...bounded, items: { type: 'integer', ...bounded } },
        tuple: { type: 'array', items: [{ type: 'string', ...bounded }] },
        either: { anyOf: [{ type: 'string', ...bounded }, { type: 'number', ...bounded }] },
        both: { allOf: [{ type: 'string', ...bounded }] },
        one: { oneOf: [{ type: 'string', ...bounded }] },
        map: { type: 'object', additionalProperties: { type: 'number', ...bounded } },
      },
    };
    const kept = keywordsOf(providerSafeSchema(schema));
    for (const keyword of BOUNDS) expect(kept).not.toContain(keyword);
  });

  it('keeps the type, the descriptions, the required fields and the enums', () => {
    const schema: JSONSchema7 = {
      type: 'object',
      description: 'An ad.',
      required: ['kind'],
      properties: { kind: { type: 'string', enum: ['claim', 'framing'], description: 'What the line is.', minLength: 1 } },
    };
    expect(providerSafeSchema(schema)).toEqual({
      type: 'object',
      description: 'An ad.',
      required: ['kind'],
      additionalProperties: false,
      properties: { kind: { type: 'string', enum: ['claim', 'framing'], description: 'What the line is.' } },
    });
  });

  it('keeps a property whose name is a keyword', () => {
    const schema: JSONSchema7 = { type: 'object', properties: { pattern: { type: 'string' }, minimum: { type: 'number', minimum: 0 } } };
    expect(providerSafeSchema(schema).properties).toEqual({ pattern: { type: 'string' }, minimum: { type: 'number' } });
  });

  it('closes every object to other properties, as the AI SDK does for a zod schema', () => {
    const schema: JSONSchema7 = { type: 'object', properties: { inner: { type: 'object', properties: {} } } };
    expect(providerSafeSchema(schema)).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: { inner: { type: 'object', properties: {}, additionalProperties: false } },
    });
  });

  it('leaves the schema it was given as it was', () => {
    const schema: JSONSchema7 = { type: 'object', properties: { n: { type: 'number', minimum: 0 } } };
    providerSafeSchema(schema);
    expect(schema).toEqual({ type: 'object', properties: { n: { type: 'number', minimum: 0 } } });
  });
});

describe('modelSchema', () => {
  const edl = modelSchema(EdlSchema);
  const validate = (value: unknown) => {
    if (!edl.validate) throw new Error('no validate');
    return edl.validate(value);
  };

  it('sends the edit list schema with no bound keyword, and with its descriptions', async () => {
    const sent = await edl.jsonSchema;
    const kept = keywordsOf(sent);
    for (const keyword of BOUNDS) expect(kept).not.toContain(keyword);
    expect(JSON.stringify(sent)).toContain(EdlSchema.shape.hooks.description);
    expect(sent.required).toEqual(expect.arrayContaining(['lang', 'bpm', 'hooks', 'body', 'cta', 'claims']));
  });

  it('checks the answer against the whole zod schema, bounds included', async () => {
    expect(await validate(edlShop())).toEqual({ success: true, value: edlShop() });
    expect(await validate({ ...edlShop(), bpm: 0 })).toMatchObject({ success: false });
    expect(await validate({ ...edlShop(), body: [{ ...edlShop().body[0], beats: 2.5 }] })).toMatchObject({ success: false });
  });
});
