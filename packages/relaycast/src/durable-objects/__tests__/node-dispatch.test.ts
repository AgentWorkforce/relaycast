import { describe, expect, it } from 'vitest';
import type { CloudflareBindings } from '../../env.js';
import { reconcileNodeInventory, sweepFleetInvocations } from '../node.js';

type AgentRow = {
  id: string;
  workspace_id: string;
  name: string;
  status: string;
  location_type: string;
  location_node_id: string | null;
  origin_node_id: string | null;
  session_ref: string | null;
};

type InvocationRow = {
  id: string;
  workspace_id: string;
  status: string;
  action_name: string;
  input: string | null;
  dispatched_node_id: string | null;
  dispatched_at: number | null;
  retry_after_at: number | null;
  attempted_node_ids: string;
  dispatch_attempts: number;
};

type NodeRow = {
  id: string;
  name: string;
  capabilities: string;
  max_agents: number;
  active_agents: number;
  reserved_agents: number;
  status: string;
  handlers_live: number;
  last_heartbeat_at: number;
  load: number;
};

class Stmt {
  private args: unknown[] = [];
  constructor(private readonly db: FakeDb, private readonly sql: string) {}
  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }
  all<T>() {
    return Promise.resolve({ results: this.db.all(this.sql, this.args) as T[] });
  }
  first<T>() {
    return Promise.resolve((this.db.all(this.sql, this.args)[0] ?? null) as T | null);
  }
  run() {
    this.db.run(this.sql, this.args);
    return Promise.resolve({ success: true });
  }
}

class FakeDb {
  agents: AgentRow[] = [];
  invocations: InvocationRow[] = [];
  nodes: NodeRow[] = [];

  prepare(sql: string) {
    return new Stmt(this, sql);
  }
  batch(statements: Stmt[]) {
    for (const s of statements) s.run();
    return Promise.resolve([]);
  }

  all(sql: string, args: unknown[]): unknown[] {
    if (sql.includes('FROM agents') && sql.includes("location_type = 'via_node'") && sql.includes("status = 'active'")) {
      const [workspaceId, nodeId] = args.map(String);
      return this.agents
        .filter((a) => a.workspace_id === workspaceId && a.location_type === 'via_node' && a.location_node_id === nodeId && a.status === 'active')
        .map((a) => ({ id: a.id, name: a.name }));
    }
    if (sql.includes('FROM action_invocations') && sql.includes('retry_after_at')) {
      const [dispatchCutoff, now] = args.map(Number);
      return this.invocations.filter((inv) =>
        (inv.status === 'dispatched' && inv.dispatched_at != null && inv.dispatched_at <= dispatchCutoff) ||
        (inv.status === 'pending' && inv.retry_after_at != null && inv.retry_after_at <= now),
      );
    }
    if (sql.includes('FROM nodes')) {
      return this.nodes.filter((n) => n.status === 'online' && n.handlers_live === 1);
    }
    return [];
  }

  run(sql: string, args: unknown[]) {
    // Guarded inventory claim.
    if (sql.includes("SET status = 'active'") && sql.includes("location_type = 'via_node'") && sql.includes('location_node_id = ?')) {
      const [, nodeId, originNode, sessionRef, workspaceId, name] = args;
      const agent = this.agents.find((a) => a.workspace_id === String(workspaceId) && a.name === String(name));
      if (!agent) return;
      const claimable =
        agent.location_node_id === String(nodeId) ||
        agent.status !== 'active' ||
        (agent.location_type === 'via_node' && agent.location_node_id == null);
      if (!claimable) return;
      agent.status = 'active';
      agent.location_type = 'via_node';
      agent.location_node_id = String(nodeId);
      agent.origin_node_id = agent.origin_node_id ?? String(originNode);
      if (sessionRef != null) agent.session_ref = String(sessionRef);
      return;
    }
    // Mark missing agent offline.
    if (sql.includes("SET status = 'offline'") && sql.includes('WHERE id = ?')) {
      const id = String(args[1]);
      const agent = this.agents.find((a) => a.id === id);
      if (agent) agent.status = 'offline';
      return;
    }
    // Dispatched CAS from rescheduleActionInvocation.
    if (sql.includes("SET status = 'dispatched'")) {
      const [nodeId, dispatchedAt, attempted, , invocationId] = args;
      const inv = this.invocations.find((i) => i.id === String(invocationId));
      if (!inv || !['pending', 'dispatched', 'invoked'].includes(inv.status)) return;
      inv.status = 'dispatched';
      inv.dispatched_node_id = String(nodeId);
      inv.dispatched_at = Number(dispatchedAt);
      inv.attempted_node_ids = String(attempted);
      inv.dispatch_attempts += 1;
      inv.retry_after_at = null;
      return;
    }
    // Pending-retry write when no candidate is available.
    if (sql.includes("SET status = 'pending'")) {
      const [attempted, retryAfter, , invocationId] = args;
      const inv = this.invocations.find((i) => i.id === String(invocationId));
      if (!inv) return;
      inv.status = 'pending';
      inv.dispatched_node_id = null;
      inv.dispatched_at = null;
      inv.attempted_node_ids = String(attempted);
      inv.retry_after_at = Number(retryAfter);
      return;
    }
  }
}

function envFor(db: FakeDb, sent?: unknown[]): CloudflareBindings {
  return {
    DB: db,
    NODE_DO: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          if (sent) sent.push(await request.json());
          return Response.json({ delivered: true });
        },
      }),
    },
  } as unknown as CloudflareBindings;
}

describe('reconcileNodeInventory single-active-location guard', () => {
  it('rejects hijacking an agent actively bound elsewhere (self_connected and another node)', async () => {
    const db = new FakeDb();
    db.agents.push(
      { id: 'a1', workspace_id: 'ws1', name: 'self-worker', status: 'active', location_type: 'self_connected', location_node_id: null, origin_node_id: null, session_ref: null },
      { id: 'a2', workspace_id: 'ws1', name: 'other-node-worker', status: 'active', location_type: 'via_node', location_node_id: 'node_other', origin_node_id: 'node_other', session_ref: null },
    );

    const result = await reconcileNodeInventory(envFor(db), 'ws1', 'node_this', [
      { agent_id: 'a1', name: 'self-worker' },
      { agent_id: 'a2', name: 'other-node-worker' },
    ]);

    // Neither was hijacked.
    expect(db.agents.find((a) => a.id === 'a1')?.location_node_id).toBe(null);
    expect(db.agents.find((a) => a.id === 'a1')?.location_type).toBe('self_connected');
    expect(db.agents.find((a) => a.id === 'a2')?.location_node_id).toBe('node_other');
    expect(result.rebound_agents).toBe(0);
    expect(result.rejected_agents.sort()).toEqual(['other-node-worker', 'self-worker']);
  });

  it('rebinds agents already on this node or not actively located', async () => {
    const db = new FakeDb();
    db.agents.push(
      { id: 'a1', workspace_id: 'ws1', name: 'mine', status: 'active', location_type: 'via_node', location_node_id: 'node_this', origin_node_id: 'node_this', session_ref: null },
      { id: 'a2', workspace_id: 'ws1', name: 'offline-worker', status: 'offline', location_type: 'via_node', location_node_id: 'node_other', origin_node_id: 'node_other', session_ref: null },
    );

    const result = await reconcileNodeInventory(envFor(db), 'ws1', 'node_this', [
      { agent_id: 'a1', name: 'mine' },
      { agent_id: 'a2', name: 'offline-worker' },
    ]);

    expect(db.agents.find((a) => a.id === 'a2')?.location_node_id).toBe('node_this');
    expect(db.agents.find((a) => a.id === 'a2')?.status).toBe('active');
    expect(result.rebound_agents).toBe(2);
    expect(result.rejected_agents).toEqual([]);
  });
});

describe('sweepFleetInvocations', () => {
  const now = 1_000_000;

  function liveNode(id: string): NodeRow {
    return {
      id,
      name: id,
      capabilities: JSON.stringify([{ name: 'github.pr.review' }]),
      max_agents: 4,
      active_agents: 0,
      reserved_agents: 0,
      status: 'online',
      handlers_live: 1,
      // Liveness is checked against the real Date.now() inside the port, so the
      // heartbeat must be genuinely recent (the synthetic `now` below only drives
      // the sweep's retry/timeout cutoffs).
      last_heartbeat_at: Math.floor(Date.now() / 1000),
      load: 0.1,
    };
  }

  it('re-dispatches a pending invocation whose retry_after_at has elapsed', async () => {
    const db = new FakeDb();
    db.nodes.push(liveNode('node_b'));
    db.invocations.push({
      id: 'inv_pending',
      workspace_id: 'ws1',
      status: 'pending',
      action_name: 'github.pr.review',
      input: '{}',
      dispatched_node_id: null,
      dispatched_at: null,
      retry_after_at: Math.floor(now / 1000) - 10, // due
      attempted_node_ids: JSON.stringify(['node_a']),
      dispatch_attempts: 1,
    });

    const sent: unknown[] = [];
    const rescheduled = await sweepFleetInvocations(envFor(db, sent), now);

    expect(rescheduled).toBe(1);
    expect(db.invocations[0].status).toBe('dispatched');
    expect(db.invocations[0].dispatched_node_id).toBe('node_b');
    expect(sent).toHaveLength(1);
  });

  it('re-dispatches a dispatched invocation that timed out (no reply past the dispatch timeout)', async () => {
    const db = new FakeDb();
    db.nodes.push(liveNode('node_b'));
    db.invocations.push({
      id: 'inv_stuck',
      workspace_id: 'ws1',
      status: 'dispatched',
      action_name: 'github.pr.review',
      input: '{}',
      dispatched_node_id: 'node_a',
      dispatched_at: Math.floor(now / 1000) - 120, // long past 30s timeout
      retry_after_at: null,
      attempted_node_ids: JSON.stringify(['node_a']),
      dispatch_attempts: 1,
    });

    const rescheduled = await sweepFleetInvocations(envFor(db, []), now);

    expect(rescheduled).toBe(1);
    expect(db.invocations[0].dispatched_node_id).toBe('node_b');
  });

  it('leaves a freshly dispatched invocation alone (within the dispatch timeout)', async () => {
    const db = new FakeDb();
    db.nodes.push(liveNode('node_b'));
    db.invocations.push({
      id: 'inv_fresh',
      workspace_id: 'ws1',
      status: 'dispatched',
      action_name: 'github.pr.review',
      input: '{}',
      dispatched_node_id: 'node_a',
      dispatched_at: Math.floor(now / 1000) - 1,
      retry_after_at: null,
      attempted_node_ids: JSON.stringify(['node_a']),
      dispatch_attempts: 1,
    });

    const rescheduled = await sweepFleetInvocations(envFor(db, []), now);
    expect(rescheduled).toBe(0);
    expect(db.invocations[0].dispatched_node_id).toBe('node_a');
  });
});
