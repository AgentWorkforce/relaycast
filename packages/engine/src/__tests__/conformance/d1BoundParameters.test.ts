import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  createWorkspace,
  D1_MAX_BOUND_PARAMETERS,
  enforceD1ParameterLimit,
  FakeSocket,
  makeNodeStack,
  rawGet,
  rawRun,
  registerAgent,
  type TestStack,
} from './harness.js';
import { agentNodeBindings, agents, deliveries } from '../../db/tables.js';

/** More than one D1-safe IN-list chunk, so a single statement would exceed the cap. */
const BULK_COUNT = 150;

/**
 * Bulk write paths whose ID lists scale with a node's or agent's backlog. Each
 * runs under D1's real bound-parameter ceiling, which better-sqlite3 does not
 * enforce on its own.
 */
describe('D1 bound-parameter cap on bulk writes', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(() => stack.close());

  async function bringNodeOnline(ws: { workspaceKey: string; workspaceId: string }, nodeId: string) {
    const res = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ node_id: nodeId, name: nodeId, role: 'broker', capabilities: ['spawn:claude'], max_agents: 4, tags: ['test'], version: 'v0' }),
    });
    expect(res.status).toBe(201);
    const sock = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, nodeId, sock);
    await handle.handleMessage(JSON.stringify({
      v: 1, type: 'node.register', name: nodeId, node_id: nodeId,
      capabilities: [{ name: 'spawn:claude', kind: 'capacity' }],
      max_agents: 4, tags: ['test'], version: 'v1', resume_cursor: null,
    }));
    await handle.handleMessage(JSON.stringify({
      v: 1, type: 'node.heartbeat', load: 0, active_agents: 0, handlers_live: true,
    }));
    return { sock, handle };
  }

  async function registerAgentViaNode(
    node: { sock: FakeSocket; handle: { handleMessage(raw: string): Promise<void> } },
    name: string,
  ): Promise<string> {
    await node.handle.handleMessage(JSON.stringify({ v: 1, type: 'agent.register', name, resumable: true }));
    const reply = node.sock.ofType('reply').at(-1) as { ok: boolean; data: { agent_id: string } };
    expect(reply?.ok).toBe(true);
    return reply.data.agent_id;
  }

  it('offlines every agent an inventory drops when the node hosted more than one IN-list chunk', async () => {
    const ws = await createWorkspace(stack.app, 'bulk-inventory');
    const node = await bringNodeOnline(ws, 'node_bulk');
    const keepId = await registerAgentViaNode(node, 'keep');

    const seedDb = stack.runtime.deps.db;
    const droppedIds: string[] = [];
    for (let index = 0; index < BULK_COUNT; index += 1) {
      const id = `agent_drop_${String(index).padStart(3, '0')}`;
      droppedIds.push(id);
      await rawRun(seedDb, `
      INSERT INTO agents (id, workspace_id, name, token_hash, status, location_type, location_node_id)
      VALUES (?, ?, ?, ?, 'online', 'via_node', ?)
    `, [id, ws.workspaceId, `drop-${index}`, `token-drop-${index}`, 'node_bulk']);
      await rawRun(seedDb, `
      INSERT INTO agent_node_bindings (id, workspace_id, agent_id, node_id, status)
      VALUES (?, ?, ?, ?, 'active')
    `, [`anb_drop_${index}`, ws.workspaceId, id, 'node_bulk']);
    }

    const guard = enforceD1ParameterLimit(stack);
    try {
      await node.handle.handleMessage(JSON.stringify({
        v: 1, type: 'inventory.sync', agents: [{ agent_id: keepId, name: 'keep' }],
      }));
      expect(guard.maxObserved()).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
    } finally {
      guard.restore();
    }

    const db = stack.runtime.deps.db;
    const activeBindings = await db.select({ agentId: agentNodeBindings.agentId })
      .from(agentNodeBindings)
      .where(and(eq(agentNodeBindings.nodeId, 'node_bulk'), eq(agentNodeBindings.status, 'active')));
    expect(activeBindings.map((row) => row.agentId)).toEqual([keepId]);

    const agentRows = await db.select({ id: agents.id, status: agents.status, locationNodeId: agents.locationNodeId })
      .from(agents)
      .where(eq(agents.workspaceId, ws.workspaceId));
    const dropped = agentRows.filter((row) => droppedIds.includes(row.id));
    expect(dropped).toHaveLength(BULK_COUNT);
    expect(dropped.every((row) => row.status === 'offline' && row.locationNodeId === null)).toBe(true);
  });

  it('acks a cumulative up_to_seq backlog larger than one IN-list chunk', async () => {
    const ws = await createWorkspace(stack.app, 'bulk-ack');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const node = await bringNodeOnline(ws, 'node_ack');
    const bobId = await registerAgentViaNode(node, 'bob');

    const seedDb = stack.runtime.deps.db;
    const { id: channelId } = (await rawGet<{ id: string }>(seedDb,
      `SELECT id FROM channels WHERE workspace_id = ? AND name = 'general'`,
      [ws.workspaceId]))!;
    for (let seq = 1; seq <= BULK_COUNT; seq += 1) {
      // Snowflake-shaped (numeric) like real message ids: the read cursor compares them numerically.
      const messageId = String(1_000_000_000 + seq);
      await rawRun(seedDb, `
      INSERT INTO messages (id, workspace_id, channel_id, agent_id, body)
      VALUES (?, ?, ?, ?, ?)
    `, [messageId, ws.workspaceId, channelId, alice.agentId, `bulk ${seq}`]);
      await rawRun(seedDb, `
      INSERT INTO deliveries (id, workspace_id, message_id, agent_id, status, seq, location_type, location_node_id)
      VALUES (?, ?, ?, ?, 'delivered', ?, 'via_node', ?)
    `, [`del_bulk_${seq}`, ws.workspaceId, messageId, bobId, seq, 'node_ack']);
    }
    await rawRun(seedDb, 'UPDATE agents SET delivery_seq = ? WHERE id = ?', [BULK_COUNT, bobId]);

    const guard = enforceD1ParameterLimit(stack);
    try {
      await node.handle.handleMessage(JSON.stringify({
        v: 1, type: 'delivery.ack', agent: 'bob', up_to_seq: BULK_COUNT,
      }));
      expect(guard.maxObserved()).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
    } finally {
      guard.restore();
    }

    const db = stack.runtime.deps.db;
    const acked = await db.select({ id: deliveries.id })
      .from(deliveries)
      .where(and(eq(deliveries.agentId, bobId), eq(deliveries.status, 'acked')));
    expect(acked).toHaveLength(BULK_COUNT);
    const [bob] = await db.select({ ackSeq: agents.deliveryAckSeq }).from(agents).where(eq(agents.id, bobId));
    expect(bob?.ackSeq).toBe(BULK_COUNT);
  });
});
