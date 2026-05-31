import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { AppEnv } from '../env.js';
import * as routingEngine from '../engine/routing.js';
import * as directoryEngine from '../engine/directory.js';
import { agents } from '../db/schema.js';
import { requireAuth, requireWorkspaceKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';
import { errorResponse } from '../lib/httpError.js';

export const routingRoutes = new Hono<AppEnv>();

const skillSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  tags: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const routeRequestSchema = z.object({
  skill: z.string().min(1),
  message: z.string().optional().default(''),
});

const routingConfigSchema = z.object({
  weights: z.object({
    skill_match: z.number().min(0).optional(),
    message_match: z.number().min(0).optional(),
    tag_match: z.number().min(0).optional(),
    rating: z.number().min(0).optional(),
    availability: z.number().min(0).optional(),
  }).optional(),
  circuit_breaker_threshold: z.number().int().min(1).max(20).optional(),
  circuit_breaker_cooldown_seconds: z.number().int().min(1).max(86_400).optional(),
});

const routeFeedbackSchema = z.object({
  agent_name: z.string().min(1),
  success: z.boolean(),
  error: z.string().max(4000).optional(),
});

const syncAgentSkillsSchema = z.object({
  agent_name: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
  status: z.string().min(1).optional(),
  skills: z.array(skillSchema).optional(),
});

function handleError(c: Context<AppEnv>, err: unknown) {
  return errorResponse(c, err);
}

routingRoutes.post('/route', requireAuth, rateLimit, async (c) => {
  try {
    const parsed = routeRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message: 'skill is required' },
      }, 400);
    }

    const workspace = c.get('workspace');
    const result = await routingEngine.routeBySkill(
      c.get('db'),
      workspace.id,
      parsed.data.skill,
      parsed.data.message || '',
    );

    emitServerEvent(c, workspace.id, 'relaycast_server_route_resolved', {
      skill: parsed.data.skill,
      agent_name: result.agentName,
      fallback: result.fallback,
      score: result.score,
    });

    return c.json({
      ok: true,
      data: {
        agent_name: result.agentName,
        score: result.score,
        fallback: result.fallback,
      },
    });
  } catch (err: unknown) {
    return handleError(c, err);
  }
});

routingRoutes.post('/route/feedback', requireAuth, rateLimit, async (c) => {
  try {
    const parsed = routeFeedbackSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message: 'agent_name and success are required' },
      }, 400);
    }

    const workspace = c.get('workspace');
    const result = parsed.data.success
      ? await routingEngine.recordRoutingSuccess(c.get('db'), workspace.id, parsed.data.agent_name)
      : await routingEngine.recordRoutingFailure(
        c.get('db'),
        workspace.id,
        parsed.data.agent_name,
        parsed.data.error,
      );

    emitServerEvent(c, workspace.id, 'relaycast_server_route_feedback_recorded', {
      agent_name: parsed.data.agent_name,
      success: parsed.data.success,
    });

    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    return handleError(c, err);
  }
});

routingRoutes.get('/skills/search', requireAuth, rateLimit, async (c) => {
  try {
    const workspace = c.get('workspace');
    const q = c.req.query('q') || undefined;
    const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : undefined;
    const result = await routingEngine.searchSkills(c.get('db'), workspace.id, { q, limit });
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    return handleError(c, err);
  }
});

routingRoutes.post('/skills/sync', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const parsed = syncAgentSkillsSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message: 'agent_name is required' },
      }, 400);
    }

    const workspace = c.get('workspace');
    const db = c.get('db');
    const agent = await db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, workspace.id), eq(agents.name, parsed.data.agent_name)));

    const row = agent[0];
    if (!row) {
      return c.json({
        ok: false,
        error: { code: 'agent_not_found', message: `Agent "${parsed.data.agent_name}" not found` },
      }, 404);
    }

    const metadata = {
      ...(row.metadata || {}),
      ...(parsed.data.metadata || {}),
      ...(parsed.data.skills ? { skills: parsed.data.skills } : {}),
    };

    const result = await directoryEngine.syncSourceAgentDirectoryEntry(db, workspace.id, {
      id: row.id,
      name: row.name,
      status: parsed.data.status || row.status,
      metadata,
    });

    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    return handleError(c, err);
  }
});

routingRoutes.get('/routing/config', requireAuth, rateLimit, async (c) => {
  try {
    const workspace = c.get('workspace');
    const result = await routingEngine.getRoutingConfig(c.get('db'), workspace.id);
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    return handleError(c, err);
  }
});

routingRoutes.put('/routing/config', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const parsed = routingConfigSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message: 'invalid routing config body' },
      }, 400);
    }

    const workspace = c.get('workspace');
    const result = await routingEngine.setRoutingConfig(c.get('db'), workspace.id, parsed.data);
    emitServerEvent(c, workspace.id, 'relaycast_server_routing_config_updated', {
      circuit_breaker_threshold: result.circuit_breaker_threshold,
      circuit_breaker_cooldown_seconds: result.circuit_breaker_cooldown_seconds,
    });
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    return handleError(c, err);
  }
});
