import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodes } from '../../db/schema.js';
import { makeNodeStack, createWorkspace, type TestStack } from './harness.js';

/**
 * Regression for #422: `GET /v1/nodes` read every historical row in a
 * workspace with no status filter, limit, or cursor, then hid offline rows
 * client-side. On a real workspace this meant fetching 6,298 rows and 3+MB
 * to show four live nodes.
 *
 * This suite seeds thousands of dead historical rows directly (bypassing the
 * full enroll/heartbeat HTTP flow purely for fixture speed) alongside a
 * small, deterministic live set, then proves:
 *   - the default live selection (`status=online`) returns exactly the live
 *     subset, never more, regardless of how much history exists;
 *   - explicit history pagination (`history=true`) visits and returns every
 *     historical row exactly once across pages, with no silent truncation;
 *   - the legacy unfiltered shape (no `status`/`history`) is preserved for
 *     existing callers.
 */
describe('bounded node list with thousands of historical rows (#422)', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(async () => { await stack.close(); });

  const HISTORY_ROWS = 4_000;
  const LIVE_ROWS = 4;

  async function seed(ws: { workspaceId: string }) {
    const db = stack.runtime.deps.db;
    const now = Date.now();

    // Thousands of dead historical rows: registered once, long stale.
    const historyRows = Array.from({ length: HISTORY_ROWS }, (_, i) => ({
      id: `node_history_${ws.workspaceId}_${String(i).padStart(6, '0')}`,
      workspaceId: ws.workspaceId,
      name: `history-${i}`,
      tokenHash: `history-token-hash-${ws.workspaceId}-${i}`,
      status: 'offline' as const,
      // Reported activity while alive; frozen once offline and must not be
      // read back as current occupancy (active_agents_stale semantics).
      activeAgents: (i % 3) + 1,
      lastHeartbeatAt: new Date(now - 10 * 24 * 60 * 60 * 1000 - i),
      createdAt: new Date(now - 10 * 24 * 60 * 60 * 1000 - i),
    }));
    const BATCH = 200;
    for (let i = 0; i < historyRows.length; i += BATCH) {
      await db.insert(nodes).values(historyRows.slice(i, i + BATCH));
    }

    // A handful of live nodes, heartbeated just now.
    const liveRows = Array.from({ length: LIVE_ROWS }, (_, i) => ({
      id: `node_live_${ws.workspaceId}_${i}`,
      workspaceId: ws.workspaceId,
      name: `live-${i}`,
      tokenHash: `live-token-hash-${ws.workspaceId}-${i}`,
      status: 'online' as const,
      activeAgents: i,
      lastHeartbeatAt: new Date(now),
      createdAt: new Date(now),
    }));
    await db.insert(nodes).values(liveRows);

    return { historyRows, liveRows };
  }

  it('visits and returns only the requested live subset by default, never the full history', async () => {
    const ws = await createWorkspace(stack.app, 'bounded-live-ws');
    const { liveRows } = await seed(ws);

    const roster = await stack.app.request('/v1/nodes?status=online', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(roster.status).toBe(200);
    const body = (await roster.json()) as { data: Array<Record<string, unknown>> };

    expect(body.data).toHaveLength(LIVE_ROWS);
    expect(new Set(body.data.map((n) => n.name))).toEqual(new Set(liveRows.map((r) => r.name)));
    for (const node of body.data) {
      expect(node.live).toBe(true);
      expect(node.status).toBe('online');
      expect(node.active_agents_stale).toBe(false);
    }

    // The SQL plan for the live path must seek the (workspace_id, status,
    // last_heartbeat_at) index, not scan every historical row.
    const plan = JSON.stringify(
      stack.runtime.handle.sqlite
        .prepare(
          `EXPLAIN QUERY PLAN SELECT * FROM nodes WHERE workspace_id = ? AND status = 'online'
             AND last_heartbeat_at IS NOT NULL AND last_heartbeat_at <= ? AND last_heartbeat_at >= ?`,
        )
        .all(ws.workspaceId, Date.now(), Date.now() - 45_000),
    );
    expect(plan).toContain('idx_nodes_status');
  });

  it('returns only the offline subset for status=offline, still scoped to this workspace', async () => {
    const ws = await createWorkspace(stack.app, 'bounded-offline-scope-ws');
    await seed(ws);
    const otherWs = await createWorkspace(stack.app, 'bounded-offline-other-ws');
    await seed(otherWs);

    const roster = await stack.app.request('/v1/nodes?status=offline&name=history-0', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(roster.status).toBe(200);
    const body = (await roster.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ name: 'history-0', live: false, active_agents_stale: true });
  });

  it('pages the full explicit history without gaps, duplicates, or silent truncation', async () => {
    const ws = await createWorkspace(stack.app, 'bounded-history-page-ws');
    const { historyRows, liveRows } = await seed(ws);
    const total = historyRows.length + liveRows.length;

    const seenIds = new Set<string>();
    const seenNames: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url = new URL('http://test/v1/nodes');
      url.searchParams.set('history', 'true');
      url.searchParams.set('limit', '250');
      if (cursor) url.searchParams.set('cursor', cursor);
      const res = await stack.app.request(url.pathname + '?' + url.searchParams.toString(), {
        headers: { authorization: `Bearer ${ws.workspaceKey}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { nodes: Array<{ id: string; name: string }>; next_cursor: string | null };
      };
      expect(body.data.nodes.length).toBeGreaterThan(0);
      expect(body.data.nodes.length).toBeLessThanOrEqual(250);
      for (const node of body.data.nodes) {
        expect(seenIds.has(node.id)).toBe(false); // no duplicate visits across pages
        seenIds.add(node.id);
        seenNames.push(node.name);
      }
      cursor = body.data.next_cursor;
      pages++;
      expect(pages).toBeLessThan(200); // guard against an infinite/non-terminating cursor
    } while (cursor);

    expect(seenIds.size).toBe(total); // every historical + live row visited exactly once
    expect(new Set(seenNames)).toEqual(
      new Set([...historyRows.map((r) => r.name), ...liveRows.map((r) => r.name)]),
    );
  });

  it('preserves the legacy unfiltered array shape for existing callers', async () => {
    const ws = await createWorkspace(stack.app, 'bounded-legacy-ws');
    const { historyRows, liveRows } = await seed(ws);

    const roster = await stack.app.request('/v1/nodes', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(roster.status).toBe(200);
    const body = (await roster.json()) as { data: unknown };
    expect(Array.isArray(body.data)).toBe(true);
    expect((body.data as unknown[]).length).toBe(historyRows.length + liveRows.length);
  });
});
