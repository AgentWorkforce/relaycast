import { describe, expect, it } from 'vitest';
import { camelizeKeys, decamelizeKeys } from '../casing.js';

// User-authored JSON Schema with keys that must never be case-transformed:
// property names are data, and `additionalProperties` is a JSON-Schema keyword.
const schema = {
  type: 'object',
  properties: {
    batchSize: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
    person_id: { type: 'string' },
  },
  required: ['batchSize'],
  additionalProperties: false,
};

describe('casing transforms', () => {
  it('decamelizeKeys renames wire fields but passes schema subtrees verbatim', () => {
    const wire = decamelizeKeys({
      name: 'crm.get_person_batch',
      availableTo: ['worker'],
      inputSchema: schema,
      outputSchema: schema,
    }) as Record<string, unknown>;

    expect(Object.keys(wire)).toEqual(['name', 'available_to', 'input_schema', 'output_schema']);
    expect(wire.input_schema).toEqual(schema);
    expect(wire.output_schema).toEqual(schema);
  });

  it('camelizeKeys renames wire fields but passes schema subtrees verbatim', () => {
    const read = camelizeKeys({
      name: 'crm.get_person_batch',
      input_schema: schema,
      output_schema: schema,
    }) as { inputSchema: unknown; outputSchema: unknown };

    expect(read.inputSchema).toEqual(schema);
    expect(read.outputSchema).toEqual(schema);
  });

  it('a camelCase-keyed schema round-trips byte-identical through both transforms', () => {
    const sent = { inputSchema: schema };
    const wire = decamelizeKeys(sent);
    const read = camelizeKeys(wire) as { inputSchema: unknown };
    expect(JSON.stringify(read.inputSchema)).toBe(JSON.stringify(schema));
  });

  it('passes action invocation input/output payloads verbatim in both directions', () => {
    const input = { batchSize: 5, nested: { camelKey: true } };
    const output = { resultRows: [{ personId: 'p_1' }] };

    expect(decamelizeKeys({ input })).toEqual({ input });
    expect(decamelizeKeys({ output })).toEqual({ output });
    expect(camelizeKeys({ input, completed_at: 'x' })).toEqual({ input, completedAt: 'x' });
    expect(camelizeKeys({ output })).toEqual({ output });
  });

  it('passes headers maps verbatim in both directions', () => {
    const headers = { 'X-My-Header': 'v', authToken: 'a' };
    expect(decamelizeKeys({ headers })).toEqual({ headers });
    expect(camelizeKeys({ headers })).toEqual({ headers });
  });

  it('still transforms wire-protocol keys outside verbatim subtrees', () => {
    expect(decamelizeKeys({ durationMs: 5 })).toEqual({ duration_ms: 5 });
    expect(camelizeKeys({ created_at: 'x' })).toEqual({ createdAt: 'x' });
  });
});
