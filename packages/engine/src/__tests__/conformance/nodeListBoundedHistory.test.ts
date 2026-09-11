import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentNodeBindings, agents, nodes } from '../../db/schema.js';
import { makeNodeStack, createWorkspace, registerAgent, type TestStack } from './harness.js';

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
    expect(plan).toContain('idx_nodes_status_heartbeat');
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

/**
 * Regression for the observer-scoped follow-up to #422: an observer token's
 * `agent_ids` filter must be pushed into the same SQL query that computes the
 * page and `next_cursor` — not applied client-of-the-DB, one `listNodeAgents`
 * query per roster row, after a page already fixed which rows and which
 * cursor to return. Getting this wrong can (a) leak a hidden node's id via
 * `next_cursor`, (b) skip an authorized row or stop paging early once hidden
 * rows are filtered back out of an already-fixed page, and (c) costs one
 * query per node on a page instead of a bounded number of queries per page.
 */
describe('observer-authorized node history pagination (#422 follow-up)', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(async () => { await stack.close(); });

  async function createObserverToken(workspaceKey: string, agentIds: string[]) {
    const res = await stack.app.request('/v1/observer-tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
      body: JSON.stringify({
        name: 'node-roster-observer',
        scopes: ['nodes:read'],
        filters: { agent_ids: agentIds },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { token: string } };
    return body.data.token;
  }

  /** Seed `count` nodes, alternating an active binding to `allowedAgentId` (authorized/visible)
   * and `hiddenAgentId` (unauthorized/hidden) so pages mix both in an interleaved order. */
  async function seedInterleavedNodes(
    ws: { workspaceId: string },
    count: number,
    allowedAgentId: string,
    hiddenAgentId: string,
  ): Promise<{ authorizedNames: string[]; hiddenNames: string[] }> {
    const db = stack.runtime.deps.db;
    const now = new Date();
    const authorizedNames: string[] = [];
    const hiddenNames: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = `node_obs_${ws.workspaceId}_${String(i).padStart(4, '0')}`;
      const name = `obs-${i}`;
      const authorized = i % 2 === 0;
      await db.insert(nodes).values({
        id,
        workspaceId: ws.workspaceId,
        name,
        tokenHash: `obs-token-hash-${ws.workspaceId}-${i}`,
        status: 'offline',
        createdAt: now,
      });
      await db.insert(agentNodeBindings).values({
        id: `anb_obs_${ws.workspaceId}_${i}`,
        workspaceId: ws.workspaceId,
        agentId: authorized ? allowedAgentId : hiddenAgentId,
        nodeId: id,
        status: 'active',
      });
      if (authorized) authorizedNames.push(name); else hiddenNames.push(name);
    }
    return { authorizedNames, hiddenNames };
  }

  it('never leaks a hidden node into the page or next_cursor, and visits every authorized row exactly once across pages', async () => {
    const ws = await createWorkspace(stack.app, 'observer-history-paged-ws');
    const allowed = await registerAgent(stack.app, ws.workspaceKey, 'observer-allowed-agent');
    const hidden = await registerAgent(stack.app, ws.workspaceKey, 'observer-hidden-agent');
    const { authorizedNames, hiddenNames } = await seedInterleavedNodes(ws, 20, allowed.agentId, hidden.agentId);
    const observerToken = await createObserverToken(ws.workspaceKey, [allowed.agentId]);

    const sqlite = stack.runtime.handle.sqlite;
    const originalPrepare = sqlite.prepare.bind(sqlite);

    const seenIds = new Set<string>();
    const seenNames: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    let maxQueriesPerPage = 0;
    do {
      const url = new URL('http://test/v1/nodes');
      url.searchParams.set('history', 'true');
      url.searchParams.set('limit', '3');
      if (cursor) url.searchParams.set('cursor', cursor);

      let queryCount = 0;
      sqlite.prepare = ((sqlText: string) => {
        queryCount++;
        return originalPrepare(sqlText);
      }) as typeof sqlite.prepare;
      let res: Response;
      try {
        res = await stack.app.request(url.pathname + '?' + url.searchParams.toString(), {
          headers: { authorization: `Bearer ${observerToken}` },
        });
      } finally {
        sqlite.prepare = originalPrepare;
      }
      maxQueriesPerPage = Math.max(maxQueriesPerPage, queryCount);

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { nodes: Array<{ id: string; name: string }>; next_cursor: string | null };
      };
      for (const node of body.data.nodes) {
        // registerAgent implicitly creates its own direct node with an active
        // self-binding; scope these assertions to the `obs-*` fixture nodes.
        if (!node.name.startsWith('obs-')) continue;
        expect(hiddenNames).not.toContain(node.name); // never returned
        expect(seenIds.has(node.id)).toBe(false); // no duplicate visits across pages
        seenIds.add(node.id);
        seenNames.push(node.name);
      }
      cursor = body.data.next_cursor;
      pages++;
      expect(pages).toBeLessThan(50); // guard against non-termination
    } while (cursor);

    // Every authorized row visited exactly once; no hidden row ever surfaced,
    // and `next_cursor` never stalled before every authorized row was reached.
    expect(new Set(seenNames)).toEqual(new Set(authorizedNames));
    expect(pages).toBeGreaterThan(1); // actually exercised multi-page pagination

    // Bounded per-page query cost: a fixed small number of queries regardless
    // of how many rows are on the page, not one `listNodeAgents`-style query
    // per roster row (which would scale with the 3-row page/20-row workspace).
    expect(maxQueriesPerPage).toBeLessThan(10);
  });

  it('returns no rows and a null next_cursor when the observer is authorized for nothing on the page', async () => {
    const ws = await createWorkspace(stack.app, 'observer-history-empty-ws');
    const allowed = await registerAgent(stack.app, ws.workspaceKey, 'observer-allowed-agent-2');
    const hidden = await registerAgent(stack.app, ws.workspaceKey, 'observer-hidden-agent-2');
    await seedInterleavedNodes(ws, 6, allowed.agentId, hidden.agentId);
    // Authorized for an agent with no bindings at all: nothing should be visible.
    const stranger = await registerAgent(stack.app, ws.workspaceKey, 'observer-stranger-agent-2');
    const observerToken = await createObserverToken(ws.workspaceKey, [stranger.agentId]);

    const res = await stack.app.request('/v1/nodes?history=true&limit=3', {
      headers: { authorization: `Bearer ${observerToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { nodes: Array<{ name: string }>; next_cursor: string | null } };
    // The stranger's own implicit direct node is visible (self-binding), but
    // none of the seeded `obs-*` fixture nodes are — the observer has no
    // authorized binding to either the allowed or hidden fixture agent.
    expect(body.data.nodes.filter((node) => node.name.startsWith('obs-'))).toEqual([]);
    expect(body.data.next_cursor).toBeNull();
  });
});

/**
 * Regression: `?capability=` pushes a `json_each`/`json_extract` EXISTS
 * clause into SQL. `json_extract` raises SQLite's `malformed JSON` error when
 * evaluated against a legacy/primitive string capability array element (a
 * bare string like `read` is not itself valid JSON, unlike a quoted `"read"`)
 * — that shape is exactly what a plain-string capability list produces once
 * `json_each` unwraps the array. The condition must never let SQLite try
 * `json_extract` on a non-object element.
 */
describe('capability filter tolerates legacy/malformed capability shapes (#422 follow-up)', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(async () => { await stack.close(); });

  async function seedNode(ws: { workspaceId: string }, id: string, name: string, capabilities: unknown) {
    const db = stack.runtime.deps.db;
    await db.insert(nodes).values({
      id,
      workspaceId: ws.workspaceId,
      name,
      tokenHash: `cap-token-hash-${id}`,
      status: 'offline',
      // Bypass the JS-side `normalizeCapabilities` on purpose: this seeds the
      // exact on-disk shapes a pre-existing/legacy row can carry.
      capabilities: capabilities as never,
      createdAt: new Date(),
    });
  }

  it('matches legacy plain-string capability arrays without a malformed JSON error', async () => {
    const ws = await createWorkspace(stack.app, 'capability-legacy-string-ws');
    await seedNode(ws, 'node_cap_legacy_string', 'legacy-string-node', ['read', 'write']);
    await seedNode(ws, 'node_cap_object', 'object-node', [{ name: 'read' }]);
    await seedNode(ws, 'node_cap_other', 'other-node', ['other']);

    const res = await stack.app.request('/v1/nodes?capability=read', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ name: string }> };
    expect(new Set(body.data.map((n) => n.name))).toEqual(new Set(['legacy-string-node', 'object-node']));
  });

  it('matches a mixed string/object capability array on either shape without erroring', async () => {
    const ws = await createWorkspace(stack.app, 'capability-mixed-ws');
    await seedNode(ws, 'node_cap_mixed', 'mixed-node', ['read', { name: 'write' }]);

    const byString = await stack.app.request('/v1/nodes?capability=read', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(byString.status).toBe(200);
    expect(((await byString.json()) as { data: Array<{ name: string }> }).data.map((n) => n.name)).toEqual(['mixed-node']);

    const byObjectName = await stack.app.request('/v1/nodes?capability=write', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(byObjectName.status).toBe(200);
    expect(((await byObjectName.json()) as { data: Array<{ name: string }> }).data.map((n) => n.name)).toEqual(['mixed-node']);
  });

  it('does not error and matches nothing for a capability array holding non-JSON-object primitives alongside strings', async () => {
    const ws = await createWorkspace(stack.app, 'capability-malformed-ws');
    // `true`/`42` are valid JSON scalars (unlike a bare unquoted string) but
    // are still not objects, so `$.name` must never be extracted from them.
    await seedNode(ws, 'node_cap_scalars', 'scalars-node', ['keep-me', true, 42, null]);

    const res = await stack.app.request('/v1/nodes?capability=keep-me', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ name: string }> };
    expect(body.data.map((n) => n.name)).toEqual(['scalars-node']);

    const noMatch = await stack.app.request('/v1/nodes?capability=nonexistent', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(noMatch.status).toBe(200);
    expect(((await noMatch.json()) as { data: Array<{ name: string }> }).data).toEqual([]);
  });
});
