import { describe, expect, it } from 'vitest';
import {
  CreateWorkspaceRequestSchema, UpdateWorkspaceRequestSchema, WorkspaceMetadataSchema,
} from '../workspace.js';

describe('workspace metadata validation', () => {
  it('accepts descriptive JSON on creation and updates', () => {
    const metadata = { project: 'relay', config: { enabled: true, values: [1, null, 'x'] } };
    expect(CreateWorkspaceRequestSchema.parse({ name: 'example', metadata }).metadata).toEqual(metadata);
    expect(UpdateWorkspaceRequestSchema.parse({ metadata: { project: null } }).metadata).toEqual({ project: null });
  });

  it.each(['api_key', 'apiKey', 'APIKey', 'accessToken', 'client_secret', 'password',
    'authorization', 'credentials', 'private-key', '__proto__', 'constructor', 'prototype']) (
    'rejects nested secret or unsafe key %s', (key) => {
      expect(WorkspaceMetadataSchema.safeParse(JSON.parse(JSON.stringify({ [key]: 'value' }))).success).toBe(false);
      expect(WorkspaceMetadataSchema.safeParse({ config: JSON.parse(JSON.stringify({ [key]: 'value' })) }).success).toBe(false);
    },
  );

  it('rejects non-objects and non-JSON values', () => {
    for (const value of [null, [], 'x', { value: undefined }, { value: NaN }, { value: new Date() }]) {
      expect(WorkspaceMetadataSchema.safeParse(value).success).toBe(false);
    }
  });

  it('bounds UTF-8 bytes, key counts, key length, and depth', () => {
    expect(WorkspaceMetadataSchema.safeParse({ value: '🙂'.repeat(4096) }).success).toBe(false);
    expect(WorkspaceMetadataSchema.safeParse(Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, i]))).success).toBe(false);
    expect(WorkspaceMetadataSchema.safeParse({ ['k'.repeat(129)]: 1 }).success).toBe(false);
    let nested: unknown = 1;
    for (let i = 0; i < 9; i++) nested = { nested };
    expect(WorkspaceMetadataSchema.safeParse(nested).success).toBe(false);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(WorkspaceMetadataSchema.safeParse(circular).success).toBe(false);
  });
});
