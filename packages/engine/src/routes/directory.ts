import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import * as directoryEngine from '../engine/directory.js';
import { directoryAgentToOasfRecord, OasfRecordSchema, oasfRecordToDirectoryAgentInput } from '../engine/oasf.js';
import { requireAuth, requireWorkspaceKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';
import { errorResponse } from '../lib/httpError.js';
import {
  jsonCreated,
  jsonError,
  jsonInvalidRequest,
  jsonNoContent,
  jsonNotFound,
  jsonOk,
  parseJsonBody,
  parseQueryParams,
} from '../lib/httpResponse.js';
import { LimitQuerySchema } from '../lib/httpQuery.js';

export const directoryRoutes = new Hono<AppEnv>();

const skillSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  tags: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const flatCreateDirectoryAgentSchema = z.object({
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
}).strict();

// Publishing an OASF Agent Record directly — e.g. one discovered via an
// AGNTCY/OASF or ANP registry — needs zero translation: post it as-is under
// `oasf`, optionally overriding the directory-specific fields OASF has no
// equivalent for. Both branches are `.strict()` so a body mixing `oasf` with
// flat fields like `name` is rejected instead of silently picking one side
// and discarding the other (the default z.object() behavior strips unknown
// keys rather than erroring, which would otherwise drop `oasf` silently
// whenever a caller also sent `name`).
const oasfCreateDirectoryAgentSchema = z.object({
  oasf: OasfRecordSchema,
  source_agent_name: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
}).strict();

const createDirectoryAgentSchema = z.union([flatCreateDirectoryAgentSchema, oasfCreateDirectoryAgentSchema]);

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

const listDirectoryAgentsQuerySchema = LimitQuerySchema.extend({
  status: z.string().optional(),
  format: z.string().optional(),
});

const searchDirectoryQuerySchema = LimitQuerySchema.extend({
  q: z.string().optional(),
  tags: z.string().optional(),
  status: z.string().optional(),
});

function parseTagsParam(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const tags = value.split(',').map((tag) => tag.trim()).filter(Boolean);
  return tags.length ? tags : undefined;
}

function handleError(c: Context<AppEnv>, err: unknown) {
  return errorResponse(c, err);
}

directoryRoutes.post('/directory/agents', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const parsed = await parseJsonBody(c, createDirectoryAgentSchema, 'name is required, or oasf with a valid OASF record');
    if (!parsed.ok) {
      return parsed.response;
    }

    const input = 'oasf' in parsed.data
      ? {
        ...oasfRecordToDirectoryAgentInput(parsed.data.oasf),
        source_agent_name: parsed.data.source_agent_name,
        slug: parsed.data.slug,
        status: parsed.data.status,
      }
      : parsed.data;

    const workspace = c.get('workspace');
    const result = await directoryEngine.createDirectoryAgent(c.get('db'), workspace.id, input);
    emitServerEvent(c, workspace.id, 'relaycast_server_directory_agent_created', {
      slug: result?.slug,
      skill_count: result?.skills.length ?? 0,
      source: 'oasf' in parsed.data ? 'oasf' : 'native',
    });
    return jsonCreated(c, result);
  } catch (err: unknown) {
    return handleError(c, err);
  }
});

directoryRoutes.get('/directory/agents', requireAuth, rateLimit, async (c) => {
  try {
    const workspace = c.get('workspace');
    const parsed = parseQueryParams(c, listDirectoryAgentsQuerySchema, 'Invalid directory agent query');
    if (!parsed.ok) {
      return parsed.response;
    }
    const { status, limit, format } = parsed.data;
    if (format && format !== 'oasf') {
      return jsonInvalidRequest(c, 'format must be "oasf" if provided');
    }
    const result = await directoryEngine.listDirectoryAgents(c.get('db'), workspace.id, {
      status: status || undefined,
      limit,
    });
    return jsonOk(c, format === 'oasf' ? result.map(directoryAgentToOasfRecord) : result);
  } catch (err: unknown) {
    return handleError(c, err);
  }
});

directoryRoutes.get('/directory/search', requireAuth, rateLimit, async (c) => {
  try {
    const workspace = c.get('workspace');
    const parsed = parseQueryParams(c, searchDirectoryQuerySchema, 'Invalid directory search query');
    if (!parsed.ok) {
      return parsed.response;
    }
    const { q, tags: tagsParam, status, limit } = parsed.data;
    const tags = parseTagsParam(tagsParam);
    if ((!q || !q.trim()) && (!tags || tags.length === 0)) {
      return jsonInvalidRequest(c, 'q or tags is required');
    }

    const result = await directoryEngine.searchDirectory(c.get('db'), workspace.id, {
      q,
      tags,
      status: status || undefined,
      limit,
    });
    emitServerEvent(c, workspace.id, 'relaycast_server_directory_search_executed', {
      query_length: q?.trim().length || 0,
      tag_count: tags?.length || 0,
      result_count: result.length,
    });
    return jsonOk(c, result);
  } catch (err: unknown) {
    return handleError(c, err);
  }
});

directoryRoutes.get('/directory/agents/:slug', requireAuth, rateLimit, async (c) => {
  try {
    const format = c.req.query('format');
    if (format && format !== 'oasf') {
      return jsonInvalidRequest(c, 'format must be "oasf" if provided');
    }

    const workspace = c.get('workspace');
    const result = await directoryEngine.getDirectoryAgent(c.get('db'), workspace.id, c.req.param('slug'));
    if (!result) {
      return jsonNotFound(c, 'directory_agent_not_found', 'Directory agent not found');
    }
    return jsonOk(c, format === 'oasf' ? directoryAgentToOasfRecord(result) : result);
  } catch (err: unknown) {
    return handleError(c, err);
  }
});

directoryRoutes.patch('/directory/agents/:slug', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const parsed = await parseJsonBody(c, updateDirectoryAgentSchema, 'invalid directory agent update body');
    if (!parsed.ok) {
      return parsed.response;
    }

    const workspace = c.get('workspace');
    const result = await directoryEngine.updateDirectoryAgent(
      c.get('db'),
      workspace.id,
      c.req.param('slug'),
      parsed.data,
    );

    if (!result) {
      return jsonNotFound(c, 'directory_agent_not_found', 'Directory agent not found');
    }

    emitServerEvent(c, workspace.id, 'relaycast_server_directory_agent_updated', {
      slug: result.slug,
      status: result.status,
    });
    return jsonOk(c, result);
  } catch (err: unknown) {
    return handleError(c, err);
  }
});

directoryRoutes.delete('/directory/agents/:slug', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const workspace = c.get('workspace');
    const deleted = await directoryEngine.deleteDirectoryAgent(c.get('db'), workspace.id, c.req.param('slug'));
    if (!deleted) {
      return jsonNotFound(c, 'directory_agent_not_found', 'Directory agent not found');
    }

    emitServerEvent(c, workspace.id, 'relaycast_server_directory_agent_deleted', {
      slug: c.req.param('slug'),
    });
    return jsonNoContent(c);
  } catch (err: unknown) {
    return handleError(c, err);
  }
});

directoryRoutes.get('/directory/agents/:slug/ratings', requireAuth, rateLimit, async (c) => {
  try {
    const workspace = c.get('workspace');
    const result = await directoryEngine.listDirectoryRatings(c.get('db'), workspace.id, c.req.param('slug'));
    return jsonOk(c, result);
  } catch (err: unknown) {
    return handleError(c, err);
  }
});

directoryRoutes.post('/directory/agents/:slug/ratings', requireAuth, rateLimit, async (c) => {
  try {
    const parsed = await parseJsonBody(c, ratingSchema, 'score must be an integer between 1 and 5');
    if (!parsed.ok) {
      return parsed.response;
    }

    const agent = c.get('agent');
    if (!agent?.id) {
      return jsonError(c, 'agent_token_required', 'Agent token required to submit ratings', 403);
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
    return jsonCreated(c, result);
  } catch (err: unknown) {
    return handleError(c, err);
  }
});
