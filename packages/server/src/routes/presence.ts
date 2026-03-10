import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { requireAuth, requireAgentToken } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as presenceEngine from '../engine/presence.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';

export const presenceRoutes = new Hono<AppEnv>();

presenceRoutes.get('/agents/presence', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const result = await presenceEngine.getPresence(db, c.env.PRESENCE_DO, workspace.id);
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as any);
  }
});

// POST /agents/heartbeat — refresh presence for an agent (REST alternative to WebSocket ping)
presenceRoutes.post('/agents/heartbeat', requireAgentToken, rateLimit, async (c) => {
  try {
    const agent = c.get('agent')!;
    const workspace = c.get('workspace');
    const doId = c.env.PRESENCE_DO.idFromName(workspace.id);
    const stub = c.env.PRESENCE_DO.get(doId);
    await stub.fetch(new Request('http://do/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: agent.id, workspaceId: workspace.id, agentName: agent.name }),
    }));

    // Clear any presence suppression so WS pings resume refreshing presence.
    const agentDoId = c.env.AGENT_DO.idFromName(`${workspace.id}:${agent.id}`);
    const agentStub = c.env.AGENT_DO.get(agentDoId);
    agentStub.fetch(new Request('http://do/unsuppress-presence', {
      method: 'POST',
    })).catch(() => {});

    emitServerEvent(c, workspace.id, 'relaycast_server_presence_heartbeat', {
      agent_id: agent.id,
      agent_name: agent.name,
    });
    return c.json({ ok: true });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as any);
  }
});

// POST /agents/disconnect — explicitly mark agent offline
presenceRoutes.post('/agents/disconnect', requireAgentToken, rateLimit, async (c) => {
  try {
    const agent = c.get('agent')!;
    const workspace = c.get('workspace');
    const doId = c.env.PRESENCE_DO.idFromName(workspace.id);
    const stub = c.env.PRESENCE_DO.get(doId);
    await stub.fetch(new Request('http://do/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: agent.id, workspaceId: workspace.id, agentName: agent.name }),
    }));

    // Tell the AgentDO to stop refreshing presence on WS pings.
    // Without this, the WS ping/pong cycle re-registers the agent as online
    // immediately after the disconnect.
    const agentDoId = c.env.AGENT_DO.idFromName(`${workspace.id}:${agent.id}`);
    const agentStub = c.env.AGENT_DO.get(agentDoId);
    agentStub.fetch(new Request('http://do/suppress-presence', {
      method: 'POST',
    })).catch(() => {});

    emitServerEvent(c, workspace.id, 'relaycast_server_presence_disconnected', {
      agent_id: agent.id,
      agent_name: agent.name,
    });
    return c.json({ ok: true });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as any);
  }
});
