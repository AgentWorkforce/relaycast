import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import * as directoryEngine from '../engine/directory.js';
import { requireAuth, requireWorkspaceKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';
import { asCodedError } from '../lib/httpError.js';

export const directoryRoutes = new Hono<AppEnv>();

const skillSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  tags: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const createDirectoryAgentSchema = z.object({
  source_agent_name: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  provider: z.string().optional(),
  endpoint_url: z.string().url().optional(),
  documentation_url: z.string().url().optional(),
  version: z.string().optional(),
  tags: z.array(z.string().min(1)).optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  status: z.string().min(1).optional(),
  skills: z.array(skillSchema).optional(),
});

const updateDirectoryAgentSchema = z.object({
  source_agent_name: z.string().min(1).nullable().optional(),
  slug: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  endpoint_url: z.string().url().nullable().optional(),
  documentation_url: z.string().url().nullable().optional(),
  version: z.string().nullable().optional(),
  tags: z.array(z.string().min(1)).optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  status: z.string().min(1).optional(),
  skills: z.array(skillSchema).optional(),
});

const ratingSchema = z.object({
  score: z.number().int().min(1).max(5),
  review: z.string().max(4000).optional(),
});

function parseTagsParam(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const tags = value.split(',').map((tag) => tag.trim()).filter(Boolean);
  return tags.length ? tags : undefined;
}

function handleError(c: Context<AppEnv>, err: unknown) {
  const error = asCodedError(err);
  const cause = error.cause instanceof Error ? error.cause.message : (error.cause ? String(error.cause) : '');
  const message = cause ? `${error.message} [cause: ${cause}]` : error.message;
  return c.json({
    ok: false,
    error: { code: error.code || 'internal_error', message },
  }, (error.status || 500) as ContentfulStatusCode);
}

directoryRoutes.post('/directory/agents', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const parsed = createDirectoryAgentSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message: 'name is required' },
      }, 400);
    }

    const workspace = c.get('workspace');
    const result = await directoryEngine.createDirectoryAgent(c.get('db'), workspace.id, parsed.data);
    emitServerEvent(c, workspace.id, 'relaycast_server_directory_agent_created', {
      slug: result?.slug,
      skill_count: result?.skills.length ?? 0,
    });
    return c.json({ ok: true, data: result }, 201);
  } catch (err: unknown) {
    return handleError(c, err);
  }
});

directoryRoutes.get('/directory/agents', requireAuth, rateLimit, async (c) => {
  try {
    const workspace = c.get('workspace');
    const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : undefined;
    const result = await directoryEngine.listDirectoryAgents(c.get('db'), workspace.id, {
      status: c.req.query('status') || undefined,
      limit,
    });
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    return handleError(c, err);
  }
});

directoryRoutes.get('/directory/search', requireAuth, rateLimit, async (c) => {
  try {
    const workspace = c.get('workspace');
    const q = c.req.query('q') || undefined;
    const tags = parseTagsParam(c.req.query('tags'));
    if ((!q || !q.trim()) && (!tags || tags.length === 0)) {
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message: 'q or tags is required' },
      }, 400);
    }

    const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : undefined;
    const result = await directoryEngine.searchDirectory(c.get('db'), workspace.id, {
      q,
      tags,
      status: c.req.query('status') || undefined,
      limit,
    });
    emitServerEvent(c, workspace.id, 'relaycast_server_directory_search_executed', {
      query_length: q?.trim().length || 0,
      tag_count: tags?.length || 0,
      result_count: result.length,
    });
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    return handleError(c, err);
  }
});

directoryRoutes.get('/directory/agents/:slug', requireAuth, rateLimit, async (c) => {
  try {
    const workspace = c.get('workspace');
    const result = await directoryEngine.getDirectoryAgent(c.get('db'), workspace.id, c.req.param('slug'));
    if (!result) {
      return c.json({
        ok: false,
        error: { code: 'directory_agent_not_found', message: 'Directory agent not found' },
      }, 404);
    }
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    return handleError(c, err);
  }
});

directoryRoutes.patch('/directory/agents/:slug', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const parsed = updateDirectoryAgentSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message: 'invalid directory agent update body' },
      }, 400);
    }

    const workspace = c.get('workspace');
    const result = await directoryEngine.updateDirectoryAgent(
      c.get('db'),
      workspace.id,
      c.req.param('slug'),
      parsed.data,
    );

    if (!result) {
      return c.json({
        ok: false,
        error: { code: 'directory_agent_not_found', message: 'Directory agent not found' },
      }, 404);
    }

    emitServerEvent(c, workspace.id, 'relaycast_server_directory_agent_updated', {
      slug: result.slug,
      status: result.status,
    });
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    return handleError(c, err);
  }
});

directoryRoutes.delete('/directory/agents/:slug', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const workspace = c.get('workspace');
    const deleted = await directoryEngine.deleteDirectoryAgent(c.get('db'), workspace.id, c.req.param('slug'));
    if (!deleted) {
      return c.json({
        ok: false,
        error: { code: 'directory_agent_not_found', message: 'Directory agent not found' },
      }, 404);
    }

    emitServerEvent(c, workspace.id, 'relaycast_server_directory_agent_deleted', {
      slug: c.req.param('slug'),
    });
    return c.body(null, 204);
  } catch (err: unknown) {
    return handleError(c, err);
  }
});

directoryRoutes.get('/directory/agents/:slug/ratings', requireAuth, rateLimit, async (c) => {
  try {
    const workspace = c.get('workspace');
    const result = await directoryEngine.listDirectoryRatings(c.get('db'), workspace.id, c.req.param('slug'));
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    return handleError(c, err);
  }
});

directoryRoutes.post('/directory/agents/:slug/ratings', requireAuth, rateLimit, async (c) => {
  try {
    const parsed = ratingSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message: 'score must be an integer between 1 and 5' },
      }, 400);
    }

    const agent = c.get('agent');
    if (!agent?.id) {
      return c.json({
        ok: false,
        error: {
          code: 'agent_token_required',
          message: 'Agent token required to submit ratings',
        },
      }, 403);
    }

    const workspace = c.get('workspace');
    const result = await directoryEngine.upsertDirectoryRating(c.get('db'), workspace.id, c.req.param('slug'), {
      rater_agent_id: agent.id,
      score: parsed.data.score,
      review: parsed.data.review,
    });

    emitServerEvent(c, workspace.id, 'relaycast_server_directory_rating_upserted', {
      slug: c.req.param('slug'),
      score: result.score,
      rater_agent_id: agent.id,
    });
    return c.json({ ok: true, data: result }, 201);
  } catch (err: unknown) {
    return handleError(c, err);
  }
});
