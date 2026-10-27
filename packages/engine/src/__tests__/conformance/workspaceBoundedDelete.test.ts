import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { configureEngineDiagnostics } from '../../lib/engineDiagnostics.js';
import type { EngineProgressSample } from '../../ports/diagnostics.js';
import { messages, workspaceCreateIdempotency, workspaceEvents, workspaces } from '../../db/schema.js';
import { reapExpiredWorkspaces } from '../../engine/workspace.js';
import { handleNodeControlMessage } from '../../node-control.js';
import {
  drainedWorkspaceTables,
  drainWorkspaceRows,
  exceedsAtomicDeleteSize,
  WORKSPACE_ATOMIC_DELETE_MAX_ROWS,
} from '../../engine/workspaceDrain.js';
import { createWorkspace, FakeSocket, makeNodeStack, registerAgent, type TestStack } from './harness.js';

describe('bounded workspace deletion', () => {
  let stack: TestStack;
  let progress: EngineProgressSample[];

  beforeEach(() => {
    stack = makeNodeStack();
    progress = [];
    configureEngineDiagnostics({ progress: sample => { progress.push(sample); } });
  });
  afterEach(async () => {
    configureEngineDiagnostics(undefined);
    await stack.close();
  });

  /** A workspace above the atomic threshold: events, plus root messages that each have a reply. */
  async function seedLargeWorkspace(name: string, { events = WORKSPACE_ATOMIC_DELETE_MAX_ROWS + 500, threads = 450 } = {}) {
    const ws = await createWorkspace(stack.app, name);
    const agent = await registerAgent(stack.app, ws.workspaceKey, `${name}-agent`);
    const sqlite = stack.runtime.handle.sqlite;
    const channel = sqlite.prepare("SELECT id FROM channels WHERE workspace_id = ? AND name = 'general'")
      .get(ws.workspaceId) as { id: string };
    sqlite.prepare(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO workspace_events (workspace_id, seq, type, payload, created_at)
      SELECT ?, 1000 + i, 'test.event', '{}', unixepoch() FROM n
    `).run(events, ws.workspaceId);
    // Roots get ids 10…, replies 20… (always newer), so a newest-first drain must
    // never delete a root before its reply — messages.thread_id is NO ACTION.
    sqlite.prepare(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO messages (id, workspace_id, channel_id, agent_id, body, has_attachments, created_at)
      SELECT '1' || printf('%09d', i), ?, ?, ?, 'root', 0, unixepoch() FROM n
    `).run(threads, ws.workspaceId, channel.id, agent.agentId);
    sqlite.prepare(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO messages (id, workspace_id, channel_id, agent_id, thread_id, body, has_attachments, created_at)
      SELECT '2' || printf('%09d', i), ?, ?, ?, '1' || printf('%09d', i), 'reply', 0, unixepoch() FROM n
    `).run(threads, ws.workspaceId, channel.id, agent.agentId);
    return { ws, agent };
  }

  const count = (table: string, workspaceId: string) =>
    (stack.runtime.handle.sqlite.prepare(`SELECT count(*) AS n FROM ${table} WHERE workspace_id = ?`)
      .get(workspaceId) as { n: number }).n;

  it('drains every table that grows with a workspace, leaving only bounded ones to the final cascade', () => {
    // Per-workspace or per-agent configuration: a handful of rows each, so the
    // final cascade over them stays small. Anything that accumulates history
    // must be drained instead — add new tables to DRAIN_STEPS, not here.
    const bounded = new Set([
      'workspaces', 'workspace_create_idempotency', 'agent_recovery_credentials', 'observer_tokens',
      'node_providers', 'agent_node_bindings', 'a2a_agents', 'directory_agents', 'directory_skills',
      'directory_ratings', 'routing_configs', 'certifications', 'dm_conversation_reservations',
      'webhooks', 'event_subscriptions', 'actions', 'triggers',
    ]);
    const sqlite = stack.runtime.handle.sqlite;
    // Virtual (FTS) tables are maintained by triggers on the tables they index.
    const tables = (sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'",
    ).all() as { name: string }[])
      .map(row => row.name)
      .filter(name => (sqlite.prepare(`SELECT name FROM pragma_table_info('${name}')`).all() as { name: string }[])
        .some(column => column.name === 'workspace_id'));
    const drained = new Set(drainedWorkspaceTables());
    expect(tables.filter(name => !drained.has(name) && !bounded.has(name))).toEqual([]);
  });

  it('makes progress even when its budget is spent before the first non-empty table', async () => {
    // Only messages hold rows; every earlier step is an empty probe.
    const { ws } = await seedLargeWorkspace('bounded-progress', { events: 0 });
    // Every call's budget is already spent: each must still delete something,
    // so repeated calls finish the drain instead of re-probing forever.
    let result = { complete: false, rows: 0 };
    let calls = 0;
    while (!result.complete && calls < 200) {
      result = await drainWorkspaceRows(stack.runtime.deps.db, ws.workspaceId, {
        deadline: Date.now() - 1, sleep: async () => {},
      });
      calls++;
    }
    expect(result.complete).toBe(true);
    expect(count('messages', ws.workspaceId)).toBe(0);
  });

  it('rejects agent registration from a node socket opened before the workspace was deleted', async () => {
    const ws = await createWorkspace(stack.app, 'bounded-node-socket');
    const created = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ node_id: 'node_deleted_ws', name: 'deleted-ws-broker', role: 'broker', capabilities: [], max_agents: 4 }),
    });
    expect(created.status).toBe(201);
    const socket = new FakeSocket();
    const send = (frame: Record<string, unknown>) => handleNodeControlMessage({
      db: stack.runtime.handle.db,
      registry: stack.runtime.realtime,
      completionDeps: stack.runtime.deps,
      workspaceId: ws.workspaceId,
      nodeId: 'node_deleted_ws',
      socket,
      raw: JSON.stringify(frame),
    });
    await send({
      v: 1, id: 'register', type: 'node.register', name: 'deleted-ws-broker', node_id: 'node_deleted_ws',
      capabilities: [], max_agents: 4, tags: [], version: 'v1', resume_cursor: null,
    });
    expect(socket.ofType('reply').at(-1)).toMatchObject({ id: 'register', ok: true });

    // The deferred delete tombstones the workspace; the socket stays open.
    stack.runtime.handle.sqlite.prepare('UPDATE workspaces SET expires_at = unixepoch() - 1 WHERE id = ?')
      .run(ws.workspaceId);
    await send({ v: 1, id: 'agent', type: 'agent.register', name: 'late-agent', session_ref: 'pty://late', resumable: true });

    expect(socket.ofType('error').at(-1)).toMatchObject({ id: 'agent', code: 'workspace_expired' });
    expect(stack.runtime.handle.sqlite.prepare("SELECT count(*) AS n FROM agents WHERE workspace_id = ? AND name = 'late-agent'")
      .get(ws.workspaceId)).toEqual({ n: 0 });
  });

  it('keeps small workspaces on the atomic delete', async () => {
    const ws = await createWorkspace(stack.app, 'bounded-small');
    expect(await exceedsAtomicDeleteSize(stack.runtime.deps.db, ws.workspaceId)).toBe(false);
    const response = await stack.app.request(`/v1/workspaces/${ws.workspaceId}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(response.status).toBe(204);
    // Gone before the response, not after a background drain.
    expect(await stack.runtime.handle.db.select().from(workspaces).where(eq(workspaces.id, ws.workspaceId))).toHaveLength(0);
  });

  it('tombstones a large workspace at once and drains it in bounded steps', async () => {
    const { ws } = await seedLargeWorkspace('bounded-large');
    expect(await exceedsAtomicDeleteSize(stack.runtime.deps.db, ws.workspaceId)).toBe(true);

    const response = await stack.app.request(`/v1/workspaces/${ws.workspaceId}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(response.status).toBe(204);
    // Immediately unusable, whether or not the drain has finished.
    const after = await stack.app.request('/v1/workspace', { headers: { authorization: `Bearer ${ws.workspaceKey}` } });
    expect(after.status).toBe(401);
    await expect(after.json()).resolves.toMatchObject({ error: { code: 'workspace_expired' } });

    await stack.settle();
    expect(count('workspace_events', ws.workspaceId)).toBe(0);
    expect(count('messages', ws.workspaceId)).toBe(0);
    expect(await stack.runtime.handle.db.select().from(workspaces).where(eq(workspaces.id, ws.workspaceId))).toHaveLength(0);
    // Every drained statement stayed within its page size.
    const batches = progress.filter(sample => sample.phase === 'batch');
    expect(batches.length).toBeGreaterThan(1);
    expect(Math.max(...batches.map(sample => sample.rows ?? 0))).toBeLessThanOrEqual(500);
    expect(progress.map(sample => sample.phase)).toEqual(expect.arrayContaining(['started', 'batch', 'completed']));
  });

  it('stops at its wall-clock budget and resumes where it left off', async () => {
    const { ws } = await seedLargeWorkspace('bounded-budget');
    // Beyond the seeded rows: the workspace's own channels, agents, files and nodes.
    const members = (stack.runtime.handle.sqlite.prepare(
      'SELECT count(*) AS n FROM channel_members cm JOIN channels c ON c.id = cm.channel_id WHERE c.workspace_id = ?',
    ).get(ws.workspaceId) as { n: number }).n;
    const ownRows = members
      + ['channels', 'agents', 'files', 'nodes'].reduce((sum, table) => sum + count(table, ws.workspaceId), 0);
    let clock = 0;
    // Each statement "takes" 100ms; the 50% duty cycle idles as long again.
    const db = stack.runtime.deps.db;
    const all = db.all.bind(db);
    (db as { all: typeof db.all }).all = (async (...args: Parameters<typeof db.all>) => {
      clock += 100;
      return all(...args);
    }) as typeof db.all;
    const sleeps: number[] = [];
    const first = await drainWorkspaceRows(db, ws.workspaceId, {
      maxDurationMs: 1_000,
      now: () => clock,
      sleep: async ms => { sleeps.push(ms); clock += ms; },
    });
    expect(first.complete).toBe(false);
    expect(clock).toBeLessThanOrEqual(1_100);
    expect(sleeps.every(ms => ms === 100)).toBe(true);
    // Every page that deleted rows is paced, including a table's last, short page.
    expect(sleeps.length).toBe(progress.filter(sample => sample.phase === 'batch').length);
    (db as { all: typeof db.all }).all = all;

    const rest = await drainWorkspaceRows(db, ws.workspaceId, { maxDurationMs: 60_000, sleep: async () => {} });
    expect(rest.complete).toBe(true);
    expect(first.rows + rest.rows).toBe(WORKSPACE_ATOMIC_DELETE_MAX_ROWS + 500 + 900 + ownRows);
  });

  it('lets the reaper finish a large expired workspace across several calls', async () => {
    const { ws } = await seedLargeWorkspace('bounded-reaper');
    await stack.runtime.handle.db.update(workspaces).set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(workspaces.id, ws.workspaceId));
    const fastSleep = async () => {};
    let calls = 0;
    let reaped: string[] = [];
    while (reaped.length === 0 && calls < 50) {
      calls += 1;
      reaped = await reapExpiredWorkspaces(stack.runtime.deps.db, stack.runtime.deps.files, {
        maxDurationMs: 5, sleep: fastSleep,
      });
    }
    expect(reaped).toEqual([ws.workspaceId]);
    expect(calls).toBeGreaterThan(1);
    expect(await stack.runtime.handle.db.select().from(messages).where(eq(messages.workspaceId, ws.workspaceId))).toHaveLength(0);
    expect(await stack.runtime.handle.db.select().from(workspaceEvents).where(eq(workspaceEvents.workspaceId, ws.workspaceId))).toHaveLength(0);
  });

  it('never pushes a nearer expiry deadline back when deleting', async () => {
    const { ws } = await seedLargeWorkspace('bounded-nearer-deadline');
    const nearer = new Date(Date.now() - 60_000);
    await stack.runtime.handle.db.update(workspaces).set({ expiresAt: nearer }).where(eq(workspaces.id, ws.workspaceId));
    const { deleteWorkspace } = await import('../../engine/workspace.js');
    await expect(deleteWorkspace(stack.runtime.deps.db, stack.runtime.deps.files, ws.workspaceId))
      .resolves.toEqual({ deferred: true });
    const [row] = await stack.runtime.handle.db.select({ expiresAt: workspaces.expiresAt }).from(workspaces)
      .where(eq(workspaces.id, ws.workspaceId));
    expect(row?.expiresAt?.getTime()).toBe(Math.floor(nearer.getTime() / 1000) * 1000);
  });
  it('counts and drains a workspace dominated by channels, not just messages and events', async () => {
    const ws = await createWorkspace(stack.app, 'bounded-channels');
    stack.runtime.handle.sqlite.prepare(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO channels (id, workspace_id, name, channel_type, created_at, is_archived)
      SELECT 'ch_bulk_' || i, ?, 'bulk-' || i, 0, unixepoch(), 0 FROM n
    `).run(WORKSPACE_ATOMIC_DELETE_MAX_ROWS + 100, ws.workspaceId);
    expect(await exceedsAtomicDeleteSize(stack.runtime.deps.db, ws.workspaceId)).toBe(true);
    const response = await stack.app.request(`/v1/workspaces/${ws.workspaceId}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(response.status).toBe(204);
    await stack.settle();
    expect(count('channels', ws.workspaceId)).toBe(0);
    expect(count('agents', ws.workspaceId)).toBe(0);
    expect(progress.filter(sample => sample.table === 'channels').length).toBeGreaterThan(1);
  });

  it('terminalizes create idempotency when a large delete is deferred', async () => {
    const { ws } = await seedLargeWorkspace('bounded-idempotency');
    stack.runtime.handle.sqlite.prepare(`
      INSERT INTO workspace_create_idempotency (owner_scope_hash, idempotency_key_hash, request_digest, workspace_id)
      VALUES ('owner', 'key', 'digest', ?)
    `).run(ws.workspaceId);
    const { deleteWorkspace } = await import('../../engine/workspace.js');
    await expect(deleteWorkspace(stack.runtime.deps.db, stack.runtime.deps.files, ws.workspaceId))
      .resolves.toEqual({ deferred: true });
    // Rows are still there, but a replay must not get this workspace's key back.
    expect(count('messages', ws.workspaceId)).toBeGreaterThan(0);
    expect(await stack.runtime.handle.db.select().from(workspaceCreateIdempotency)
      .where(eq(workspaceCreateIdempotency.workspaceId, ws.workspaceId)))
      .toMatchObject([{ status: 'terminalized' }]);
  });

  it('never lets an older large expired workspace starve a smaller one behind it', async () => {
    const { ws: large } = await seedLargeWorkspace('bounded-starve-large');
    const small = await createWorkspace(stack.app, 'bounded-starve-small');
    await stack.runtime.handle.db.update(workspaces).set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(workspaces.id, large.workspaceId));
    await stack.runtime.handle.db.update(workspaces).set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(workspaces.id, small.workspaceId));
    // A budget far too small to drain the large one in a single call.
    const reaped = await reapExpiredWorkspaces(stack.runtime.deps.db, stack.runtime.deps.files, {
      maxDurationMs: 5, sleep: async () => {},
    });
    expect(reaped).toContain(small.workspaceId);
    expect(reaped).not.toContain(large.workspaceId);
  });
  it('drains per-message fan-out before the messages, so no page cascades unbounded children', async () => {
    const { ws, agent } = await seedLargeWorkspace('bounded-fanout');
    stack.runtime.handle.sqlite.prepare(`
      INSERT INTO read_receipts (message_id, agent_id)
      SELECT id, ? FROM messages WHERE workspace_id = ?
    `).run(agent.agentId, ws.workspaceId);
    const seeded = (stack.runtime.handle.sqlite.prepare('SELECT count(*) AS n FROM read_receipts').get() as { n: number }).n;
    const result = await drainWorkspaceRows(stack.runtime.deps.db, ws.workspaceId, { maxDurationMs: 60_000, sleep: async () => {} });
    expect(result.complete).toBe(true);
    // Every receipt went in an explicit, page-bounded batch: none were removed
    // by a message delete's cascade.
    const receiptRows = progress
      .filter(sample => sample.phase === 'batch' && sample.table === 'read_receipts')
      .reduce((sum, sample) => sum + (sample.rows ?? 0), 0);
    expect(receiptRows).toBe(seeded);
    expect(stack.runtime.handle.sqlite.prepare('SELECT count(*) AS n FROM read_receipts').get()).toEqual({ n: 0 });
  });

  it('stops accepting inbound webhooks the moment a large delete is deferred', async () => {
    const { ws } = await seedLargeWorkspace('bounded-hooks');
    const created = await stack.app.request('/v1/webhooks', { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ channel: 'general' }) });
    expect(created.status).toBe(201);
    const { data: hook } = await created.json() as { data: { webhook_id: string; token: string } };
    const { deleteWorkspace } = await import('../../engine/workspace.js');
    await expect(deleteWorkspace(stack.runtime.deps.db, stack.runtime.deps.files, ws.workspaceId))
      .resolves.toEqual({ deferred: true });
    const before = count('messages', ws.workspaceId);
    const response = await stack.app.request(`/v1/hooks/${hook.webhook_id}`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${hook.token}` },
      body: JSON.stringify({ text: 'after delete' }) });
    expect(response.status).toBe(404);
    expect(count('messages', ws.workspaceId)).toBe(before);
  });

  it('refuses to drain at all when storage cannot delete objects', async () => {
    const { ws } = await seedLargeWorkspace('bounded-no-storage-delete');
    const before = count('messages', ws.workspaceId);
    const { reapWorkspace } = await import('../../engine/workspace.js');
    const storage = { ...stack.runtime.deps.files, deleteObjects: undefined };
    await expect(reapWorkspace(stack.runtime.deps.db, storage, ws.workspaceId))
      .rejects.toMatchObject({ code: 'file_storage_delete_unsupported', status: 503 });
    expect(count('messages', ws.workspaceId)).toBe(before);
    expect(count('workspace_events', ws.workspaceId)).toBeGreaterThan(0);
  });

  it('reserves half the reaper budget for draining, however many candidates need probing', async () => {
    // Create everything before anything expires: workspace creation runs its
    // own background reap, which must not drain the large one for us.
    const { ws: large } = await seedLargeWorkspace('bounded-reserve-large');
    const smalls = [];
    for (let i = 0; i < 5; i += 1) smalls.push(await createWorkspace(stack.app, `bounded-reserve-small-${i}`));
    await stack.settle();
    await stack.runtime.handle.db.update(workspaces).set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(workspaces.id, large.workspaceId));
    for (const small of smalls) {
      await stack.runtime.handle.db.update(workspaces).set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(workspaces.id, small.workspaceId));
    }
    progress.length = 0;
    // Every statement "takes" 50ms: probing and deleting the small ones alone
    // would eat the whole budget.
    let clock = 0;
    const db = stack.runtime.deps.db;
    const all = db.all.bind(db);
    (db as { all: typeof db.all }).all = (async (...args: Parameters<typeof db.all>) => { clock += 50; return all(...args); }) as typeof db.all;
    try {
      await reapExpiredWorkspaces(db, stack.runtime.deps.files, { maxDurationMs: 2_000, clock: () => clock, sleep: async () => {} });
    } finally {
      (db as { all: typeof db.all }).all = all;
    }
    expect(progress.some(sample => sample.phase === 'batch' && sample.workspaceId === large.workspaceId)).toBe(true);
  });
  /** One root message with `replies` replies, every message read once by `agentId`. */
  function seedThread(ws: { workspaceId: string }, agentId: string, replies: number) {
    const sqlite = stack.runtime.handle.sqlite;
    const channel = sqlite.prepare("SELECT id FROM channels WHERE workspace_id = ? AND name = 'general'")
      .get(ws.workspaceId) as { id: string };
    sqlite.prepare(`INSERT INTO messages (id, workspace_id, channel_id, agent_id, body, has_attachments, created_at)
      VALUES ('3000000000', ?, ?, ?, 'root', 0, unixepoch())`).run(ws.workspaceId, channel.id, agentId);
    sqlite.prepare(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO messages (id, workspace_id, channel_id, agent_id, thread_id, body, has_attachments, created_at)
      SELECT '4' || printf('%09d', i), ?, ?, ?, '3000000000', 'reply', 0, unixepoch() FROM n
    `).run(replies, ws.workspaceId, channel.id, agentId);
    sqlite.prepare('INSERT INTO read_receipts (message_id, agent_id) SELECT id, ? FROM messages WHERE workspace_id = ?')
      .run(agentId, ws.workspaceId);
    return (sqlite.prepare('SELECT count(*) AS n FROM read_receipts').get() as { n: number }).n;
  }
  const receiptBatchRows = () => progress
    .filter(sample => sample.phase === 'batch' && sample.table === 'read_receipts')
    .reduce((sum, sample) => sum + (sample.rows ?? 0), 0);

  it('keeps draining past a short page until the root behind its replies is gone too', async () => {
    const ws = await createWorkspace(stack.app, 'bounded-thread-root');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'thread-root-agent');
    const seeded = seedThread(ws, agent.agentId, 150);
    const result = await drainWorkspaceRows(stack.runtime.deps.db, ws.workspaceId, { maxDurationMs: 60_000, sleep: async () => {} });
    expect(result.complete).toBe(true);
    expect(count('messages', ws.workspaceId)).toBe(0);
    // The root's receipts went in a batch, not in the final cascade.
    expect(receiptBatchRows()).toBe(seeded);
  });

  it('never lets overlapping drains skip a page of children', async () => {
    const { ws, agent } = await seedLargeWorkspace('bounded-overlap');
    const seeded = seedThread(ws, agent.agentId, 10);
    const drain = () => drainWorkspaceRows(stack.runtime.deps.db, ws.workspaceId, {
      maxDurationMs: 60_000, sleep: () => new Promise(resolve => setImmediate(resolve)),
    });
    const [a, b] = await Promise.all([drain(), drain()]);
    expect(a.complete && b.complete).toBe(true);
    expect(count('messages', ws.workspaceId)).toBe(0);
    // Every receipt was removed by an explicit batch of one drain or the other.
    expect(receiptBatchRows()).toBe(seeded);
  });
});
