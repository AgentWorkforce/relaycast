import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { configureEngineDiagnostics } from '../../lib/engineDiagnostics.js';
import type { EngineProgressSample } from '../../ports/diagnostics.js';
import { messages, workspaceEvents, workspaces } from '../../db/schema.js';
import { reapExpiredWorkspaces } from '../../engine/workspace.js';
import {
  drainWorkspaceRows,
  exceedsAtomicDeleteSize,
  WORKSPACE_ATOMIC_DELETE_MAX_ROWS,
} from '../../engine/workspaceDrain.js';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';

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
    (db as { all: typeof db.all }).all = all;

    const rest = await drainWorkspaceRows(db, ws.workspaceId, { maxDurationMs: 60_000, sleep: async () => {} });
    expect(rest.complete).toBe(true);
    expect(first.rows + rest.rows).toBe(WORKSPACE_ATOMIC_DELETE_MAX_ROWS + 500 + 900);
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
});
