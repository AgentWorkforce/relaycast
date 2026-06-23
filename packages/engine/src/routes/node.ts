import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireAuth, requireWorkspaceKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { requireFleetNodes } from '../middleware/fleetNodes.js';
import { errorResponse } from '../lib/httpError.js';
import {
  jsonCreated,
  jsonNotFound,
  jsonOk,
  parseJsonBody,
} from '../lib/httpResponse.js';
import * as nodeEngine from '../engine/node.js';

export const nodeRoutes = new Hono<AppEnv>();

const createNodeSchema = z.object({
  node_id: z.string().min(1).optional(),
  name: z.string().min(1),
  capabilities: z.array(z.string().min(1)).optional(),
  max_agents: z.number().int().nonnegative().optional(),
  tags: z.array(z.string()).optional(),
  version: z.string().optional(),
});

// POST /v1/nodes - enroll or rotate a node token (workspace-key only)
nodeRoutes.post('/nodes', requireWorkspaceKey, requireFleetNodes, rateLimit, async (c) => {
  try {
    const parsed = await parseJsonBody(c, createNodeSchema, 'invalid node body');
    if (!parsed.ok) {
      return parsed.response;
    }
    const result = await nodeEngine.createNodeToken(c.get('db'), c.get('workspace').id, parsed.data);
    return jsonCreated(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// GET /v1/nodes?capability=&name= - node roster
nodeRoutes.get('/nodes', requireAuth, requireFleetNodes, rateLimit, async (c) => {
  try {
    const result = await nodeEngine.listNodes(c.get('db'), c.get('workspace').id, {
      capability: c.req.query('capability'),
      name: c.req.query('name'),
    });
    return jsonOk(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// GET /v1/nodes/:name - single node roster entry
nodeRoutes.get('/nodes/:name', requireAuth, requireFleetNodes, rateLimit, async (c) => {
  try {
    const result = await nodeEngine.getPublicNode(c.get('db'), c.get('workspace').id, c.req.param('name'));
    if (!result) {
      return jsonNotFound(c, 'node_not_found', 'Node not found');
    }
    return jsonOk(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});
