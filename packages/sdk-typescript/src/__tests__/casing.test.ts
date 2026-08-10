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

// A signed document is the strictest case: it must survive a round trip
// byte-for-byte or its signature stops verifying. Wire field names here are
// snake_case by protocol, not by convention, and camelizing them destroys the
// signable bytes.
const signedRevocationList = {
  revoked_certs: ['cert-a', 'cert-b'],
  issued_at: 1754870400,
  issuer_pub_key: { ed25519: 'AAA', ml_dsa_65: 'BBB' },
  signature: { ed25519: 'CCC', ml_dsa_65: 'DDD' },
};

describe('casing transforms', () => {
  it('passes message data and metadata through verbatim in both directions', () => {
    const wire = decamelizeKeys({
      to: 'agent-b',
      text: 'work',
      data: signedRevocationList,
    }) as Record<string, unknown>;
    expect(wire.data).toEqual(signedRevocationList);

    const read = camelizeKeys({
      thread_id: 't1',
      metadata: signedRevocationList,
    }) as { threadId: string; metadata: unknown };
    expect(read.threadId).toBe('t1');
    expect(read.metadata).toEqual(signedRevocationList);
  });

  it('a signed payload round-trips byte-identical through both transforms', () => {
    // The regression this guards: revoked_certs arriving as revokedCerts means
    // the list cannot be reconstructed, its signature fails, and a
    // cross-deployment revocation is rejected for the wrong reason.
    const sent = { data: signedRevocationList };
    const read = camelizeKeys(decamelizeKeys(sent)) as { data: unknown };
    expect(JSON.stringify(read.data)).toBe(JSON.stringify(signedRevocationList));
  });


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
