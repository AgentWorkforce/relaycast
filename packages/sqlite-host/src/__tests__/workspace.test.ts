import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCredentialTagSigner } from '@relaycast/engine/gateway';
import { WorkspaceDatabase } from '../sql.js';
import { WalCursor, applySegment } from '../wal.js';
import { FileLogStore, type LogStore } from '../store.js';
import { FencedError, LoadedWorkspace, type WorkspaceOptions } from '../workspace.js';

const WORKSPACE_ID = '241764880589606912';
const TAGS = createCredentialTagSigner({ current: 'a', keys: { a: 'sqlite-host-test-tag-secret-0123456789' } });
const directories: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'sqlite-host-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function options(store: LogStore, overrides: Partial<WorkspaceOptions> = {}): WorkspaceOptions {
  return {
    workspaceId: WORKSPACE_ID,
    store,
    prefix: 'workspaces',
    dataDir: scratch(),
    config: {
      publicUrl: 'https://armadillo.test',
      fileSigningSecret: 'file-secret-of-at-least-32-characters',
      engine: { environment: 'test', maxUploadBytes: 1024 * 1024, retention: { messageTtlDays: null } },
    },
    baseEvery: 1000,
    durability: 'sync',
    log: () => undefined,
    onEvicted: () => undefined,
    ...overrides,
  };
}

function request(method: string, path: string, body?: unknown, token?: string) {
  const headers: [string, string][] = [['content-type', 'application/json']];
  if (token) headers.push(['authorization', `Bearer ${token}`]);
  return { method, url: `https://armadillo.test${path}`, headers, body: body === undefined ? null : JSON.stringify(body) };
}

async function call(workspace: LoadedWorkspace, method: string, path: string, body?: unknown, token?: string) {
  const response = await workspace.invoke('handle', [request(method, path, body, token)]) as { status: number; body: string };
  return { status: response.status, json: JSON.parse(response.body) as { data: Record<string, unknown> } };
}

async function seeded(store: LogStore, overrides: Partial<WorkspaceOptions> = {}) {
  const workspace = await LoadedWorkspace.load(options(store, overrides));
  const created = await workspace.invoke('create', [request('POST', '/v1/workspaces', { name: 'armadillo' }), await TAGS.tag(WORKSPACE_ID)]) as { status: number; body: string };
  expect(created.status).toBe(201);
  const key = (JSON.parse(created.body) as { data: { api_key: string } }).data.api_key;
  const alice = await call(workspace, 'POST', '/v1/agents', { name: 'alice' }, key);
  await call(workspace, 'POST', '/v1/agents', { name: 'bob' }, key);
  return { workspace, key, alice: alice.json.data.token as string };
}

async function messages(workspace: LoadedWorkspace, token: string): Promise<string[]> {
  const listed = await call(workspace, 'GET', '/v1/channels/general/messages', undefined, token);
  return (listed.json.data as unknown as { text: string }[]).map((message) => message.text).sort();
}

describe('WAL segments', () => {
  it('rebuild the database a commit at a time, across a checkpoint', () => {
    const directory = scratch();
    const db = new WorkspaceDatabase(join(directory, 'a.db'));
    const cursor = new WalCursor(join(directory, 'a.db-wal'));
    const replica = join(directory, 'b.db');
    const commit = (sql: string) => {
      db.raw.exec(`BEGIN IMMEDIATE; ${sql}; COMMIT`);
      const segment = cursor.take();
      expect(segment).not.toBeNull();
      applySegment(replica, segment!);
    };
    commit('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    for (let i = 0; i < 50; i++) commit(`INSERT INTO t (v) VALUES ('${'x'.repeat(200)}${i}')`);
    expect(cursor.take()).toBeNull();
    db.checkpoint();
    cursor.reset();
    commit("DELETE FROM t WHERE id % 2 = 0");
    commit("UPDATE t SET v = 'changed' WHERE id = 1");
    const expected = db.raw.prepare('SELECT * FROM t ORDER BY id').all();
    db.close();
    const rebuilt = new WorkspaceDatabase(replica);
    expect(rebuilt.raw.prepare('SELECT * FROM t ORDER BY id').all()).toEqual(expected);
    expect(rebuilt.raw.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    rebuilt.close();
  });
});

describe('a SQLite workspace on a commit log', () => {
  it('reloads every acknowledged write from the log on another host', async () => {
    const store = new FileLogStore(scratch());
    const { workspace, alice } = await seeded(store);
    for (const text of ['one', 'two', 'three']) expect((await call(workspace, 'POST', '/v1/channels/general/messages', { text }, alice)).status).toBe(201);
    workspace.evict('host killed');

    const moved = await LoadedWorkspace.load(options(store));
    expect(await messages(moved, alice)).toEqual(['one', 'three', 'two']);
  });

  it('starts from the newest base snapshot and replays only the slots after it', async () => {
    const store = new FileLogStore(scratch());
    const logged: Record<string, unknown>[] = [];
    const { workspace, alice } = await seeded(store, { baseEvery: 3 });
    for (let i = 0; i < 7; i++) await call(workspace, 'POST', '/v1/channels/general/messages', { text: `m${i}` }, alice);
    workspace.evict('host killed');
    const bases = await store.list(`workspaces/${WORKSPACE_ID}/base/`);
    expect(bases.length).toBeGreaterThan(1);

    const moved = await LoadedWorkspace.load(options(store, { log: (event) => logged.push(event) }));
    expect(await messages(moved, alice)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    const loaded = logged.find((event) => event.event === 'sqlite_workspace_loaded')!;
    expect(loaded.base).toBeGreaterThan(0);
    expect(loaded.slots_replayed).toBeLessThan(3);
  });

  it('fences a stale writer: it loses the slot, evicts itself, and the write lands nowhere', async () => {
    const store = new FileLogStore(scratch());
    const { workspace: stale, alice } = await seeded(store);
    const current = await LoadedWorkspace.load(options(store));
    expect((await call(current, 'POST', '/v1/channels/general/messages', { text: 'from the new owner' }, alice)).status).toBe(201);
    expect(await stale.superseded()).toBe(true);

    await expect(call(stale, 'POST', '/v1/channels/general/messages', { text: 'from the stale owner' }, alice)).rejects.toBeInstanceOf(FencedError);
    expect(stale.evicted).toBe(true);
    const reloaded = await LoadedWorkspace.load(options(store));
    expect(await messages(reloaded, alice)).toEqual(['from the new owner']);
  });

  it('holds socket writes until the commit is durable and drops them when it is not', async () => {
    const backing = new FileLogStore(scratch());
    let failWrites = false;
    const store: LogStore = {
      create: (key, body) => failWrites ? Promise.reject(new Error('Express unavailable')) : backing.create(key, body),
      put: (key, body) => backing.put(key, body),
      get: (key) => backing.get(key),
      list: (prefix) => backing.list(prefix),
    };
    const { workspace, alice } = await seeded(store);
    const sent: string[] = [];
    const observer = await call(workspace, 'POST', '/v1/observer-tokens', { name: 'tap', scopes: ['stream:read', 'messages:read'] }, alice);
    expect(observer.status).toBeLessThan(500);

    // Any socket write made inside a failing call never reaches the client.
    const connection = { send: (data: string) => sent.push(data), close: () => undefined };
    await workspace.connect({ not: 'a principal' }, connection).catch(() => undefined);
    failWrites = true;
    await expect(call(workspace, 'POST', '/v1/channels/general/messages', { text: 'never durable' }, alice)).rejects.toThrow('Express unavailable');
    expect(workspace.evicted).toBe(true);
    expect(sent.join('\n')).not.toContain('never durable');
    failWrites = false;
    const reloaded = await LoadedWorkspace.load(options(store));
    expect(await messages(reloaded, alice)).toEqual([]);
  });
  it('does not treat its own write, published while a fence probe was pending, as another writer', async () => {
    const backing = new FileLogStore(scratch());
    let release: (() => void) | undefined;
    let delayProbe = false;
    const store: LogStore = {
      create: (key, body) => backing.create(key, body),
      put: (key, body) => backing.put(key, body),
      get: async (key) => {
        if (delayProbe) {
          delayProbe = false;
          await new Promise<void>((resolve) => { release = resolve; });
        }
        return backing.get(key);
      },
      list: (prefix) => backing.list(prefix),
    };
    const { workspace, alice } = await seeded(store);
    delayProbe = true;
    const probe = workspace.superseded();
    expect((await call(workspace, 'POST', '/v1/channels/general/messages', { text: 'mine' }, alice)).status).toBe(201);
    release!();
    expect(await probe).toBe(false);
    expect(workspace.evicted).toBe(false);
  });
});
