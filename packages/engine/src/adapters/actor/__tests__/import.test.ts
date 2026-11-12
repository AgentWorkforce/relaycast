import { describe, expect, it } from 'vitest';
import { migrationPlan } from '../../migration/plan.js';
import { blockDigest, normalizeValue, tableDigest, type MigrationRow, type TableDigest } from '../../migration/rows.js';
import { FakeWorkspaceActor, jsonRequest } from './fakeActor.js';

const WORKSPACE_ID = '241764880589606913';
const RUN = 'run-0001-import';

interface Envelope<T> { ok: boolean; data: T; error?: { code: string; message: string; details?: unknown } }

async function call<T>(actor: FakeWorkspaceActor, method: string, path: string, body?: unknown, token?: string) {
  const response = await actor.handle(jsonRequest(method, path, body, token));
  return { status: response.status, json: (response.body ? JSON.parse(response.body) : null) as Envelope<T> };
}

async function step<T>(actor: FakeWorkspaceActor, body: unknown) {
  const response = await actor.importData(body);
  return { status: response.status, json: JSON.parse(response.body) as Envelope<T> };
}

/** A workspace with history in every common shape: channels, threads, reactions, DMs, receipts, files, webhooks. */
async function seededSource() {
  const source = new FakeWorkspaceActor(WORKSPACE_ID);
  const created = await call<{ api_key: string }>(source, 'POST', '/v1/workspaces', { name: 'armadillo' });
  expect(created.status).toBe(201);
  const key = created.json.data.api_key;
  const tokens: Record<string, string> = {};
  for (const name of ['alice', 'bob', 'carol']) {
    const agent = await call<{ token: string }>(source, 'POST', '/v1/agents', { name }, key);
    expect(agent.status).toBe(201);
    tokens[name] = agent.json.data.token;
  }
  expect((await call(source, 'POST', '/v1/channels', { name: 'ops' }, tokens.alice)).status).toBe(201);
  for (const name of ['bob', 'carol']) expect((await call(source, 'POST', '/v1/channels/ops/join', {}, tokens[name])).status).toBe(200);
  const ids: string[] = [];
  for (let i = 0; i < 30; i += 1) {
    const author = ['alice', 'bob', 'carol'][i % 3]!;
    const posted = await call<{ id: string }>(source, 'POST', '/v1/channels/ops/messages', { text: `ops message ${i}` }, tokens[author]);
    expect(posted.status).toBe(201);
    ids.push(posted.json.data.id);
  }
  expect((await call(source, 'POST', `/v1/messages/${ids[3]}/replies`, { text: 'threaded reply' }, tokens.bob)).status).toBe(201);
  expect((await call(source, 'POST', `/v1/messages/${ids[4]}/reactions`, { emoji: 'tada' }, tokens.carol)).status).toBe(201);
  expect((await call(source, 'POST', `/v1/messages/${ids[5]}/read`, {}, tokens.bob)).status).toBeLessThan(300);
  for (let i = 0; i < 5; i += 1) {
    expect((await call(source, 'POST', '/v1/dm', { to: 'bob', text: `dm ${i}` }, tokens.alice)).status).toBe(201);
  }
  expect((await call(source, 'POST', '/v1/files/upload', { filename: 'notes.txt', content_type: 'text/plain', size_bytes: 5 }, tokens.alice)).status).toBe(201);
  expect((await call(source, 'POST', '/v1/webhooks', { name: 'ci', channel: 'ops' }, key)).status).toBe(201);
  expect((await call(source, 'POST', '/v1/subscriptions', { events: ['message.created'], url: 'https://hooks.example.com/relay' }, key)).status).toBe(201);
  return { source, key, tokens, ids };
}

/** What `relaycast-engine export-for-actors` produces, read from a SQLite source in the same wire form. */
async function exportFrom(source: FakeWorkspaceActor, blockRows = 7) {
  const tables = migrationPlan().map((table) => ({ name: table.name, columns: [...table.columns] }));
  const blocks: { table: string; seq: number; rows: MigrationRow[] }[] = [];
  const manifest: Record<string, TableDigest> = {};
  for (const table of migrationPlan()) {
    const stmt = source.sql.raw.prepare(
      `SELECT rowid, ${table.columns.map((column) => `"${column}"`).join(', ')} FROM "${table.name}" ORDER BY rowid`,
    ).raw(true);
    const rows = (stmt.all() as unknown[][]).map((row) =>
      row.map((value, index) => normalizeValue(table.name, String(index), value)) as MigrationRow);
    const digests: string[] = [];
    for (let i = 0, seq = 0; i < rows.length; i += blockRows, seq += 1) {
      const block = rows.slice(i, i + blockRows);
      blocks.push({ table: table.name, seq, rows: block });
      digests.push(await blockDigest(block));
    }
    manifest[table.name] = await tableDigest(digests, rows.length);
  }
  return { tables, blocks, manifest };
}

async function importAll(target: FakeWorkspaceActor, exported: Awaited<ReturnType<typeof exportFrom>>) {
  expect((await step(target, { op: 'begin', run_id: RUN, tables: exported.tables })).status).toBe(201);
  for (const block of exported.blocks) {
    const sent = await step<{ sha256: string }>(target, { op: 'chunk', run_id: RUN, table: block.table, seq: block.seq, rows: block.rows });
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
    expect(sent.json.data.sha256).toBe(await blockDigest(block.rows));
  }
  return step<{ status: string; tables: Record<string, TableDigest> }>(target, { op: 'finish', run_id: RUN, manifest: exported.manifest });
}

describe('workspace actor import', () => {
  it('copies a workspace under the same id with identical rows, and its credentials and history keep working', async () => {
    const { source, key, tokens, ids } = await seededSource();
    const exported = await exportFrom(source);
    expect(exported.manifest.messages!.count).toBeGreaterThan(30);

    const target = new FakeWorkspaceActor(WORKSPACE_ID);
    const finished = await importAll(target, exported);
    expect(finished.status, JSON.stringify(finished.json)).toBe(200);
    expect(finished.json.data.tables).toEqual(exported.manifest);

    // The source's credentials authenticate on the target: same hashes, same routing tag.
    for (const path of ['/v1/channels', '/v1/channels/ops/messages?limit=50', `/v1/messages/${ids[3]}/replies`, '/v1/inbox', '/v1/dm/conversations']) {
      const before = await call(source, 'GET', path, undefined, tokens.bob);
      const after = await call(target, 'GET', path, undefined, tokens.bob);
      expect(before.status, path).toBe(200);
      expect(after.status, path).toBe(200);
      expect(after.json, path).toEqual(before.json);
    }
    const agents = await call<{ name: string }[]>(target, 'GET', '/v1/agents', undefined, key);
    expect(agents.status).toBe(200);
    expect(agents.json).toEqual((await call(source, 'GET', '/v1/agents', undefined, key)).json);
    expect(agents.json.data.map((agent) => agent.name)).toEqual(expect.arrayContaining(['alice', 'bob', 'carol']));
    const search = await call<{ text: string }[]>(target, 'GET', '/v1/search?q=threaded', undefined, tokens.alice);
    expect(search.json.data.map((hit) => hit.text)).toContain('threaded reply');

    // New writes continue the copied sequences.
    const posted = await call<{ id: string }>(target, 'POST', '/v1/channels/ops/messages', { text: 'after the move' }, tokens.carol);
    expect(posted.status).toBe(201);
    expect(ids).not.toContain(posted.json.data.id);
    expect((await call(target, 'GET', '/v1/workspace', undefined, key)).status).toBe(200);
    // The engine's triggers are back: a DM delivery advances the agent's sequence high-water.
    expect((await call(target, 'POST', '/v1/dm', { to: 'carol', text: 'trigger check' }, tokens.alice)).status).toBe(201);
    const triggers = target.sql.raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`).all();
    const sourceTriggers = source.sql.raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`).all();
    expect(triggers).toEqual(sourceTriggers);
  });

  it('answers every other request 503 while the import runs, and resumes a run after a resent chunk', async () => {
    const { source, tokens } = await seededSource();
    const exported = await exportFrom(source);
    const target = new FakeWorkspaceActor(WORKSPACE_ID);
    expect((await step(target, { op: 'begin', run_id: RUN, tables: exported.tables })).status).toBe(201);
    const [first, second] = exported.blocks;
    expect((await step(target, { op: 'chunk', run_id: RUN, table: first!.table, seq: first!.seq, rows: first!.rows })).status).toBe(200);

    const blocked = await call(target, 'GET', '/v1/channels', undefined, tokens.bob);
    expect(blocked.status).toBe(503);
    expect(blocked.json.error?.code).toBe('workspace_importing');

    // Begin again (a restarted importer), then resend the same chunk: answered from the ledger.
    const resumed = await step<{ tables: Record<string, { chunks: number }> }>(target, { op: 'begin', run_id: RUN, tables: exported.tables });
    expect(resumed.status).toBe(200);
    const again = await step<{ duplicate: boolean }>(target, { op: 'chunk', run_id: RUN, table: first!.table, seq: first!.seq, rows: first!.rows });
    expect(again.json.data.duplicate).toBe(true);
    // A chunk ahead of its table's sequence is refused.
    const skipped = exported.blocks.find((block) => block.seq === 1 && block.table !== first!.table) ?? second!;
    if (skipped.seq > 0) {
      const ahead = await step(target, { op: 'chunk', run_id: RUN, table: skipped.table, seq: skipped.seq + 5, rows: skipped.rows });
      expect(ahead.status).toBe(409);
      expect(ahead.json.error?.code).toBe('import_chunk_out_of_order');
    }
    // Another run cannot take over.
    expect((await step(target, { op: 'begin', run_id: 'run-0002-other', tables: exported.tables })).json.error?.code).toBe('import_run_mismatch');
  });

  it('refuses a manifest the stored rows do not match, and keeps the workspace closed', async () => {
    const { source, tokens } = await seededSource();
    const exported = await exportFrom(source);
    const target = new FakeWorkspaceActor(WORKSPACE_ID);
    const tampered = { ...exported, manifest: { ...exported.manifest, messages: { ...exported.manifest.messages!, count: exported.manifest.messages!.count + 1 } } };
    const finished = await importAll(target, tampered);
    expect(finished.status).toBe(409);
    expect(finished.json.error?.code).toBe('import_verification_failed');
    expect((await call(target, 'GET', '/v1/channels', undefined, tokens.bob)).status).toBe(503);
  });

  it('refuses an export whose schema differs, and an actor that already holds a workspace', async () => {
    const { source } = await seededSource();
    const exported = await exportFrom(source);
    const target = new FakeWorkspaceActor(WORKSPACE_ID);
    const renamed = exported.tables.map((table) => table.name === 'messages' ? { ...table, columns: [...table.columns, 'extra'] } : table);
    const mismatch = await step(target, { op: 'begin', run_id: RUN, tables: renamed });
    expect(mismatch.status).toBe(409);
    expect(mismatch.json.error?.code).toBe('import_schema_mismatch');

    const occupied = await step(source, { op: 'begin', run_id: RUN, tables: exported.tables });
    expect(occupied.status).toBe(409);
    expect(occupied.json.error?.code).toBe('workspace_exists');
  });

  it('aborts: removes the imported rows, restores the triggers and reopens the actor empty', async () => {
    const { source } = await seededSource();
    const exported = await exportFrom(source);
    const target = new FakeWorkspaceActor(WORKSPACE_ID);
    const triggersBefore = source.sql.raw.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'`).get();
    expect((await step(target, { op: 'begin', run_id: RUN, tables: exported.tables })).status).toBe(201);
    for (const block of exported.blocks.slice(0, 10)) {
      expect((await step(target, { op: 'chunk', run_id: RUN, table: block.table, seq: block.seq, rows: block.rows })).status).toBe(200);
    }
    expect((await step(target, { op: 'abort', run_id: RUN })).status).toBe(200);
    expect(target.sql.raw.prepare('SELECT COUNT(*) AS n FROM workspaces').get()).toEqual({ n: 0 });
    expect(target.sql.raw.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'`).get()).toEqual(triggersBefore);
    expect((await step<{ status: string }>(target, { op: 'status' })).json.data.status).toBe('none');
    // A fresh run can start over.
    expect((await importAll(target, exported)).status).toBe(200);
  });
});
