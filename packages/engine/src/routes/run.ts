import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { requireWorkspaceKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { errorResponse } from '../lib/httpError.js';
import { jsonCreated, jsonError, jsonOk, parseOptionalJsonBody } from '../lib/httpResponse.js';
import { directNodeIdForAgent } from '../engine/node.js';
import {
  mintRunTokenSchema,
  mintRunToken,
  revokeRunAuthority,
  runIdSchema,
} from '../engine/runToken.js';

export const runRoutes = new Hono<AppEnv>();

function invalidRunId(c: Parameters<typeof jsonError>[0]) {
  return jsonError(c, 'invalid_run_id', 'run_id must be 1-128 URL-safe characters', 400);
}

// POST /v1/runs/:runId/tokens - mint a short-lived run token (workspace key
// only). Re-minting for an active run is how the holder refreshes.
runRoutes.post('/runs/:runId/tokens', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const runId = runIdSchema.safeParse(c.req.param('runId'));
    if (!runId.success) return invalidRunId(c);
    const parsed = await parseOptionalJsonBody(c, mintRunTokenSchema, 'ttl_seconds must be an integer >= 60');
    if (!parsed.ok) return parsed.response;
    const minted = await mintRunToken(c.get('db'), c.get('workspace').id, runId.data, parsed.data.ttl_seconds);
    return jsonCreated(c, minted);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});

// DELETE /v1/runs/:runId/authority - permanently revoke the run (workspace key
// only, idempotent). Cascades to run tokens and run-stamped agents/nodes, and
// force-closes the run's live node connections.
runRoutes.delete('/runs/:runId/authority', requireWorkspaceKey, rateLimit, async (c) => {
  try {
    const runId = runIdSchema.safeParse(c.req.param('runId'));
    if (!runId.success) return invalidRunId(c);
    const workspaceId = c.get('workspace').id;
    const { result, agentIds, nodeIds } = await revokeRunAuthority(c.get('db'), workspaceId, runId.data);
    // Credentials are already dead in the database; closing sockets stops
    // traffic on connections that authenticated before the revoke.
    const nodeConnections = c.get('engine').nodeConnections;
    const targets = new Set([...nodeIds, ...agentIds.map(directNodeIdForAgent)]);
    await Promise.all([...targets].map(async (nodeId) => {
      try {
        await nodeConnections.disconnectNode(workspaceId, nodeId);
      } catch (err) {
        c.get('logger').warn('run revoke: node disconnect failed', {
          workspace_id: workspaceId,
          node_id: nodeId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }));
    return jsonOk(c, result);
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});
