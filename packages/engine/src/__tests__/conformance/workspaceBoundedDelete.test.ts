import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { configureEngineDiagnostics } from '../../lib/engineDiagnostics.js';
import type { EngineProgressSample } from '../../ports/diagnostics.js';
import { messages, workspaceCreateIdempotency, workspaceEvents, workspaces } from '../../db/tables.js';
import { reapExpiredWorkspaces } from '../../engine/workspace.js';
import { handleNodeControlMessage } from '../../node-control.js';
import {
  drainedWorkspaceTables,
  drainWorkspaceRows,
  exceedsAtomicDeleteSize,
  WORKSPACE_ATOMIC_DELETE_MAX_ROWS,
} from '../../engine/workspaceDrain.js';
import {
  beforeRawQuery, createWorkspace, FakeSocket, makeNodeStack, pgMode, rawAll, rawGet, rawInsertRows, rawRun, registerAgent, type TestStack,
} from './harness.js';

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

  /** 1..n */
  const range = (n: number) => Array.from({ length: n }, (_, index) => index + 1);
  const pad9 = (i: number) => String(i).padStart(9, '0');
  const generalChannelId = async (workspaceId: string) => (await rawGet<{ id: string }>(stack.runtime.deps.db,
    "SELECT id FROM channels WHERE workspace_id = ? AND name = 'general'", [workspaceId]))!.id;
  const readReceiptCount = async () => (await rawGet<{ n: number }>(stack.runtime.deps.db, 'SELECT count(*) AS n FROM read_receipts'))!.n;

  /** A workspace above the atomic threshold: events, plus root messages that each have a reply. */
  async function seedLargeWorkspace(name: string, { events = WORKSPACE_ATOMIC_DELETE_MAX_ROWS + 500, threads = 450 } = {}) {
    const ws = await createWorkspace(stack.app, name);
    const agent = await registerAgent(stack.app, ws.workspaceKey, `${name}-agent`);
    const db = stack.runtime.deps.db;
    const channelId = await generalChannelId(ws.workspaceId);
    const now = Math.floor(Date.now() / 1_000);
    await rawInsertRows(db, 'workspace_events', ['workspace_id', 'seq', 'type', 'payload', 'created_at'],
      range(events).map(i => [ws.workspaceId, 1000 + i, 'test.event', '{}', now]));
    // Roots get ids 10…, replies 20… (always newer), so a newest-first drain must
    // never delete a root before its reply — messages.thread_id is NO ACTION.
    await rawInsertRows(db, 'messages', ['id', 'workspace_id', 'channel_id', 'agent_id', 'body', 'created_at'],
      range(threads).map(i => [`1${pad9(i)}`, ws.workspaceId, channelId, agent.agentId, 'root', now]));
    await rawInsertRows(db, 'messages', ['id', 'workspace_id', 'channel_id', 'agent_id', 'thread_id', 'body', 'created_at'],
      range(threads).map(i => [`2${pad9(i)}`, ws.workspaceId, channelId, agent.agentId, `1${pad9(i)}`, 'reply', now]));
    return { ws, agent };
  }

  const count = async (table: string, workspaceId: string) =>
    (await rawGet<{ n: number }>(stack.runtime.deps.db, `SELECT count(*) AS n FROM ${table} WHERE workspace_id = ?`, [workspaceId]))!.n;

  it('drains every table that grows with a workspace, leaving only bounded ones to the final cascade', async () => {
    // Per-workspace or per-agent configuration: a handful of rows each, so the
    // final cascade over them stays small. Anything that accumulates history
    // must be drained instead — add new tables to DRAIN_STEPS, not here.
    const bounded = new Set([
      'workspaces', 'workspace_create_idempotency', 'agent_recovery_credentials', 'observer_tokens',
      'node_providers', 'agent_node_bindings', 'a2a_agents', 'directory_agents', 'directory_skills',
      'directory_ratings', 'routing_configs', 'certifications', 'dm_conversation_reservations',
      'webhooks', 'event_subscriptions', 'actions', 'triggers', 'credential_upgrades',
    ]);
    const tables = pgMode
      ? (await rawAll<{ name: string }>(stack.runtime.deps.db, `
          SELECT c.table_name AS name FROM information_schema.columns c
          JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE' AND c.column_name = 'workspace_id'
        `)).map(row => row.name)
          // pg's mention index is a plain table kept in step by triggers on
          // messages, like the SQLite FTS virtual table excluded below.
          .filter(name => name !== 'messages_mention_fts')
      : sqliteWorkspaceTables();
    const drained = new Set(drainedWorkspaceTables());
    expect(tables.filter(name => !drained.has(name) && !bounded.has(name))).toEqual([]);
  });

  function sqliteWorkspaceTables(): string[] {
    const sqlite = stack.runtime.handle.sqlite;
    // Virtual (FTS) tables are maintained by triggers on the tables they index.
    return (sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'",
    ).all() as { name: string }[])
      .map(row => row.name)
      .filter(name => (sqlite.prepare(`SELECT name FROM pragma_table_info('${name}')`).all() as { name: string }[])
        .some(column => column.name === 'workspace_id'));
  }

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
    expect(await count('messages', ws.workspaceId)).toBe(0);
  });

  it('rejects registration and new work from a node socket opened before the workspace was deleted', async () => {
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
    await rawRun(stack.runtime.deps.db, 'UPDATE workspaces SET expires_at = ? WHERE id = ?',
      [Math.floor(Date.now() / 1_000) - 1, ws.workspaceId]);
    await send({ v: 1, id: 'agent', type: 'agent.register', name: 'late-agent', session_ref: 'pty://late', resumable: true });

    expect(socket.ofType('error').at(-1)).toMatchObject({ id: 'agent', code: 'workspace_expired' });
    expect(await rawGet(stack.runtime.deps.db, "SELECT count(*) AS n FROM agents WHERE workspace_id = ? AND name = 'late-agent'",
      [ws.workspaceId])).toEqual({ n: 0 });

    // Nor start new work there, or revive an agent the drain is removing.
    await send({ v: 1, id: 'spawn', type: 'node.spawn', input: { cli: 'claude', name: 'late-worker' } });
    expect(socket.ofType('error').at(-1)).toMatchObject({ id: 'spawn', code: 'workspace_expired' });
    await send({ v: 1, id: 'recover', type: 'agent.recover', name: 'late-agent', expected_agent_id: 'agent_gone' });
    expect(socket.ofType('error').at(-1)).toMatchObject({ id: 'recover', code: 'workspace_expired' });
    expect(await rawGet(stack.runtime.deps.db, 'SELECT count(*) AS n FROM action_invocations WHERE workspace_id = ?',
      [ws.workspaceId])).toEqual({ n: 0 });
    // Heartbeats and inventory writes are refused as well.
    await send({ v: 1, id: 'beat', type: 'node.heartbeat', load: 0, active_agents: 0, handlers_live: true });
    expect(socket.ofType('error').at(-1)).toMatchObject({ id: 'beat', code: 'workspace_expired' });
    await send({ v: 1, id: 'sync', type: 'inventory.sync', agents: [] });
    expect(socket.ofType('error').at(-1)).toMatchObject({ id: 'sync', code: 'workspace_expired' });
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
    expect(await count('workspace_events', ws.workspaceId)).toBe(0);
    expect(await count('messages', ws.workspaceId)).toBe(0);
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
    const members = (await rawGet<{ n: number }>(stack.runtime.deps.db,
      'SELECT count(*) AS n FROM channel_members cm JOIN channels c ON c.id = cm.channel_id WHERE c.workspace_id = ?',
      [ws.workspaceId]))!.n;
    let ownRows = members;
    for (const table of ['channels', 'agents', 'files', 'nodes']) ownRows += await count(table, ws.workspaceId);
    let clock = 0;
    // Each statement "takes" 100ms; the 50% duty cycle idles as long again.
    const db = stack.runtime.handle.db;
    const restoreClock = beforeRawQuery(db, () => { clock += 100; });
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
    restoreClock();

    const rest = await drainWorkspaceRows(db, ws.workspaceId, { maxDurationMs: 60_000, sleep: async () => {} });
    expect(rest.complete).toBe(true);
    expect(first.rows + rest.rows).toBe(WORKSPACE_ATOMIC_DELETE_MAX_ROWS + 500 + 900 + ownRows);
  });

  it('still drains when probing a large workspace spends the whole budget', async () => {
    const { ws } = await seedLargeWorkspace('bounded-slow-probe');
    await stack.runtime.handle.db.update(workspaces).set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(workspaces.id, ws.workspaceId));
    const before = await count('workspace_events', ws.workspaceId) + await count('messages', ws.workspaceId);
    let clock = 0;
    // Every raw statement "takes" a full budget, so the size probe overruns it.
    const db = stack.runtime.handle.db;
    const restoreClock = beforeRawQuery(db, () => { clock += 1_000; });
    try {
      await reapExpiredWorkspaces(db, stack.runtime.deps.files, {
        maxDurationMs: 1_000, clock: () => clock, sleep: async () => {},
      });
    } finally {
      restoreClock();
    }
    expect(await count('workspace_events', ws.workspaceId) + await count('messages', ws.workspaceId)).toBeLessThan(before);
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
    await rawInsertRows(stack.runtime.deps.db, 'channels', ['id', 'workspace_id', 'name', 'channel_type', 'created_at'],
      range(WORKSPACE_ATOMIC_DELETE_MAX_ROWS + 100).map(i => [`ch_bulk_${i}`, ws.workspaceId, `bulk-${i}`, 0, Math.floor(Date.now() / 1_000)]));
    expect(await exceedsAtomicDeleteSize(stack.runtime.deps.db, ws.workspaceId)).toBe(true);
    const response = await stack.app.request(`/v1/workspaces/${ws.workspaceId}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(response.status).toBe(204);
    await stack.settle();
    expect(await count('channels', ws.workspaceId)).toBe(0);
    expect(await count('agents', ws.workspaceId)).toBe(0);
    expect(progress.filter(sample => sample.table === 'channels').length).toBeGreaterThan(1);
  });

  it('terminalizes create idempotency when a large delete is deferred', async () => {
    const { ws } = await seedLargeWorkspace('bounded-idempotency');
    await rawRun(stack.runtime.deps.db, `
      INSERT INTO workspace_create_idempotency (owner_scope_hash, idempotency_key_hash, request_digest, workspace_id)
      VALUES ('owner', 'key', 'digest', ?)
    `, [ws.workspaceId]);
    const { deleteWorkspace } = await import('../../engine/workspace.js');
    await expect(deleteWorkspace(stack.runtime.deps.db, stack.runtime.deps.files, ws.workspaceId))
      .resolves.toEqual({ deferred: true });
    // Rows are still there, but a replay must not get this workspace's key back.
    expect(await count('messages', ws.workspaceId)).toBeGreaterThan(0);
    expect(await stack.runtime.handle.db.select().from(workspaceCreateIdempotency)
      .where(eq(workspaceCreateIdempotency.workspaceId, ws.workspaceId)))
      .toMatchObject([{ status: 'terminalized' }]);
  });

  it('never lets an older large expired workspace starve a smaller one behind it', async () => {
    const { ws: large } = await seedLargeWorkspace('bounded-starve-large');
    const small = await createWorkspace(stack.app, 'bounded-starve-small');
    // Each real create schedules its own bounded reap; let those finish before
    // backdating, so only the explicit call below can reap the small workspace.
    await stack.settle();
    await stack.runtime.handle.db.update(workspaces).set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(workspaces.id, large.workspaceId));
    await stack.runtime.handle.db.update(workspaces).set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(workspaces.id, small.workspaceId));
    // A budget far too small to drain the large one in a single call. Every raw
    // statement "takes" 10ms on a fake clock, so a slow runner cannot change it.
    let clock = 0;
    const db = stack.runtime.handle.db;
    const restoreClock = beforeRawQuery(db, () => { clock += 10; });
    let reaped: string[];
    try {
      reaped = await reapExpiredWorkspaces(db, stack.runtime.deps.files, {
        maxDurationMs: 100, clock: () => clock, sleep: async () => {},
      });
    } finally {
      restoreClock();
    }
    expect(reaped).toContain(small.workspaceId);
    expect(reaped).not.toContain(large.workspaceId);
  });
  it('drains per-message fan-out before the messages, so no page cascades unbounded children', async () => {
    const { ws, agent } = await seedLargeWorkspace('bounded-fanout');
    await rawRun(stack.runtime.deps.db, `
      INSERT INTO read_receipts (message_id, agent_id)
      SELECT id, ? FROM messages WHERE workspace_id = ?
    `, [agent.agentId, ws.workspaceId]);
    const seeded = await readReceiptCount();
    const result = await drainWorkspaceRows(stack.runtime.deps.db, ws.workspaceId, { maxDurationMs: 60_000, sleep: async () => {} });
    expect(result.complete).toBe(true);
    // Every receipt went in an explicit, page-bounded batch: none were removed
    // by a message delete's cascade.
    const receiptRows = progress
      .filter(sample => sample.phase === 'batch' && sample.table === 'read_receipts')
      .reduce((sum, sample) => sum + (sample.rows ?? 0), 0);
    expect(receiptRows).toBe(seeded);
    expect(await readReceiptCount()).toBe(0);
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
    const before = await count('messages', ws.workspaceId);
    const response = await stack.app.request(`/v1/hooks/${hook.webhook_id}`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${hook.token}` },
      body: JSON.stringify({ text: 'after delete' }) });
    expect(response.status).toBe(404);
    expect(await count('messages', ws.workspaceId)).toBe(before);
  });

  it('refuses to drain at all when storage cannot delete objects', async () => {
    const { ws } = await seedLargeWorkspace('bounded-no-storage-delete');
    const before = await count('messages', ws.workspaceId);
    const { reapWorkspace } = await import('../../engine/workspace.js');
    const storage = { ...stack.runtime.deps.files, deleteObjects: undefined };
    await expect(reapWorkspace(stack.runtime.deps.db, storage, ws.workspaceId))
      .rejects.toMatchObject({ code: 'file_storage_delete_unsupported', status: 503 });
    expect(await count('messages', ws.workspaceId)).toBe(before);
    expect(await count('workspace_events', ws.workspaceId)).toBeGreaterThan(0);
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
    const db = stack.runtime.handle.db;
    const restoreClock = beforeRawQuery(db, () => { clock += 50; });
    try {
      await reapExpiredWorkspaces(db, stack.runtime.deps.files, { maxDurationMs: 2_000, clock: () => clock, sleep: async () => {} });
    } finally {
      restoreClock();
    }
    expect(progress.some(sample => sample.phase === 'batch' && sample.workspaceId === large.workspaceId)).toBe(true);
  });
  /** One root message with `replies` replies, every message read once by `agentId`. */
  async function seedThread(ws: { workspaceId: string }, agentId: string, replies: number) {
    const db = stack.runtime.deps.db;
    const channelId = await generalChannelId(ws.workspaceId);
    const now = Math.floor(Date.now() / 1_000);
    await rawInsertRows(db, 'messages', ['id', 'workspace_id', 'channel_id', 'agent_id', 'body', 'created_at'],
      [['3000000000', ws.workspaceId, channelId, agentId, 'root', now]]);
    await rawInsertRows(db, 'messages', ['id', 'workspace_id', 'channel_id', 'agent_id', 'thread_id', 'body', 'created_at'],
      range(replies).map(i => [`4${pad9(i)}`, ws.workspaceId, channelId, agentId, '3000000000', 'reply', now]));
    await rawRun(db, 'INSERT INTO read_receipts (message_id, agent_id) SELECT id, ? FROM messages WHERE workspace_id = ?',
      [agentId, ws.workspaceId]);
    return readReceiptCount();
  }
  const receiptBatchRows = () => progress
    .filter(sample => sample.phase === 'batch' && sample.table === 'read_receipts')
    .reduce((sum, sample) => sum + (sample.rows ?? 0), 0);

  it('keeps draining past a short page until the root behind its replies is gone too', async () => {
    const ws = await createWorkspace(stack.app, 'bounded-thread-root');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'thread-root-agent');
    const seeded = await seedThread(ws, agent.agentId, 150);
    const result = await drainWorkspaceRows(stack.runtime.deps.db, ws.workspaceId, { maxDurationMs: 60_000, sleep: async () => {} });
    expect(result.complete).toBe(true);
    expect(await count('messages', ws.workspaceId)).toBe(0);
    // The root's receipts went in a batch, not in the final cascade.
    expect(receiptBatchRows()).toBe(seeded);
  });

  it('never lets overlapping drains skip a page of children', async () => {
    const { ws, agent } = await seedLargeWorkspace('bounded-overlap');
    const seeded = await seedThread(ws, agent.agentId, 10);
    const drain = () => drainWorkspaceRows(stack.runtime.deps.db, ws.workspaceId, {
      maxDurationMs: 60_000, sleep: () => new Promise(resolve => setImmediate(resolve)),
    });
    const [a, b] = await Promise.all([drain(), drain()]);
    expect(a.complete && b.complete).toBe(true);
    expect(await count('messages', ws.workspaceId)).toBe(0);
    // Every receipt was removed by an explicit batch of one drain or the other.
    expect(receiptBatchRows()).toBe(seeded);
  });
});
