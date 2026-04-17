import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createWorkspace, getWorkspaceByName } from '../engine/workspace.js';
import { createD1TestDb, FakeD1Database } from './fake-d1.js';

const TEST_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,
  system_prompt TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  metadata TEXT DEFAULT '{}'
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL
);

CREATE TABLE channels (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  channel_type INTEGER NOT NULL DEFAULT 0,
  topic TEXT,
  metadata TEXT DEFAULT '{}',
  created_by TEXT REFERENCES agents(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  is_archived INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX channels_workspace_name_unique ON channels(workspace_id, name);
`;

function hashApiKey(apiKey: string) {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

describe('createWorkspace (engine integration)', () => {
  let db: ReturnType<typeof createD1TestDb>['db'];
  let fakeD1: FakeD1Database;

  beforeEach(() => {
    const testDb = createD1TestDb(TEST_SCHEMA_SQL);
    db = testDb.db;
    fakeD1 = testDb.d1;
  });

  it('creates a new workspace and returns created: true', async () => {
    const result = await createWorkspace(db, 'my-project');

    expect(result.created).toBe(true);
    expect(result.workspace_id).toBeTruthy();
    expect(result.api_key).toMatch(/^rk_live_/);
    expect(result.created_at).toBeTruthy();
  });

  it('creates a #general channel for new workspaces', async () => {
    const result = await createWorkspace(db, 'my-project');

    const channels = fakeD1.sqlite
      .prepare('SELECT * FROM channels WHERE workspace_id = ?')
      .all(result.workspace_id) as Array<{ name: string }>;

    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe('general');
  });

  it('returns existing workspace when called with its own API key', async () => {
    const first = await createWorkspace(db, 'shared-name');

    // Second call with the workspace's own API key → idempotent return
    const second = await createWorkspace(db, 'shared-name', {
      ownerApiKey: first.api_key,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.workspace_id).toBe(first.workspace_id);
  });

  it('creates separate workspaces for same name from different owners', async () => {
    const first = await createWorkspace(db, 'shared-name');
    const second = await createWorkspace(db, 'shared-name');

    // Different generated API keys → different workspaces
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.workspace_id).not.toBe(first.workspace_id);
  });

  it('returns existing workspace using ownerApiKeyHash', async () => {
    const first = await createWorkspace(db, 'hash-test');
    const ownerApiKeyHash = hashApiKey(first.api_key);

    const second = await createWorkspace(db, 'hash-test', { ownerApiKeyHash });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.workspace_id).toBe(first.workspace_id);
  });

  it('creates new workspace without owner key (anonymous)', async () => {
    const first = await createWorkspace(db, 'anon-ws');
    const second = await createWorkspace(db, 'anon-ws');

    // Without owner key, no idempotency — both create new workspaces
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.workspace_id).not.toBe(first.workspace_id);
  });

  it('throws when ownerApiKey and ownerApiKeyHash conflict', async () => {
    await expect(
      createWorkspace(db, 'conflict-test', {
        ownerApiKey: 'rk_live_key_a',
        ownerApiKeyHash: hashApiKey('rk_live_key_b'),
      }),
    ).rejects.toThrow('ownerApiKeyHash must match');
  });
});

describe('getWorkspaceByName', () => {
  let db: ReturnType<typeof createD1TestDb>['db'];

  beforeEach(() => {
    db = createD1TestDb(TEST_SCHEMA_SQL).db;
  });

  it('returns workspace by name', async () => {
    await createWorkspace(db, 'find-me');

    const found = await getWorkspaceByName(db, 'find-me');
    expect(found).not.toBeNull();
    expect(found!.name).toBe('find-me');
  });

  it('returns null for non-existent workspace', async () => {
    const found = await getWorkspaceByName(db, 'does-not-exist');
    expect(found).toBeNull();
  });

  it('returns first match when multiple workspaces share the same name', async () => {
    await createWorkspace(db, 'duplicate', { ownerApiKey: 'rk_live_a' });
    await createWorkspace(db, 'duplicate', { ownerApiKey: 'rk_live_b' });

    const found = await getWorkspaceByName(db, 'duplicate');
    expect(found).not.toBeNull();
    expect(found!.name).toBe('duplicate');
  });
});
