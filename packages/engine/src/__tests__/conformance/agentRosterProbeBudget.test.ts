import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listAgents } from '../../engine/agent.js';
import { NODE_ONLINE_CANDIDATE_RECENCY_MS } from '../../engine/node.js';
import { configureNodeLiveness, inspectNodesLiveness, NODE_LIVENESS_PROBE_BUDGET_MS } from '../../engine/nodeLiveness.js';
import { AGENT_LIVENESS_TTL_MS } from '../../engine/agent.js';
import { createWorkspace, makeNodeStack, type TestStack } from './harness.js';
import type { NodeLivenessSnapshot } from '../../ports/nodeLiveness.js';

// A large roster under node authority: hundreds of nodes, each probe a remote
// call with its own deadline. One list request probes within a fixed budget.
const NOW = 1_800_000_000_000;
const SEC = (ms: number) => Math.floor(ms / 1_000);
const FRESH = SEC(NOW);
/** Agent silence past the presence TTL: only the authority (or a checkpoint) keeps it present. */
const QUIET = SEC(NOW - AGENT_LIVENESS_TTL_MS) - 60;
/** A checkpoint outside the bound any authority-online node keeps. */
const DEAD = SEC(NOW - NODE_ONLINE_CANDIDATE_RECENCY_MS) - 60;

const live = (): NodeLivenessSnapshot => ({ status: 'online', providers: [{
  name: 'default', live: true, handlers_live: true, last_received_at: NOW - 1_000, expires_at: NOW + 45_000,
}] });
const never = () => new Promise<NodeLivenessSnapshot>(() => {});

describe('roster liveness probe budget', () => {
  let stack: TestStack;
  let workspaceId: string;
  let workspaceKey: string;
  let inspected: string[];
  let inspect: (nodeId: string) => Promise<NodeLivenessSnapshot>;

  beforeEach(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    stack = makeNodeStack();
    ({ workspaceId, workspaceKey } = await createWorkspace(stack.app, 'probe-budget'));
    inspected = [];
    inspect = async () => live();
    configureNodeLiveness(stack.runtime.deps.db, {
      inspect: (_workspace, nodeId) => { inspected.push(nodeId); return inspect(nodeId); },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    stack.close();
  });

  const sqlite = () => stack.runtime.handle.sqlite;
  function node(id: string, status: 'online' | 'offline', heartbeat: number | null) {
    sqlite().prepare('INSERT INTO nodes (id, workspace_id, name, token_hash, status, last_heartbeat_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, workspaceId, id, `hash-${id}`, status, heartbeat);
  }
  function agent(name: string, status: string, lastSeen: number, nodeId: string, before: string | null = null) {
    sqlite().prepare(`
      INSERT INTO agents (id, workspace_id, name, token_hash, status, status_before_liveness_loss, last_seen, location_type, location_node_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'via_node', ?)
    `).run(`ag_${name}`, workspaceId, name, `hash-${name}`, status, before, lastSeen, nodeId);
  }
  /** A direct agent, on its implicit node checkpointed as given. */
  function directAgent(name: string, status: string, lastSeen: number, nodeStatus: 'online' | 'offline', heartbeat: number | null, before: string | null = null) {
    node(`node_direct_ag_${name}`, nodeStatus, heartbeat);
    agent(name, status, lastSeen, `node_direct_ag_${name}`, before);
  }
  const statusOf = (rows: Array<{ name: string; status: string }>) => Object.fromEntries(rows.map(row => [row.name, row.status]));

  it('budget not exhausted: every candidate node is probed and the authority decides, as before', async () => {
    node('nd_hosted_live', 'online', FRESH);
    node('nd_hosted_lost', 'online', FRESH);
    agent('hosted-live', 'offline', QUIET, 'nd_hosted_live', 'waiting');
    agent('hosted-lost', 'active', FRESH, 'nd_hosted_lost');
    directAgent('direct-live', 'active', QUIET, 'online', FRESH);
    directAgent('direct-gone', 'active', QUIET, 'offline', FRESH);
    inspect = async nodeId => nodeId === 'nd_hosted_lost' || nodeId === 'node_direct_ag_direct-gone'
      ? { status: 'offline', providers: [] } : live();

    const roster = await listAgents(stack.runtime.deps.db, workspaceId, 'all', { includeStale: true });
    expect(statusOf(roster)).toEqual({
      'hosted-live': 'waiting', 'hosted-lost': 'offline', 'direct-live': 'active', 'direct-gone': 'offline',
    });
    expect(inspected.sort()).toEqual(['nd_hosted_live', 'nd_hosted_lost', 'node_direct_ag_direct-gone', 'node_direct_ag_direct-live']);
  });

  it('budget exhausted mid-way: unprobed nodes resolve from their checkpoint, never offline for want of a probe', async () => {
    // 24 direct agents, quiet past the presence TTL, on nodes checkpointed online.
    for (let i = 0; i < 24; i += 1) directAgent(`d${String(i).padStart(2, '0')}`, 'active', QUIET, 'online', FRESH - i);
    // Lower priority, never reached: a hosted node checkpointed offline.
    node('nd_hosted_down', 'offline', FRESH);
    agent('hosted-down', 'idle', FRESH, 'nd_hosted_down');
    // Eight answer at once; the next eight hang past the budget.
    let answered = 0;
    inspect = async () => (answered++ < 8 ? { status: 'offline', providers: [] } : never());

    const started = performance.now();
    const roster = await listAgents(stack.runtime.deps.db, workspaceId, 'all', { includeStale: true, livenessProbeBudgetMs: 50 });
    expect(performance.now() - started).toBeLessThan(NODE_LIVENESS_PROBE_BUDGET_MS);

    const statuses = statusOf(roster);
    // Probed in priority order (freshest checkpoint first): d00-d07 answered offline.
    expect(inspected).toEqual(Array.from({ length: 16 }, (_, i) => `node_direct_ag_d${String(i).padStart(2, '0')}`));
    for (let i = 0; i < 8; i += 1) expect(statuses[`d0${i}`]).toBe('offline');
    // d08-d15 hung, d16-d23 were never asked: their checkpoints say online.
    for (let i = 8; i < 24; i += 1) expect(statuses[`d${String(i).padStart(2, '0')}`]).toBe('active');
    // An unprobed hosted row keeps what its checkpoint supports.
    expect(statuses['hosted-down']).toBe('offline');
  });

  it('unprobed hosted agents keep their stored status, restoring work state saved at a liveness loss', async () => {
    node('nd_up', 'online', FRESH - 120);
    agent('hosted-up', 'blocked', QUIET, 'nd_up');
    agent('hosted-restored', 'offline', QUIET, 'nd_up', 'waiting');
    inspect = never;
    const roster = await listAgents(stack.runtime.deps.db, workspaceId, 'all', { includeStale: true, livenessProbeBudgetMs: 20 });
    expect(statusOf(roster)).toEqual({ 'hosted-up': 'blocked', 'hosted-restored': 'waiting' });
  });

  it('probes checkpointed-online nodes first, freshest first, and skips nodes no authority can report online', async () => {
    node('nd_offline_fresh', 'offline', FRESH);
    node('nd_online_old', 'online', FRESH - 300);
    node('nd_online_new', 'online', FRESH);
    node('nd_dead', 'online', DEAD);
    node('nd_never', 'offline', null);
    agent('a-offline-fresh', 'active', FRESH, 'nd_offline_fresh');
    agent('a-online-old', 'active', FRESH, 'nd_online_old');
    agent('a-dead', 'offline', FRESH, 'nd_dead', 'active');
    agent('a-never', 'active', FRESH, 'nd_never');
    agent('a-online-new', 'active', FRESH, 'nd_online_new');

    const roster = await listAgents(stack.runtime.deps.db, workspaceId, 'all', { includeStale: true });
    expect(inspected).toEqual(['nd_online_new', 'nd_online_old', 'nd_offline_fresh', 'nd_never']);
    // The dead checkpoint resolves offline unprobed; the authority would have said the same.
    expect(statusOf(roster)['a-dead']).toBe('offline');
    expect(statusOf(roster)['a-online-new']).toBe('active');
  });

  it('GET /v1/agents?names= is unaffected', async () => {
    node('nd_live', 'online', FRESH);
    agent('named-live', 'offline', QUIET, 'nd_live', 'idle');
    directAgent('named-direct', 'active', QUIET, 'online', FRESH);
    for (let i = 0; i < 20; i += 1) directAgent(`other-${i}`, 'active', FRESH, 'online', FRESH);
    const response = await stack.app.request('/v1/agents?names=named-live&names=named-direct', {
      headers: { authorization: `Bearer ${workspaceKey}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: Array<{ name: string; status: string }> };
    expect(statusOf(body.data)).toEqual({ 'named-live': 'idle', 'named-direct': 'active' });
    expect(inspected.sort()).toEqual(['nd_live', 'node_direct_ag_named-direct']);
  });
});

describe('inspectNodesLiveness budget', () => {
  it('returns within the budget, omitting nodes whose probe did not answer', async () => {
    const stack = makeNodeStack();
    try {
      const db = stack.runtime.deps.db;
      const asked: string[] = [];
      configureNodeLiveness(db, { inspect: async (_w, id) => {
        asked.push(id);
        return id === 'nd_slow' ? never() : { status: 'offline', providers: [] };
      } });
      const ids = ['nd_a', 'nd_slow', ...Array.from({ length: 30 }, (_, i) => `nd_${i}`)];
      const started = performance.now();
      const snapshots = await inspectNodesLiveness(db, 'ws', ids, { budgetMs: 30 });
      expect(performance.now() - started).toBeLessThan(500);
      // The other workers drained the queue; only the hung probe is missing.
      expect(snapshots.has('nd_slow')).toBe(false);
      expect(snapshots.size).toBe(ids.length - 1);
      expect(asked).toHaveLength(ids.length);

      configureNodeLiveness(db, { inspect: () => never() });
      const empty = await inspectNodesLiveness(db, 'ws', ids, { budgetMs: 20 });
      expect(empty.size).toBe(0);
    } finally {
      stack.close();
    }
  });
});
