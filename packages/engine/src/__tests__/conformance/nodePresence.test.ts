import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { AGENT_LIVENESS_TTL_MS, sweepStaleAgents } from '../../engine/agent.js';
import { agents, agentNodeBindings, nodes } from '../../db/schema.js';
import { attachDirectNodeSocket, createWorkspace, makeNodeStack, registerAgent } from './harness.js';

async function setup() {
  const stack = makeNodeStack({ ttlMs: 1_000 });
  const ws = await createWorkspace(stack.app, 'socket-presence');
  const agent = await registerAgent(stack.app, ws.workspaceKey, 'idle');
  const connection = await attachDirectNodeSocket(stack, ws.workspaceId, agent);
  await stack.settle();
  await stack.runtime.presence.disconnect(ws.workspaceId, agent.agentId);
  const beat = (id = 'presence-1', extra = {}) => connection.handle.handleMessage(JSON.stringify({
    v: 1, id, type: 'node.heartbeat', active_agents: 1, handlers_live: false, ...extra,
  }));
  const ack = (id = 'presence-1') => connection.sock.ofType('reply').find((frame) => frame.id === id);
  return { stack, ws, agent, ...connection, beat, ack };
}

afterEach(() => vi.restoreAllMocks());

describe('direct-node WebSocket presence', () => {
  it('keeps only its bound agent online across TTLs without REST, then expires when heartbeats stop', async () => {
    const { stack, ws, agent, beat, ack } = await setup();
    const other = await registerAgent(stack.app, ws.workspaceKey, 'other');
    await stack.settle();
    await stack.runtime.presence.disconnect(ws.workspaceId, other.agentId);
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    for (let i = 0; i < 4; i++) {
      now += 900;
      await beat(`presence-${i}`);
      expect(ack(`presence-${i}`)).toMatchObject({
        v: 1, type: 'reply', ok: true, data: { agent_presence: true, agent_id: agent.agentId },
      });
      await stack.runtime.presence.sweep();
      expect(await stack.runtime.presence.getOnline(ws.workspaceId)).toEqual([agent.agentId]);
    }
    now += 1_001;
    await stack.runtime.presence.sweep();
    expect(await stack.runtime.presence.getOnline(ws.workspaceId)).toEqual([]);
  });

  it('renews the durable roster and recovers an expired agent without REST agent activity', async () => {
    const { stack, ws, agent, beat, ack } = await setup();
    const db = stack.runtime.handle.db;
    await db.update(agents).set({ lastSeen: new Date(Date.now() - AGENT_LIVENESS_TTL_MS - 1_000) })
      .where(eq(agents.id, agent.agentId));
    await sweepStaleAgents(db, ws.workspaceId);
    await beat();
    expect(ack()).toMatchObject({ ok: true, data: { agent_presence: true } });
    await sweepStaleAgents(db, ws.workspaceId);
    const response = await stack.app.request('/v1/agents?status=active', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: Array<{ id: string }> };
    expect(body.data.map((row) => row.id)).toContain(agent.agentId);
  });

  it('acknowledges only after presence succeeds and never acknowledges a failed refresh', async () => {
    const { stack, beat, ack } = await setup();
    let resolve!: () => void;
    const refresh = vi.spyOn(stack.runtime.presence, 'heartbeat')
      .mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    const pending = beat();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(ack()).toBeUndefined();
    resolve();
    await pending;
    expect(ack()).toMatchObject({ ok: true, data: { agent_presence: true } });
    refresh.mockRejectedValueOnce(new Error('presence unavailable'));
    await beat('failed');
    expect(ack('failed')).toBeUndefined();
  });

  it.each(['moved', 'unbound', 'released', 'broker', 'wrong-node', 'closed'])(
    'does not grant agent presence through a %s connection', async (scenario) => {
      const { stack, ws, agent, nodeId, handle, beat, ack } = await setup();
      const db = stack.runtime.handle.db;
      if (scenario === 'moved') await db.update(agents).set({ locationNodeId: null }).where(eq(agents.id, agent.agentId));
      if (scenario === 'unbound') await db.update(agentNodeBindings).set({ status: 'inactive' }).where(eq(agentNodeBindings.agentId, agent.agentId));
      if (scenario === 'released') await db.update(agents).set({ status: 'released' }).where(eq(agents.id, agent.agentId));
      if (scenario === 'broker') await db.update(nodes).set({ role: 'broker' }).where(eq(nodes.id, nodeId));
      if (scenario === 'closed') await handle.handleClose();
      await beat('presence-1', scenario === 'wrong-node' ? { node_id: 'someone-else' } : {});
      expect(ack()).toBeUndefined();
      expect(await stack.runtime.presence.getOnline(ws.workspaceId)).not.toContain(agent.agentId);
    },
  );
});
