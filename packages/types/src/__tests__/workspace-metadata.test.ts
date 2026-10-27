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

  it('allows the owner-written Cloud analytics labels required by workspace provisioning', () => {
    const metadata = { cloud_org_id: 'org_123', cloud_workspace_id: 'ws_456' };
    expect(CreateWorkspaceRequestSchema.parse({ name: 'cloud-workspace', metadata }).metadata).toEqual(metadata);
    expect(UpdateWorkspaceRequestSchema.parse({ metadata }).metadata).toEqual(metadata);
    expect(UpdateWorkspaceRequestSchema.parse({ metadata: { cloud_org_id: null, cloud_workspace_id: null } }).metadata)
      .toEqual({ cloud_org_id: null, cloud_workspace_id: null });
  });

  it.each(['api_key', 'apiKey', 'APIKey', 'accessToken', 'client_secret', 'password',
    'authorization', 'credentials', 'private-key', '__proto__', 'constructor', 'prototype',
    'accesstoken', 'secretkey', 'clientsecret', 'apitoken', 'passwordhash', 'refreshtoken',
    'sessiontoken', 'appsecret', 'PASSWORDHASH', 'service_accesstoken', 'service-clientsecret']) (
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

  it('allows ordinary labels resembling parts of credential names', () => {
    const metadata = { tokenizer: 'v1', secretariat: 'team', passwordless: true, monkey: 'mascot', keyboard: 'en' };
    expect(WorkspaceMetadataSchema.parse(metadata)).toEqual(metadata);
  });

  it.each(['x', '🙂'])('counts key length in Unicode code points: %s', (character) => {
    const metadata = { [character.repeat(128)]: 1 };
    expect(WorkspaceMetadataSchema.parse(metadata)).toEqual(metadata);
    expect(WorkspaceMetadataSchema.safeParse({ [character.repeat(129)]: 1 }).success).toBe(false);
    expect(WorkspaceMetadataSchema.safeParse({ nested: { [character.repeat(129)]: 1 } }).success).toBe(false);
  });

  it.each([
    { label: 'empty object', leaf: {}, kind: 'object' },
    { label: 'object with primitive', leaf: { value: 1 }, kind: 'object' },
    { label: 'empty array', leaf: [], kind: 'array' },
    { label: 'array with primitive', leaf: [null, true, 1, 'value'], kind: 'array' },
  ])('allows eight nested container levels and rejects nine: $label', ({ leaf, kind }) => {
    function nestedContainers(levels: number): Record<string, unknown> {
      let nested: unknown = leaf;
      for (let i = 1; i < levels; i++) nested = kind === 'array' ? [nested] : { nested };
      return { nested };
    }
    expect(WorkspaceMetadataSchema.safeParse(nestedContainers(8)).success).toBe(true);
    expect(WorkspaceMetadataSchema.safeParse(nestedContainers(9)).success).toBe(false);
  });

  it('counts mixed array/object nesting together', () => {
    let nested: unknown = { value: 1 };
    for (let i = 1; i < 8; i++) nested = i % 2 ? [nested] : { nested };
    expect(WorkspaceMetadataSchema.safeParse({ nested }).success).toBe(true);
    expect(WorkspaceMetadataSchema.safeParse({ nested: [nested] }).success).toBe(false);
  });

  it('bounds UTF-8 bytes, key counts, and cycles', () => {
    expect(WorkspaceMetadataSchema.safeParse({ value: '🙂'.repeat(4096) }).success).toBe(false);
    expect(WorkspaceMetadataSchema.safeParse(Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, i]))).success).toBe(false);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(WorkspaceMetadataSchema.safeParse(circular).success).toBe(false);
  });
});
