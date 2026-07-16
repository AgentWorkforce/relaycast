import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireWorkspaceRead, requireAgentToken } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as presenceEngine from '../engine/presence.js';
import { handleAgentDisconnect } from '../agent-disconnect.js';
import {
  getObserverTokenFromContext,
  observerAllowsAgent,
} from '../engine/observerToken.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';
import { errorResponse } from '../lib/httpError.js';
import { jsonOk, jsonSuccess, parseOptionalJsonBody } from '../lib/httpResponse.js';

export const presenceRoutes = new Hono<AppEnv>();

const disconnectBodySchema = z.object({
  deregister: z.boolean().optional().default(false),
});

presenceRoutes.get('/agents/presence', requireWorkspaceRead('agents:read'), rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const observer = getObserverTokenFromContext(c);
    const result = (await presenceEngine.getPresence(db, c.get('engine').presence, workspace.id))
      .filter((presence) => observerAllowsAgent(observer, presence.agent_id));
    return jsonOk(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
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
    return jsonSuccess(c);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// POST /agents/disconnect — explicitly mark agent offline. For node-hosted
// agents this is presence-only by default; pass `{ "deregister": true }` to
// also tear down the node binding and re-home the agent to its direct node.
presenceRoutes.post('/agents/disconnect', requireAgentToken, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const agent = c.get('agent')!;
    const workspace = c.get('workspace');
    const { presence } = c.get('engine');

    const parsed = await parseOptionalJsonBody(c, disconnectBodySchema, 'invalid disconnect body');
    if (!parsed.ok) {
      return parsed.response;
    }

    await handleAgentDisconnect(db, workspace.id, agent.id, { deregister: parsed.data.deregister });
    await presence.disconnect(workspace.id, agent.id, agent.name);

    emitServerEvent(c, workspace.id, 'relaycast_server_presence_disconnected', {
      agent_id: agent.id,
      agent_name: agent.name,
    });
    return jsonSuccess(c);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});
