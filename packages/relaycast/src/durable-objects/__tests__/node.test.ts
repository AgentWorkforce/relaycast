import { describe, expect, it } from 'vitest';
import type { CloudflareBindings } from '../../env.js';
import { ackDeliveriesUpToSeq, completeActionInvocation } from '../node.js';

type InvocationRecord = {
  id: string;
  status: string;
  action_name: string;
  input: string | null;
  dispatched_node_id: string | null;
  attempted_node_ids: string | null;
  dispatch_attempts: number;
};

type NodeRecord = {
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

class FakeStatement {
  private args: unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly sql: string,
  ) {}

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  first<T>() {
    return Promise.resolve(this.db.first(this.sql, this.args) as T | null);
  }

  all<T>() {
    return Promise.resolve({ results: this.db.all(this.sql, this.args) as T[] });
  }

  run() {
    this.db.run(this.sql, this.args);
    return Promise.resolve({ success: true });
  }
}

class FakeD1 {
  invocations = new Map<string, InvocationRecord>();
  nodes = new Map<string, NodeRecord>();
  agents = new Map<string, { id: string; name: string; delivery_ack_seq: number; last_seen?: number }>();
  deliveries = new Map<string, { id: string; message_id: string; agent_id: string; seq: number; status: string; acked_at?: number }>();
  messages = new Map<string, { id: string; channel_id: string }>();
  readReceipts = new Set<string>();
  channelReads = new Map<string, string>();

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  batch(statements: FakeStatement[]) {
    for (const statement of statements) {
      statement.run();
    }
    return Promise.resolve([]);
  }

  first(sql: string, args: unknown[]) {
    if (sql.includes('FROM action_invocations')) {
      return this.invocations.get(String(args[1])) ?? null;
    }
    if (sql.includes('FROM agents') && sql.includes('delivery_ack_seq')) {
      const [workspaceId, agentName, nodeId] = args.map(String);
      return [...this.agents.values()].find((agent) =>
        workspaceId === 'rw_test' && agent.name === agentName && nodeId === 'node_broker',
      ) ?? null;
    }
    return null;
  }

  all(sql: string, args: unknown[]) {
    if (sql.includes('FROM nodes')) {
      return [...this.nodes.values()].filter((node) => node.status === 'online' && node.handlers_live === 1);
    }
    if (sql.includes('FROM action_invocations')) {
      const [workspaceId, nodeId] = args.map(String);
      if (workspaceId !== 'rw_test') return [];
      return [...this.invocations.values()].filter((invocation) =>
        invocation.dispatched_node_id === nodeId && ['pending', 'dispatched', 'invoked'].includes(invocation.status),
      );
    }
    if (sql.includes('FROM deliveries')) {
      const [_workspaceId, agentId, upToSeq] = args;
      return [...this.deliveries.values()]
        .filter((delivery) =>
          delivery.agent_id === agentId &&
          delivery.seq <= Number(upToSeq) &&
          !['acked', 'dead_lettered'].includes(delivery.status),
        )
        .map((delivery) => ({
          delivery_id: delivery.id,
          message_id: delivery.message_id,
          channel_id: this.messages.get(delivery.message_id)?.channel_id ?? '',
        }));
    }
    return [];
  }

  run(sql: string, args: unknown[]) {
    if (sql.includes('UPDATE nodes SET handlers_live = 0')) {
      const node = this.nodes.get(String(args[1]));
      if (node) node.handlers_live = 0;
      return;
    }

    if (sql.includes("SET status = 'dispatched'")) {
      const [nodeId, _dispatchedAt, attemptedNodeIds, _workspaceId, invocationId] = args;
      const invocation = this.invocations.get(String(invocationId));
      if (!invocation) return;
      invocation.status = 'dispatched';
      invocation.dispatched_node_id = String(nodeId);
      invocation.attempted_node_ids = String(attemptedNodeIds);
      invocation.dispatch_attempts += 1;
      return;
    }

    if (sql.includes("SET status = 'pending'")) {
      const [attemptedNodeIds, _retryAfterAt, _workspaceId, invocationId] = args;
      const invocation = this.invocations.get(String(invocationId));
      if (!invocation) return;
      invocation.status = 'pending';
      invocation.dispatched_node_id = null;
      invocation.attempted_node_ids = String(attemptedNodeIds);
      return;
    }

    if (sql.includes('SET output = ?')) {
      // Terminal completion CAS: only the first writer (status still open) wins.
      const [output, error, status, _completedAt, _workspaceId, invocationId] = args;
      const invocation = this.invocations.get(String(invocationId));
      if (!invocation || (invocation.status !== 'pending' && invocation.status !== 'dispatched')) return;
      invocation.status = String(status);
      (invocation as InvocationRecord & { output?: unknown; error?: unknown }).output = output ?? null;
      (invocation as InvocationRecord & { output?: unknown; error?: unknown }).error = error ?? null;
      return;
    }

    if (sql.includes('SET delivery_ack_seq')) {
      const [upToSeq, _upToSeqAgain, lastSeen, _workspaceId, agentId] = args;
      const agent = this.agents.get(String(agentId));
      if (!agent) return;
      agent.delivery_ack_seq = Math.max(agent.delivery_ack_seq, Number(upToSeq));
      agent.last_seen = Number(lastSeen);
      return;
    }

    if (sql.includes("SET status = 'acked'")) {
      const [ackedAt, _updatedAt, _workspaceId, deliveryId] = args;
      const delivery = this.deliveries.get(String(deliveryId));
      if (!delivery || ['acked', 'dead_lettered'].includes(delivery.status)) return;
      delivery.status = 'acked';
      delivery.acked_at = Number(ackedAt);
      return;
    }

    if (sql.includes('INSERT OR IGNORE INTO read_receipts')) {
      const [messageId, agentId] = args;
      this.readReceipts.add(`${messageId}:${agentId}`);
      return;
    }

    if (sql.includes('UPDATE channel_members')) {
      const [messageId, channelId, agentId] = args;
      this.channelReads.set(`${channelId}:${agentId}`, String(messageId));
    }
  }
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

describe('NodeDO fleet control handling', () => {
  it('reschedules handler_unavailable to another eligible node with the same invocation id', async () => {
    const db = new FakeD1();
    db.invocations.set('inv_1', {
      id: 'inv_1',
      status: 'dispatched',
      action_name: 'github.pr.review',
      input: JSON.stringify({ pull: 2090 }),
      dispatched_node_id: 'node_a',
      attempted_node_ids: '[]',
      dispatch_attempts: 0,
    });
    db.nodes.set('node_a', {
      id: 'node_a',
      name: 'node-a',
      capabilities: JSON.stringify([{ name: 'github.pr.review' }]),
      max_agents: 4,
      active_agents: 1,
      reserved_agents: 0,
      status: 'online',
      handlers_live: 1,
      last_heartbeat_at: nowSeconds(),
      load: 0.5,
    });
    db.nodes.set('node_b', {
      id: 'node_b',
      name: 'node-b',
      capabilities: JSON.stringify([{ name: 'github.pr.review' }]),
      max_agents: 4,
      active_agents: 0,
      reserved_agents: 0,
      status: 'online',
      handlers_live: 1,
      last_heartbeat_at: nowSeconds(),
      load: 0.1,
    });

    const sent: unknown[] = [];
    const env = {
      DB: db,
      NODE_DO: {
        idFromName: (name: string) => name,
        get: (_name: string) => ({
          fetch: async (request: Request) => {
            sent.push(await request.json());
            return Response.json({ delivered: true });
          },
        }),
      },
    } as unknown as CloudflareBindings;

    await completeActionInvocation(env, 'rw_test', 'node_a', {
      v: 1,
      type: 'action.result',
      invocation_id: 'inv_1',
      error: 'handler_unavailable',
    });

    expect(sent).toEqual([
      {
        v: 1,
        type: 'action.invoke',
        invocation_id: 'inv_1',
        action: 'github.pr.review',
        input: { pull: 2090 },
      },
    ]);
    expect(db.nodes.get('node_a')?.handlers_live).toBe(0);
    expect(db.invocations.get('inv_1')).toMatchObject({
      status: 'dispatched',
      dispatched_node_id: 'node_b',
      dispatch_attempts: 1,
    });
    expect(JSON.parse(db.invocations.get('inv_1')?.attempted_node_ids ?? '[]')).toEqual(['node_a', 'node_b']);
  });

  it('accepts a late SUCCESS from the originally-dispatched node after a reschedule (first-COMPLETED-wins)', async () => {
    const db = new FakeD1();
    // Invocation was dispatched to node_a, then rescheduled to node_b.
    db.invocations.set('inv_1', {
      id: 'inv_1',
      status: 'dispatched',
      action_name: 'github.pr.review',
      input: '{}',
      dispatched_node_id: 'node_b',
      attempted_node_ids: JSON.stringify(['node_a', 'node_b']),
      dispatch_attempts: 1,
    });
    const env = { DB: db } as unknown as CloudflareBindings;

    // node_a (the superseded node) reports a successful completion.
    await completeActionInvocation(env, 'rw_test', 'node_a', {
      v: 1,
      type: 'action.result',
      invocation_id: 'inv_1',
      output: { ok: true },
    });

    const result = db.invocations.get('inv_1') as InvocationRecord & { output?: unknown };
    expect(result.status).toBe('completed');
    expect(result.output).toBe(JSON.stringify({ ok: true }));
  });

  it('drops a late ERROR from a superseded node so it cannot fail a rescheduled invocation', async () => {
    const db = new FakeD1();
    db.invocations.set('inv_1', {
      id: 'inv_1',
      status: 'dispatched',
      action_name: 'github.pr.review',
      input: '{}',
      dispatched_node_id: 'node_b',
      attempted_node_ids: JSON.stringify(['node_a', 'node_b']),
      dispatch_attempts: 1,
    });
    const env = { DB: db } as unknown as CloudflareBindings;

    await completeActionInvocation(env, 'rw_test', 'node_a', {
      v: 1,
      type: 'action.result',
      invocation_id: 'inv_1',
      error: 'boom',
    });

    // Still owned by node_b; the stale error from node_a is ignored.
    expect(db.invocations.get('inv_1')?.status).toBe('dispatched');
  });

  it('acks via-node deliveries cumulatively and advances read state', async () => {
    const db = new FakeD1();
    db.agents.set('agent_1', { id: 'agent_1', name: 'worker', delivery_ack_seq: 0 });
    db.messages.set('msg_1', { id: 'msg_1', channel_id: 'chan_1' });
    db.messages.set('msg_2', { id: 'msg_2', channel_id: 'chan_1' });
    db.messages.set('msg_3', { id: 'msg_3', channel_id: 'chan_1' });
    db.deliveries.set('del_1', { id: 'del_1', message_id: 'msg_1', agent_id: 'agent_1', seq: 1, status: 'delivered' });
    db.deliveries.set('del_2', { id: 'del_2', message_id: 'msg_2', agent_id: 'agent_1', seq: 2, status: 'queued' });
    db.deliveries.set('del_3', { id: 'del_3', message_id: 'msg_3', agent_id: 'agent_1', seq: 3, status: 'queued' });

    const env = { DB: db } as unknown as CloudflareBindings;

    await ackDeliveriesUpToSeq(env, 'rw_test', 'node_broker', 'worker', 2);

    expect(db.agents.get('agent_1')?.delivery_ack_seq).toBe(2);
    expect(db.deliveries.get('del_1')?.status).toBe('acked');
    expect(db.deliveries.get('del_2')?.status).toBe('acked');
    expect(db.deliveries.get('del_3')?.status).toBe('queued');
    expect(db.readReceipts.has('msg_1:agent_1')).toBe(true);
    expect(db.readReceipts.has('msg_2:agent_1')).toBe(true);
    expect(db.channelReads.get('chan_1:agent_1')).toBe('msg_2');
  });
});
