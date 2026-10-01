import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { FLEET_DELIVERY_CURSOR_CAPABILITY } from '@relaycast/types';
import {
  createWorkspace,
  FakeSocket,
  makeNodeStack,
  registerAgent,
  type TestStack,
} from './harness.js';
import { agents, nodeProviders, nodes } from '../../db/schema.js';
import { NODE_LIVENESS_TTL_MS } from '../../engine/placement.js';
import { AGENT_LIVENESS_TTL_MS } from '../../engine/agent.js';

type Workspace = Awaited<ReturnType<typeof createWorkspace>>;

interface NodeAgent {
  agentId: string;
  name: string;
}

interface AttachedNode {
  id: string;
  name: string;
  sock: FakeSocket;
  handle: {
    handleMessage(raw: string): Promise<void>;
    handleClose(): Promise<void>;
  };
}

describe('node inventory presence isolation', () => {
  let stack: TestStack;

  beforeEach(() => {
    stack = makeNodeStack();
  });

  afterEach(() => stack.close());

  async function connectNode(
    ws: Workspace,
    id: string,
    name: string,
    providerName = 'broker',
  ): Promise<AttachedNode> {
    const sock = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, id, sock);
    await handle.handleMessage(JSON.stringify({
      v: 1,
      id: `register-${id}`,
      type: 'node.register',
      name,
      node_id: id,
      provider: { name: providerName, instance_id: `${id}-${providerName}` },
      capabilities: [
        { name: 'spawn:codex', kind: 'capacity' },
        { name: FLEET_DELIVERY_CURSOR_CAPABILITY, kind: 'capacity' },
      ],
      max_agents: 4,
      tags: ['inventory-presence-test'],
      version: 'inventory-presence-test',
      resume_cursor: null,
    }));
    const registerReply = sock.ofType('reply').find((frame) => frame.id === `register-${id}`);
    if (!registerReply) throw new Error(`node registration failed: ${JSON.stringify(sock.received)}`);
    expect(registerReply).toMatchObject({
      ok: true,
      data: { provider: { name: providerName } },
    });
    await handle.handleMessage(JSON.stringify({
      v: 1,
      id: `heartbeat-${id}`,
      type: 'node.heartbeat',
      provider: { name: providerName, instance_id: `${id}-${providerName}` },
      load: 0,
      active_agents: 0,
      handlers_live: true,
    }));

    return { id, name, sock, handle };
  }

  async function attachNode(ws: Workspace, id: string, name: string): Promise<AttachedNode> {
    const enrolled = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
      },
      body: JSON.stringify({
        node_id: id,
        name,
        capabilities: ['spawn:codex', FLEET_DELIVERY_CURSOR_CAPABILITY],
        max_agents: 4,
        version: 'inventory-presence-test',
      }),
    });
    expect(enrolled.status).toBe(201);
    return connectNode(ws, id, name);
  }

  async function reconnectNode(ws: Workspace, node: AttachedNode): Promise<AttachedNode> {
    await node.handle.handleClose();
    return connectNode(ws, node.id, node.name);
  }

  async function registerViaNode(node: AttachedNode, name: string): Promise<NodeAgent> {
    const requestId = `register-${node.id}-${name}`;
    await node.handle.handleMessage(JSON.stringify({
      v: 1,
      id: requestId,
      type: 'agent.register',
      name,
      resumable: true,
      session_ref: `session-${name}`,
    }));
    const reply = node.sock.ofType('reply').find((frame) => frame.id === requestId) as {
      ok: boolean;
      data: { agent_id: string };
    } | undefined;
    expect(reply).toMatchObject({ ok: true });
    return { agentId: reply!.data.agent_id, name };
  }

  async function expireAgents(agentIds: string[]): Promise<void> {
    await stack.runtime.handle.db
      .update(agents)
      .set({ lastSeen: new Date(Date.now() - AGENT_LIVENESS_TTL_MS - 1_000) })
      .where(inArray(agents.id, agentIds));
  }

  async function syncInventory(
    node: AttachedNode,
    requestId: string,
    inventory: NodeAgent[],
  ): Promise<void> {
    await node.handle.handleMessage(JSON.stringify({
      v: 1,
      id: requestId,
      type: 'inventory.sync',
      agents: inventory.map((agent) => ({
        agent_id: agent.agentId,
        name: agent.name,
        session_ref: `session-${agent.name}`,
      })),
    }));
  }

  async function postFrom(token: string, text: string): Promise<void> {
    const response = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ text }),
    });
    expect(response.status).toBe(201);
  }

  async function readAgent(ws: Workspace, name: string) {
    const response = await stack.app.request(`/v1/agents/${name}`, {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(response.status).toBe(200);
    return (await response.json() as {
      data: { status: string; pending_deliveries: Array<{ status: string }> };
    }).data;
  }

  async function ackFirstDelivery(node: AttachedNode, agent: NodeAgent): Promise<void> {
    const delivery = node.sock.ofType('deliver').find((frame) => frame.agent === agent.name) as {
      seq?: number;
    } | undefined;
    expect(delivery?.seq).toBeTypeOf('number');
    await node.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'delivery.ack',
      agent: agent.name,
      up_to_seq: delivery!.seq,
    }));
  }

  async function setProvider(agent: NodeAgent, providerName: string, status: 'active' | 'offline') {
    await stack.runtime.handle.db
      .update(agents)
      .set({ providerName, status })
      .where(eq(agents.id, agent.agentId));
  }

  it.each(['active', 'offline'] as const)(
    'adopts a %s same-node legacy default worker into the broker and restores delivery',
    async (status) => {
      const ws = await createWorkspace(stack.app, `inventory-legacy-default-${status}`);
      const sender = await registerAgent(stack.app, ws.workspaceKey, `legacy-sender-${status}`);
      let node = await attachNode(ws, `node_legacy_${status}`, `legacy-node-${status}`);
      const worker = await registerViaNode(node, `legacy-worker-${status}`);
      await setProvider(worker, 'default', status);

      node = await reconnectNode(ws, node);
      await syncInventory(node, `legacy-renewal-${status}`, [worker]);
      expect(node.sock.ofType('reply').find((frame) => frame.id === `legacy-renewal-${status}`)).toMatchObject({
        ok: true,
        data: { rebound_agents: 1, rejected_agents: 0 },
      });

      const [row] = await stack.runtime.handle.db
        .select({ status: agents.status, providerName: agents.providerName, locationNodeId: agents.locationNodeId })
        .from(agents)
        .where(eq(agents.id, worker.agentId));
      expect(row).toEqual({ status: 'active', providerName: 'broker', locationNodeId: node.id });

      node.sock.received.length = 0;
      await postFrom(sender.token, 'delivery after legacy adoption');
      expect(node.sock.ofType('deliver').filter((frame) => frame.agent === worker.name)).toHaveLength(1);
      await ackFirstDelivery(node, worker);
      expect((await readAgent(ws, worker.name)).pending_deliveries).toHaveLength(0);
    },
  );

  it('does not let a broker claim a worker while the default provider is live', async () => {
    const ws = await createWorkspace(stack.app, 'inventory-live-default-provider');
    const broker = await attachNode(ws, 'node_live_default', 'live-default-node');
    const legacy = await connectNode(ws, broker.id, broker.name, 'default');
    const worker = await registerViaNode(legacy, 'live-default-worker');

    await syncInventory(broker, 'live-default-claim', [worker]);
    expect(broker.sock.ofType('error').find((frame) => frame.id === 'live-default-claim')).toMatchObject({
      code: 'agent_provider_conflict',
    });
    const [row] = await stack.runtime.handle.db
      .select({ providerName: agents.providerName })
      .from(agents)
      .where(eq(agents.id, worker.agentId));
    expect(row.providerName).toBe('default');
  });

  it('adopts a worker after its persisted default provider disconnects', async () => {
    const ws = await createWorkspace(stack.app, 'inventory-disconnected-default-provider');
    const broker = await attachNode(ws, 'node_disconnected_default', 'disconnected-default-node');
    const legacy = await connectNode(ws, broker.id, broker.name, 'default');
    const worker = await registerViaNode(legacy, 'disconnected-default-worker');
    await legacy.handle.handleClose();

    await syncInventory(broker, 'disconnected-default-renewal', [worker]);
    expect(broker.sock.ofType('reply').find((frame) => frame.id === 'disconnected-default-renewal')).toMatchObject({
      ok: true,
      data: { rebound_agents: 1, rejected_agents: 0 },
    });
    const [row] = await stack.runtime.handle.db
      .select({ providerName: agents.providerName, status: agents.status })
      .from(agents)
      .where(eq(agents.id, worker.agentId));
    expect(row).toEqual({ providerName: 'broker', status: 'active' });
  });

  it('adopts a worker when the default provider heartbeat is in the future', async () => {
    const ws = await createWorkspace(stack.app, 'inventory-future-default');
    const broker = await attachNode(ws, 'node_future_default', 'future-default');
    const legacy = await connectNode(ws, broker.id, broker.name, 'default');
    const worker = await registerViaNode(legacy, 'future-default-worker');
    await stack.runtime.handle.db.update(nodeProviders)
      .set({ lastHeartbeatAt: new Date(Date.now() + 60_000) })
      .where(and(eq(nodeProviders.nodeId, broker.id), eq(nodeProviders.name, 'default')));

    await syncInventory(broker, 'future-default-adoption', [worker]);
    expect(broker.sock.ofType('reply').find((frame) => frame.id === 'future-default-adoption')).toMatchObject({
      ok: true,
      data: { rebound_agents: 1, rejected_agents: 0 },
    });
    const [row] = await stack.runtime.handle.db.select().from(agents).where(eq(agents.id, worker.agentId));
    expect(row.providerName).toBe('broker');
  });

  it.each(['offline', 'handlers-down', 'expired', 'future', 'missing-heartbeat', 'default-reconnected'])(
    'fences legacy adoption when provider liveness changes before the update: %s',
    async (change) => {
      const ws = await createWorkspace(stack.app, `inventory-race-${change}`);
      const broker = await attachNode(ws, 'node_race', 'race-node');
      const legacy = await connectNode(ws, broker.id, broker.name, 'default');
      const worker = await registerViaNode(legacy, 'race-worker');
      await legacy.handle.handleClose();
      await setProvider(worker, 'default', 'offline');
      await stack.settle();
      const db = stack.runtime.handle.db;
      const update = db.update.bind(db);
      let changed = false;
      // Change persisted liveness after validation, immediately before the
      // ownership update is built. The real database evaluates the CAS.
      const spy = vi.spyOn(db, 'update').mockImplementation((table) => {
        if (table === agents && !changed) {
          changed = true;
          update(nodeProviders).set(change === 'default-reconnected'
            ? { status: 'online', handlersLive: true, lastHeartbeatAt: new Date() }
            : change === 'offline' ? { status: 'offline' }
            : change === 'handlers-down' ? { handlersLive: false }
            : { lastHeartbeatAt: change === 'missing-heartbeat' ? null
              : new Date(Date.now() + (change === 'future' ? 60_000 : -NODE_LIVENESS_TTL_MS - 1_000)) })
            .where(and(eq(nodeProviders.nodeId, broker.id),
              eq(nodeProviders.name, change === 'default-reconnected' ? 'default' : 'broker'))).run();
        }
        return update(table);
      });
      try {
        await syncInventory(broker, 'race-adoption', [worker]);
        expect(changed).toBe(true);
        expect(broker.sock.ofType('error').find((frame) => frame.id === 'race-adoption')).toMatchObject({
          code: 'agent_provider_conflict',
        });
        const [row] = await db.select().from(agents).where(eq(agents.id, worker.agentId));
        expect(row).toMatchObject({ providerName: 'default', status: 'offline' });
      } finally {
        spy.mockRestore();
      }
    },
  );

  it('does not adopt a legacy worker with a wrong id or from another node', async () => {
    const ws = await createWorkspace(stack.app, 'inventory-legacy-foreign-claim');
    const owner = await attachNode(ws, 'node_legacy_owner', 'legacy-owner');
    const worker = await registerViaNode(owner, 'legacy-owned-worker');
    await setProvider(worker, 'default', 'offline');

    await syncInventory(owner, 'wrong-id-claim', [{ ...worker, agentId: 'agt_wrong_identity' }]);
    expect(owner.sock.ofType('error').find((frame) => frame.id === 'wrong-id-claim')).toMatchObject({
      code: 'agent_provider_conflict',
    });

    const foreign = await attachNode(ws, 'node_legacy_foreign', 'legacy-foreign');
    await syncInventory(foreign, 'foreign-node-claim', [worker]);
    expect(foreign.sock.ofType('error').find((frame) => frame.id === 'foreign-node-claim')).toMatchObject({
      code: 'agent_provider_conflict',
    });
    const [row] = await stack.runtime.handle.db
      .select({ providerName: agents.providerName, locationNodeId: agents.locationNodeId })
      .from(agents)
      .where(eq(agents.id, worker.agentId));
    expect(row).toEqual({ providerName: 'default', locationNodeId: owner.id });
  });

  it('does not transfer ownership from a different named provider', async () => {
    const ws = await createWorkspace(stack.app, 'inventory-named-provider-claim');
    const broker = await attachNode(ws, 'node_named_provider', 'named-provider-node');
    const worker = await registerViaNode(broker, 'named-provider-worker');
    await setProvider(worker, 'other-provider', 'offline');

    await syncInventory(broker, 'named-provider-claim', [worker]);
    expect(broker.sock.ofType('error').find((frame) => frame.id === 'named-provider-claim')).toMatchObject({
      code: 'agent_provider_conflict',
    });
    const [row] = await stack.runtime.handle.db
      .select({ providerName: agents.providerName })
      .from(agents)
      .where(eq(agents.id, worker.agentId));
    expect(row.providerName).toBe('other-provider');
  });

  it('does not let a sibling named provider adopt the legacy default identity', async () => {
    const ws = await createWorkspace(stack.app, 'inventory-sibling-provider-claim');
    const broker = await attachNode(ws, 'node_sibling_provider', 'sibling-provider-node');
    const worker = await registerViaNode(broker, 'sibling-provider-worker');
    await setProvider(worker, 'default', 'offline');
    const sibling = await connectNode(ws, broker.id, broker.name, 'sibling');

    await syncInventory(sibling, 'sibling-provider-claim', [worker]);
    expect(sibling.sock.ofType('error').find((frame) => frame.id === 'sibling-provider-claim')).toMatchObject({
      code: 'agent_provider_conflict',
    });
    const [row] = await stack.runtime.handle.db
      .select({ providerName: agents.providerName })
      .from(agents)
      .where(eq(agents.id, worker.agentId));
    expect(row.providerName).toBe('default');
  });

  it('keeps a healthy two-agent node active and drains both deliveries after inventory renewal', async () => {
    const ws = await createWorkspace(stack.app, 'inventory-presence-control');
    const sender = await registerAgent(stack.app, ws.workspaceKey, 'control-sender');
    let node = await attachNode(ws, 'node_control', 'control-node');
    const alpha = await registerViaNode(node, 'control-alpha');
    const beta = await registerViaNode(node, 'control-beta');

    const controlRows = await stack.runtime.handle.db
      .select({ name: agents.name, providerName: agents.providerName, locationNodeId: agents.locationNodeId })
      .from(agents)
      .where(inArray(agents.id, [alpha.agentId, beta.agentId]));
    expect(controlRows).toEqual(expect.arrayContaining([
      { name: alpha.name, providerName: 'broker', locationNodeId: node.id },
      { name: beta.name, providerName: 'broker', locationNodeId: node.id },
    ]));

    node = await reconnectNode(ws, node);
    await expireAgents([alpha.agentId, beta.agentId]);
    await syncInventory(node, 'control-renewal', [alpha, beta]);
    expect(node.sock.ofType('reply').find((frame) => frame.id === 'control-renewal')).toMatchObject({
      ok: true,
      data: { rebound_agents: 2 },
    });

    node.sock.received.length = 0;
    await postFrom(sender.token, 'control delivery');
    expect(node.sock.ofType('deliver').filter((frame) => frame.agent === alpha.name)).toHaveLength(1);
    expect(node.sock.ofType('deliver').filter((frame) => frame.agent === beta.name)).toHaveLength(1);
    await ackFirstDelivery(node, alpha);
    await ackFirstDelivery(node, beta);

    for (const agent of [alpha, beta]) {
      const state = await readAgent(ws, agent.name);
      expect(state.status).toBe('active');
      expect(state.pending_deliveries).toHaveLength(0);
    }
  });

  it('keeps valid node siblings active and draining when one inventory member conflicts', async () => {
    const ws = await createWorkspace(stack.app, 'inventory-presence-poisoned-batch');
    const sender = await registerAgent(stack.app, ws.workspaceKey, 'poisoned-sender');
    const conflictingNode = await attachNode(ws, 'node_conflict', 'conflicting-node');
    const conflicting = await registerViaNode(conflictingNode, 'chief');
    let node = await attachNode(ws, 'node_poisoned', 'poisoned-node');
    const alpha = await registerViaNode(node, 'poisoned-alpha');
    const beta = await registerViaNode(node, 'poisoned-beta');

    const [conflictingRow] = await stack.runtime.handle.db
      .select({ status: agents.status, providerName: agents.providerName, locationNodeId: agents.locationNodeId })
      .from(agents)
      .where(and(eq(agents.workspaceId, ws.workspaceId), eq(agents.id, conflicting.agentId)));
    const [conflictingNodeRow] = await stack.runtime.handle.db
      .select({ status: nodes.status, lastHeartbeatAt: nodes.lastHeartbeatAt })
      .from(nodes)
      .where(and(eq(nodes.workspaceId, ws.workspaceId), eq(nodes.id, conflictingNode.id)));
    expect(conflictingRow).toEqual({
      status: 'active',
      providerName: 'broker',
      locationNodeId: conflictingNode.id,
    });
    expect(conflictingNodeRow).toMatchObject({ status: 'online' });

    node = await reconnectNode(ws, node);
    await expireAgents([alpha.agentId, beta.agentId]);
    await syncInventory(node, 'poisoned-renewal', [
      alpha,
      beta,
      { agentId: conflicting.agentId, name: conflicting.name },
    ]);
    expect(node.sock.ofType('reply').find((frame) => frame.id === 'poisoned-renewal')).toMatchObject({
      ok: true,
      data: { rebound_agents: 2, rejected_agents: 1 },
    });
    expect(node.sock.ofType('error').find((frame) => frame.id === 'poisoned-renewal')).toBeUndefined();

    node.sock.received.length = 0;
    await postFrom(sender.token, 'delivery despite one rejected inventory member');
    expect(node.sock.ofType('deliver').filter((frame) => frame.agent === alpha.name)).toHaveLength(1);
    expect(node.sock.ofType('deliver').filter((frame) => frame.agent === beta.name)).toHaveLength(1);
    await ackFirstDelivery(node, alpha);
    await ackFirstDelivery(node, beta);

    for (const agent of [alpha, beta]) {
      const state = await readAgent(ws, agent.name);
      expect(state.status).toBe('active');
      expect(state.pending_deliveries).toHaveLength(0);
    }

    const rejected = await readAgent(ws, conflicting.name);
    expect(rejected.status).toBe('active');
  });

  it('keeps an active same-node agent online when its own inventory entry reports a wrong agent_id', async () => {
    const ws = await createWorkspace(stack.app, 'inventory-presence-identity-drift');
    const sender = await registerAgent(stack.app, ws.workspaceKey, 'drift-sender');
    const node = await attachNode(ws, 'node_drift', 'drift-node');
    const sibling = await registerViaNode(node, 'drift-sibling');
    const drifted = await registerViaNode(node, 'drift-identity');

    // Both rows are live on this node when the mixed snapshot arrives: the
    // sibling renews cleanly while the drifted member is still running here
    // but claims a WRONG agent_id for its own registered name. The member is
    // present — only its identity claim is wrong — so rejecting it must NOT
    // let the missing-agent sweep take the real live row offline.
    await syncInventory(node, 'drift-renewal', [
      sibling,
      { agentId: 'agt_wrong_identity', name: drifted.name },
    ]);
    expect(node.sock.ofType('reply').find((frame) => frame.id === 'drift-renewal')).toMatchObject({
      ok: true,
      data: { rebound_agents: 1, rejected_agents: 1 },
    });
    expect(node.sock.ofType('error').find((frame) => frame.id === 'drift-renewal')).toBeUndefined();

    const driftedRow = await stack.runtime.handle.db
      .select({ status: agents.status })
      .from(agents)
      .where(and(eq(agents.workspaceId, ws.workspaceId), eq(agents.id, drifted.agentId)));
    expect(driftedRow).toEqual([{ status: 'active' }]);

    node.sock.received.length = 0;
    await postFrom(sender.token, 'delivery while one member drifts');
    expect(node.sock.ofType('deliver').filter((frame) => frame.agent === sibling.name)).toHaveLength(1);
    await ackFirstDelivery(node, sibling);

    const siblingState = await readAgent(ws, sibling.name);
    expect(siblingState.status).toBe('active');
    expect(siblingState.pending_deliveries).toHaveLength(0);

    const driftedState = await readAgent(ws, drifted.name);
    expect(driftedState.status).toBe('active');
  });

  it('keeps an all-untrusted inventory fail-closed when it also contains an unknown name', async () => {
    const ws = await createWorkspace(stack.app, 'inventory-presence-all-untrusted');
    const conflictingNode = await attachNode(ws, 'node_conflict_only', 'conflicting-node-only');
    const conflicting = await registerViaNode(conflictingNode, 'already-live');
    const node = await attachNode(ws, 'node_untrusted', 'untrusted-node');

    await syncInventory(node, 'all-untrusted-renewal', [
      { agentId: 'agt_unknown', name: 'unknown-agent' },
      { agentId: conflicting.agentId, name: conflicting.name },
    ]);

    expect(node.sock.ofType('error').find((frame) => frame.id === 'all-untrusted-renewal')).toMatchObject({
      code: 'agent_location_conflict',
    });
    expect(node.sock.ofType('reply').find((frame) => frame.id === 'all-untrusted-renewal')).toBeUndefined();
  });
});
