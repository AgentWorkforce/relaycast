import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { parseCredential, type CredentialKind } from '@relaycast/types';
import type { AppEnv } from '../env.js';
import type { AuthRequire } from '../ports/auth.js';
import { authenticateUnexpired } from '../auth/workspaceExpiry.js';
import {
  DEFAULT_LEGACY_CREDENTIAL_GRACE_SECONDS,
  upgradeLegacyCredential,
  webhookForToken,
} from '../engine/credentialUpgrade.js';
import { jsonError, jsonOk } from '../lib/httpResponse.js';
import { errorResponse } from '../lib/httpError.js';
import { noteAuthenticatedCredential } from '../lib/credentialNotice.js';
import { rateLimitWindow, rateLimitWindowResetAt, setRetryContract } from '../lib/throttle.js';

export const credentialRoutes = new Hono<AppEnv>();

/** Upgrades per principal per minute. */
const UPGRADES_PER_MINUTE = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

const REQUIRE: Record<Exclude<CredentialKind, 'webhook'>, AuthRequire> = {
  workspace: 'workspace',
  agent: 'agent',
  node: 'node',
  observer: 'observer',
};

interface Principal {
  id: string;
  workspaceId: string;
  currentHash: string | null;
}

// POST /v1/credentials/upgrade - exchange a legacy credential for an ar_ one
// standing for the same principal. The legacy credential keeps working for
// EngineConfig.legacyCredentialGraceSeconds (default 30 days).
credentialRoutes.post('/credentials/upgrade', async (c) => {
  try {
    const header = c.req.header('Authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) return jsonError(c, 'unauthorized', 'Missing or invalid Authorization header', 401);
    const parsed = parseCredential(token);
    if (!parsed) return jsonError(c, 'unauthorized', 'Invalid token format', 401);
    if (parsed.family === 'ar') {
      return jsonError(c, 'credential_not_legacy', 'This credential is already an ar_ credential', 409);
    }

    const db = c.get('db');
    let principal: Principal;
    if (parsed.kind === 'webhook') {
      const webhook = await webhookForToken(db, token);
      if (!webhook) return jsonError(c, 'webhook_token_invalid', 'Invalid webhook token', 401);
      principal = { id: webhook.id, workspaceId: webhook.workspaceId, currentHash: webhook.tokenHash };
    } else {
      const result = await authenticateUnexpired(c.get('engine').auth, { token, require: REQUIRE[parsed.kind], db });
      if (!result.ok) return jsonError(c, result.code, result.message, result.status as ContentfulStatusCode);
      const row = parsed.kind === 'workspace' ? { id: result.workspace.id, tokenHash: result.workspace.apiKeyHash }
        : parsed.kind === 'agent' ? result.agent
          : parsed.kind === 'node' ? result.node
            : result.observerToken;
      if (!row) return jsonError(c, 'unauthorized', 'Invalid token format', 401);
      principal = { id: row.id, workspaceId: result.workspace.id, currentHash: 'tokenHash' in row ? row.tokenHash : null };
    }

    const now = Date.now();
    const bucketKey = `credential-upgrade:${parsed.kind}:${principal.id}:${rateLimitWindow(now)}`;
    const limit = await c.get('engine').rateLimiter
      .check({ bucketKey, limit: UPGRADES_PER_MINUTE, windowMs: RATE_LIMIT_WINDOW_MS })
      .catch(() => ({ allowed: true }));
    if (!limit.allowed) {
      setRetryContract(c, rateLimitWindowResetAt(now), now);
      return jsonError(c, 'rate_limit_exceeded', `Rate limit exceeded. ${UPGRADES_PER_MINUTE} upgrades per minute allowed.`, 429);
    }

    const upgraded = await upgradeLegacyCredential(db, {
      legacyToken: token,
      kind: parsed.kind,
      principalId: principal.id,
      workspaceId: principal.workspaceId,
      currentHash: principal.currentHash,
      graceSeconds: c.get('engine').config.legacyCredentialGraceSeconds ?? DEFAULT_LEGACY_CREDENTIAL_GRACE_SECONDS,
    });
    noteAuthenticatedCredential(c, token, principal.workspaceId);
    return jsonOk(c, {
      credential: upgraded.credential,
      kind: upgraded.kind,
      legacy_expires_at: upgraded.legacyExpiresAt.toISOString(),
    });
  } catch (err: unknown) {
    return errorResponse(c, err);
  }
});
