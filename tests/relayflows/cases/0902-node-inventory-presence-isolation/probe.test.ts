import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { FLEET_DELIVERY_CURSOR_CAPABILITY } from '@relaycast/types';
import {
  createWorkspace,
  FakeSocket,
  makeNodeStack,
  registerAgent,
  type TestStack,
} from './harness.js';
import { agents } from '../../db/schema.js';
import { AGENT_LIVENESS_TTL_MS } from '../../engine/agent.js';

const ARM = process.env.RELAY_PR_PROOF_ARM;
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

describe('RelayFlow node inventory presence isolation proof', () => {
  let stack: TestStack;

  beforeEach(() => {
    stack = makeNodeStack();
  });

  afterEach(() => stack.close());

  async function connectNode(ws: Workspace, id: string, name: string): Promise<AttachedNode> {
    const sock = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, id, sock);
    await handle.handleMessage(JSON.stringify({
      v: 1,
      id: `register-${id}`,
      type: 'node.register',
      name,
      node_id: id,
      provider: { name: 'broker', instance_id: `${id}-${crypto.randomUUID()}` },
      capabilities: [
        { name: 'spawn:codex', kind: 'capacity' },
        { name: FLEET_DELIVERY_CURSOR_CAPABILITY, kind: 'capacity' },
      ],
      max_agents: 4,
      tags: ['relayflow-inventory-proof'],
      version: 'relayflow-inventory-proof',
      resume_cursor: null,
    }));
    expect(sock.ofType('reply').find((frame) => frame.id === `register-${id}`)).toMatchObject({ ok: true });
    await handle.handleMessage(JSON.stringify({
      v: 1,
      id: `heartbeat-${id}`,
      type: 'node.heartbeat',
      load: 0,
      active_agents: 0,
      handlers_live: true,
    }));
    return { id, name, sock, handle };
  }

  async function attachNode(ws: Workspace, id: string, name: string): Promise<AttachedNode> {
    const response = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({
        node_id: id,
        name,
        capabilities: ['spawn:codex', FLEET_DELIVERY_CURSOR_CAPABILITY],
        max_agents: 4,
        version: 'relayflow-inventory-proof',
      }),
    });
    expect(response.status).toBe(201);
    return connectNode(ws, id, name);
  }

  async function reconnectNode(ws: Workspace, node: AttachedNode): Promise<AttachedNode> {
    await node.handle.handleClose();
    return connectNode(ws, node.id, node.name);
  }

  async function registerViaNode(node: AttachedNode, name: string): Promise<NodeAgent> {
    const id = `register-${node.id}-${name}`;
    await node.handle.handleMessage(JSON.stringify({
      v: 1,
      id,
      type: 'agent.register',
      name,
      resumable: true,
      session_ref: `session-${name}`,
    }));
    const reply = node.sock.ofType('reply').find((frame) => frame.id === id) as {
      data?: { agent_id?: string };
    } | undefined;
    expect(reply?.data?.agent_id).toBeTypeOf('string');
    return { agentId: reply!.data!.agent_id!, name };
  }

  async function expire(agentIds: string[]): Promise<void> {
    await stack.runtime.handle.db
      .update(agents)
      .set({ lastSeen: new Date(Date.now() - AGENT_LIVENESS_TTL_MS - 1_000) })
      .where(inArray(agents.id, agentIds));
  }

  async function sync(node: AttachedNode, id: string, inventory: NodeAgent[]): Promise<void> {
    await node.handle.handleMessage(JSON.stringify({
      v: 1,
      id,
      type: 'inventory.sync',
      agents: inventory.map((agent) => ({ agent_id: agent.agentId, name: agent.name })),
    }));
  }

  async function post(token: string, text: string): Promise<void> {
    const response = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ text }),
    });
    expect(response.status).toBe(201);
  }

  async function read(ws: Workspace, name: string) {
    const response = await stack.app.request(`/v1/agents/${name}`, {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(response.status).toBe(200);
    return (await response.json() as {
      data: { status: string; pending_deliveries: Array<{ status: string }> };
    }).data;
  }

  async function ack(node: AttachedNode, agent: NodeAgent): Promise<void> {
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

  it('must-not-fire control: a healthy node renews and drains both siblings', async () => {
    const ws = await createWorkspace(stack.app, 'relayflow-inventory-control');
    const sender = await registerAgent(stack.app, ws.workspaceKey, 'control-sender');
    let node = await attachNode(ws, 'node_control', 'control-node');
    const alpha = await registerViaNode(node, 'control-alpha');
    const beta = await registerViaNode(node, 'control-beta');

    node = await reconnectNode(ws, node);
    await expire([alpha.agentId, beta.agentId]);
    await sync(node, 'control-sync', [alpha, beta]);
    expect(node.sock.ofType('reply').find((frame) => frame.id === 'control-sync')).toMatchObject({
      ok: true,
      data: { rebound_agents: 2 },
    });

    node.sock.received.length = 0;
    await post(sender.token, 'control');
    await ack(node, alpha);
    await ack(node, beta);
    for (const agent of [alpha, beta]) {
      expect(await read(ws, agent.name)).toMatchObject({ status: 'active', pending_deliveries: [] });
    }
  });

  it('observes the base node-wide queue or the isolated head behavior', async () => {
    expect(['base', 'head']).toContain(ARM);
    const ws = await createWorkspace(stack.app, 'relayflow-inventory-poison');
    const sender = await registerAgent(stack.app, ws.workspaceKey, 'poison-sender');
    const incumbentNode = await attachNode(ws, 'node_incumbent', 'incumbent-node');
    const poison = await registerViaNode(incumbentNode, 'chief');
    let node = await attachNode(ws, 'node_poisoned', 'poisoned-node');
    const alpha = await registerViaNode(node, 'poisoned-alpha');
    const beta = await registerViaNode(node, 'poisoned-beta');

    node = await reconnectNode(ws, node);
    await expire([alpha.agentId, beta.agentId]);
    await sync(node, 'poisoned-sync', [alpha, beta, poison]);

    if (ARM === 'base') {
      expect(node.sock.ofType('error').find((frame) => frame.id === 'poisoned-sync')).toMatchObject({
        code: 'agent_location_conflict',
      });
      expect(node.sock.ofType('reply').find((frame) => frame.id === 'poisoned-sync')).toBeUndefined();
      node.sock.received.length = 0;
      await post(sender.token, 'queued by poisoned batch');
      expect(node.sock.ofType('deliver')).toHaveLength(0);
      for (const agent of [alpha, beta]) {
        const state = await read(ws, agent.name);
        expect(state.status).toBe('offline');
        expect(state.pending_deliveries).toHaveLength(1);
      }
      return;
    }

    expect(node.sock.ofType('reply').find((frame) => frame.id === 'poisoned-sync')).toMatchObject({
      ok: true,
      data: { rebound_agents: 2, rejected_agents: 1 },
    });
    node.sock.received.length = 0;
    await post(sender.token, 'delivered despite poisoned member');
    await ack(node, alpha);
    await ack(node, beta);
    for (const agent of [alpha, beta]) {
      expect(await read(ws, agent.name)).toMatchObject({ status: 'active', pending_deliveries: [] });
    }
  });
});
