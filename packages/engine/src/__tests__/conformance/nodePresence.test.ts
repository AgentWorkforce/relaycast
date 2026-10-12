import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { AGENT_LIVENESS_TTL_MS, sweepStaleAgents, touchLastSeen, updateAgent } from '../../engine/agent.js';
import { markNodeOffline } from '../../engine/node.js';
import { applyStatusEventEffect, recordSessionEvent, type SessionEventType } from '../../engine/sessionEvent.js';
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

  it.each(['idle', 'blocked', 'waiting', 'offline'])(
    'preserves explicit %s status while renewing presence and last_seen', async (status) => {
      const { stack, ws, agent, beat, ack } = await setup();
      const db = stack.runtime.handle.db;
      // Old last_seen must not turn an explicit offline report into expiry.
      await db.update(agents).set({ lastSeen: new Date(0) }).where(eq(agents.id, agent.agentId));
      const { event } = await recordSessionEvent(db, ws.workspaceId, agent.agentId, {
        type: `status.${status}` as SessionEventType, payload: {},
      });
      await applyStatusEventEffect(db, ws.workspaceId, agent.agentId, event.id, status);
      await beat();
      expect(ack()).toMatchObject({ ok: true, data: { agent_presence: true } });
      const [row] = await db.select().from(agents).where(eq(agents.id, agent.agentId));
      expect(row.status).toBe(status);
      await touchLastSeen(db, agent.agentId); // REST fallback must preserve it too.
      const [afterRest] = await db.select().from(agents).where(eq(agents.id, agent.agentId));
      expect(afterRest.status).toBe(status);
      expect(row.lastSeen.getTime()).toBeGreaterThan(Date.now() - 2_000);
      const response = await stack.app.request(`/v1/agents?status=${status}`, {
        headers: { authorization: `Bearer ${ws.workspaceKey}` },
      });
      const body = await response.json() as { data: Array<{ id: string }> };
      expect(body.data.map((row) => row.id)).toContain(agent.agentId);
    },
  );

  it('preserves an explicit offline report after the expiry sweep already marked the agent offline', async () => {
    const { stack, ws, agent, beat } = await setup();
    const db = stack.runtime.handle.db;
    await db.update(agents).set({ lastSeen: new Date(0) }).where(eq(agents.id, agent.agentId));
    await sweepStaleAgents(db, ws.workspaceId);
    const { event } = await recordSessionEvent(db, ws.workspaceId, agent.agentId, { type: 'status.offline', payload: {} });
    await applyStatusEventEffect(db, ws.workspaceId, agent.agentId, event.id, 'offline');
    await beat();
    const [row] = await db.select().from(agents).where(eq(agents.id, agent.agentId));
    expect(row.status).toBe('offline');
  });

  it('restores the work state after a node disconnect without erasing blocked status', async () => {
    const { stack, ws, agent, handle } = await setup();
    const db = stack.runtime.handle.db;
    const { event } = await recordSessionEvent(db, ws.workspaceId, agent.agentId, { type: 'status.blocked', payload: {} });
    await applyStatusEventEffect(db, ws.workspaceId, agent.agentId, event.id, 'blocked');
    await handle.handleClose();
    const [offline] = await db.select().from(agents).where(eq(agents.id, agent.agentId));
    expect(offline.status).toBe('offline');
    await markNodeOffline(db, stack.runtime.realtime, ws.workspaceId, `node_direct_${agent.agentId}`);
    const reconnected = await attachDirectNodeSocket(stack, ws.workspaceId, agent);
    await reconnected.handle.handleMessage(JSON.stringify({ v: 1, id: 'back', type: 'node.heartbeat', active_agents: 1, handlers_live: false }));
    const [row] = await db.select().from(agents).where(eq(agents.id, agent.agentId));
    expect(row.status).toBe('blocked');
  });

  it('treats an explicit offline update as authoritative even after expiry, without relying on session events', async () => {
    const { stack, ws, agent, beat } = await setup();
    const db = stack.runtime.handle.db;
    await db.update(agents).set({ lastSeen: new Date(0) }).where(eq(agents.id, agent.agentId));
    await sweepStaleAgents(db, ws.workspaceId);
    await updateAgent(db, ws.workspaceId, agent.name, { status: 'offline' });
    await beat();
    const [row] = await db.select().from(agents).where(eq(agents.id, agent.agentId));
    expect(row.status).toBe('offline');
    expect(row.statusBeforeLivenessLoss).toBeNull();
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
