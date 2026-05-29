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
    const result = await presenceEngine.getPresence(db, c.get('engine').presence, workspace.id);
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
    await c.get('engine').presence.heartbeat(workspace.id, agent.id, agent.name);
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
// Force-disconnects the agent's live sockets, then sends an authoritative
// disconnect to the presence tracker so a stale in-flight heartbeat can't
// re-create the agent's presence entry afterwards.
presenceRoutes.post('/agents/disconnect', requireAgentToken, rateLimit, async (c) => {
  try {
    const agent = c.get('agent')!;
    const workspace = c.get('workspace');
    const { connections, presence } = c.get('engine');

    // Close the agent's sockets first (serializes the authoritative disconnect
    // after any in-flight ping heartbeat in the connection layer).
    await connections.disconnectAgent(workspace.id, agent.id).catch(() => {});

    // Then mark offline directly as a safety net.
    await presence.disconnect(workspace.id, agent.id, agent.name);

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
