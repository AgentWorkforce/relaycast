import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_ROSTER_RECENCY_MS, listAgents } from '../../engine/agent.js';
import { configureNodeLiveness, inspectNodesLiveness } from '../../engine/nodeLiveness.js';
import { createWorkspace, makeNodeStack, type TestStack } from './harness.js';
import type { NodeLivenessSnapshot } from '../../ports/nodeLiveness.js';

// Rows a hosted (node-authority) roster holds in a large workspace: most are
// long-dead hosted sessions that resolve to offline whatever the node says.
const NOW = 1_800_000_000_000;
const STALE = (NOW - AGENT_ROSTER_RECENCY_MS) / 1_000 - 60;
const FRESH = NOW / 1_000;
const fixtures = [
  // name, status, status_before_liveness_loss, last_seen, node
  ['dead-1', 'offline', null, STALE, 'nd_dead'],
  ['dead-2', 'offline', null, STALE, 'nd_dead'],
  ['dead-3', 'offline', 'offline', STALE, 'nd_dead_2'],
  ['quiet-live', 'offline', 'active', STALE, 'nd_live'],
  ['quiet-waiting', 'offline', 'waiting', STALE, 'nd_live'],
  ['live-a', 'active', null, FRESH, 'nd_live'],
  ['live-b', 'idle', null, FRESH, 'nd_live'],
  ['live-c', 'waiting', null, FRESH, 'nd_live'],
  ['blocked-old', 'blocked', null, STALE, 'nd_live'],
] as const;

const live = (): NodeLivenessSnapshot => ({ status: 'online', providers: [{
  name: 'default', live: true, handlers_live: true, last_received_at: NOW - 1_000, expires_at: NOW + 45_000,
}] });

describe('hosted roster reads under node authority', () => {
  let stack: TestStack;
  let workspaceId: string;
  let workspaceKey: string;
  let inspected: string[];
  let materialized: number[];
  let statements: Array<{ source: string; params: unknown[] }>;

  beforeEach(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    stack = makeNodeStack();
    ({ workspaceId, workspaceKey } = await createWorkspace(stack.app, 'hosted-roster'));
    const sqlite = stack.runtime.handle.sqlite;
    const insertNode = sqlite.prepare('INSERT INTO nodes (id, workspace_id, name, token_hash) VALUES (?, ?, ?, ?)');
    for (const node of new Set(fixtures.map(row => row[4]))) insertNode.run(node, workspaceId, node, `hash-${node}`);
    const insert = sqlite.prepare(`
      INSERT INTO agents (id, workspace_id, name, token_hash, status, status_before_liveness_loss, last_seen, location_type, location_node_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'via_node', ?)
    `);
    for (const [name, status, before, lastSeen, node] of fixtures) {
      insert.run(`ag_${name}`, workspaceId, name, `hash-${name}`, status, before, lastSeen, node);
    }
    inspected = [];
    configureNodeLiveness(stack.runtime.deps.db, {
      inspect: async (_workspace, nodeId) => {
        inspected.push(nodeId);
        return nodeId === 'nd_live' ? live() : { status: 'offline', providers: [] };
      },
    });
    materialized = [];
    statements = [];
    const prepare = sqlite.prepare.bind(sqlite);
    vi.spyOn(sqlite, 'prepare').mockImplementation((source: string) => {
      const statement = prepare(source);
      if (/^select .* from "agents"/i.test(source)) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, 'all').mockImplementation((...params: unknown[]) => {
          const rows = all(...params);
          statements.push({ source, params });
          materialized.push(rows.length);
          return rows;
        });
      }
      return statement;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    stack.close();
  });

  const names = (rows: Array<{ name: string }>) => rows.map(row => row.name).sort();
  const get = (path: string, headers: Record<string, string> = {}) => stack.app.request(path, {
    headers: { authorization: `Bearer ${workspaceKey}`, ...headers },
  });

  it('leaves dead hosted rows out of the default roster without probing their nodes', async () => {
    const roster = await listAgents(stack.runtime.deps.db, workspaceId);
    expect(names(roster)).toEqual(['blocked-old', 'live-a', 'live-b', 'live-c', 'quiet-live', 'quiet-waiting']);
    expect(roster.find(row => row.name === 'quiet-live')?.status).toBe('active');
    // Six candidate rows on one node: one SELECT of six rows, one probe.
    expect(materialized).toEqual([6]);
    expect(inspected).toEqual(['nd_live']);
  });

  it('still lists every row with include_stale', async () => {
    const roster = await listAgents(stack.runtime.deps.db, workspaceId, 'all', { includeStale: true });
    expect(roster).toHaveLength(fixtures.length);
    expect(inspected.sort()).toEqual(['nd_dead', 'nd_dead_2', 'nd_live']);
  });

  it.each([
    ['active', ['live-a', 'quiet-live']],
    ['online', ['live-a', 'quiet-live']],
    ['waiting', ['live-c', 'quiet-waiting']],
    ['idle', ['live-b']],
    ['blocked', ['blocked-old']],
  ])('bounds status=%s in SQL to rows that can hold it', async (status, expected) => {
    const roster = await listAgents(stack.runtime.deps.db, workspaceId, status);
    expect(names(roster)).toEqual(expected);
    expect(materialized).toEqual([expected.length]);
    expect(inspected).toEqual(['nd_live']);
  });

  it('keeps the unbounded scan for status=offline, which any row can resolve to', async () => {
    const roster = await listAgents(stack.runtime.deps.db, workspaceId, 'offline');
    expect(names(roster)).toEqual(['dead-1', 'dead-2', 'dead-3']);
  });

  it('serves the roster SELECTs from the roster index', async () => {
    for (const status of [undefined, 'waiting', 'active']) await listAgents(stack.runtime.deps.db, workspaceId, status);
    expect(statements).toHaveLength(3);
    const sqlite = stack.runtime.handle.sqlite;
    vi.mocked(sqlite.prepare).mockRestore();
    for (const { source, params } of statements) {
      const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${source}`).all(...params) as Array<{ detail: string }>;
      expect(plan.map(step => step.detail).join('\n')).toMatch(/SEARCH agents USING INDEX idx_agents_roster \(workspace_id=/);
    }
  });

  describe('GET /v1/agents?names=', () => {
    it('returns the named agents, whatever their age, in one read', async () => {
      const response = await get('/v1/agents?names=dead-1&names=live-a&names=missing&names=live-a');
      expect(response.status).toBe(200);
      const body = await response.json() as { data: Array<{ name: string; status: string; metadata: unknown }> };
      expect(body.data.map(row => [row.name, row.status]).sort()).toEqual([['dead-1', 'offline'], ['live-a', 'active']]);
      expect(materialized).toEqual([2]);
      expect(inspected.sort()).toEqual(['nd_dead', 'nd_live']);
      const plan = stack.runtime.handle.sqlite.prepare(`EXPLAIN QUERY PLAN ${statements[0].source}`)
        .all(...statements[0].params) as Array<{ detail: string }>;
      expect(plan.map(step => step.detail).join('\n')).toMatch(/SEARCH agents USING INDEX (agents_workspace_name_unique|idx_agents_roster)/);
    });

    it('drops metadata on request', async () => {
      const body = await (await get('/v1/agents?names=live-a&include_metadata=0')).json() as { data: Array<{ metadata: unknown }> };
      expect(body.data).toEqual([expect.objectContaining({ metadata: {} })]);
    });

    it.each([
      ['/v1/agents?names=a&status=all'],
      ['/v1/agents?names=a&include_stale=1'],
      ['/v1/agents?names='],
      [`/v1/agents?${Array.from({ length: 101 }, (_, i) => `names=a${i}`).join('&')}`],
    ])('refuses %s', async (path) => {
      expect((await get(path)).status).toBe(400);
    });
  });

  describe('roster validators', () => {
    it('answers an unchanged roster with a bodiless 304 and a changed one with 200', async () => {
      const first = await get('/v1/agents?status=all');
      expect(first.status).toBe(200);
      const etag = first.headers.get('etag');
      expect(etag).toMatch(/^W\/"[0-9a-f]{32}"$/);
      const firstBody = await first.json() as { ok: boolean; data: unknown[] };
      expect(firstBody.ok).toBe(true);

      const unchanged = await get('/v1/agents?status=all', { 'if-none-match': etag! });
      expect(unchanged.status).toBe(304);
      expect(await unchanged.text()).toBe('');
      expect(unchanged.headers.get('etag')).toBe(etag);

      vi.mocked(stack.runtime.handle.sqlite.prepare).mockRestore();
      stack.runtime.handle.sqlite.prepare("UPDATE agents SET status = 'blocked' WHERE name = 'live-b'").run();
      const changed = await get('/v1/agents?status=all', { 'if-none-match': etag! });
      expect(changed.status).toBe(200);
      expect(changed.headers.get('etag')).not.toBe(etag);
    });
  });
});

describe('inspectNodesLiveness', () => {
  it('asks once per distinct node with at most eight in flight', async () => {
    const stack = makeNodeStack();
    try {
      const db = stack.runtime.deps.db;
      const asked: string[] = [];
      let active = 0; let peak = 0;
      configureNodeLiveness(db, { inspect: async (_w, id) => {
        asked.push(id); peak = Math.max(peak, ++active);
        await new Promise(resolve => setTimeout(resolve, 1));
        --active;
        return { status: 'offline', providers: [] };
      } });
      const ids = Array.from({ length: 40 }, (_, i) => `nd_${i % 20}`);
      const snapshots = await inspectNodesLiveness(db, 'ws', ids);
      expect(snapshots.size).toBe(20);
      expect(asked.sort()).toEqual([...new Set(ids)].sort());
      expect(peak).toBe(8);
      configureNodeLiveness(db);
      expect((await inspectNodesLiveness(db, 'ws', ids)).size).toBe(0);
    } finally {
      stack.close();
    }
  });
});
