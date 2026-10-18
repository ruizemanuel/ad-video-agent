// The schema a model is asked to answer with. Providers commonly reject some JSON Schema keywords in structured output
// (numeric, string and array bounds, patterns, formats), and a request they reject would fail every order. So the model
// is sent the zod schema's JSON Schema without them (descriptions, types, enums and required fields stay: they guide it),
// and its answer is then checked against the whole zod schema, bounds included.
import { jsonSchema, type JSONSchema7, type Schema } from 'ai';
import { z } from 'zod';

const BOUNDS = [
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minimum',
  'maximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'pattern',
  'format',
] as const;

type Definition = JSONSchema7 | boolean;
type Definitions = Record<string, Definition>;

const visit = (definition: Definition): Definition => (typeof definition === 'boolean' ? definition : providerSafeSchema(definition));
const visitMap = (definitions: Definitions): Definitions => Object.fromEntries(Object.entries(definitions).map(([key, d]) => [key, visit(d)]));

/**
 * The schema without the bound keywords, at every depth, and with every object closed to other properties (as the AI SDK
 * does for a zod schema). The schema it is given is left as it was.
 */
export function providerSafeSchema(schema: JSONSchema7): JSONSchema7 {
  const safe: JSONSchema7 = { ...schema };
  for (const keyword of BOUNDS) delete safe[keyword];

  // The keywords whose value is a map of schemas (by property or definition name).
  if (schema.properties) safe.properties = visitMap(schema.properties);
  if (schema.patternProperties) safe.patternProperties = visitMap(schema.patternProperties);
  if (schema.definitions) safe.definitions = visitMap(schema.definitions);
  if (schema.$defs) safe.$defs = visitMap(schema.$defs);
  // The keywords whose value is a schema, or a list of them.
  if (schema.items !== undefined) safe.items = Array.isArray(schema.items) ? schema.items.map(visit) : visit(schema.items);
  if (schema.allOf) safe.allOf = schema.allOf.map(visit);
  if (schema.anyOf) safe.anyOf = schema.anyOf.map(visit);
  if (schema.oneOf) safe.oneOf = schema.oneOf.map(visit);
  for (const keyword of ['additionalItems', 'contains', 'additionalProperties', 'propertyNames', 'if', 'then', 'else', 'not'] as const) {
    const value = schema[keyword];
    if (value !== undefined) safe[keyword] = visit(value);
  }

  const isObject = schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object'));
  if (isObject && safe.additionalProperties === undefined) safe.additionalProperties = false;
  return safe;
}

/** What a model is asked for: the provider-safe JSON Schema of `schema`, with the answer checked against all of `schema`. */
export function modelSchema<T>(schema: z.ZodType<T>): Schema<T> {
  return jsonSchema<T>(
    // The same conversion the AI SDK makes of a zod schema, made only when the schema is first sent.
    () => providerSafeSchema(z.toJSONSchema(schema, { target: 'draft-7', io: 'input', reused: 'inline' }) as JSONSchema7),
    {
      validate: (value) => {
        const result = schema.safeParse(value);
        return result.success ? { success: true, value: result.data } : { success: false, error: result.error };
      },
    },
  );
}
