import { and, eq, gt } from 'drizzle-orm';
import { workspaces, agents, nodes } from '../db/schema.js';
import { sha256Hex } from '../lib/crypto.js';
import { getActiveObserverTokenByHash } from '../engine/observerToken.js';
import type { AuthProvider, AuthResult, AuthRequire } from '../ports/auth.js';
import type { EngineDb } from '../ports/database.js';
import { parseAuthToken, validateTokenRequirement } from './tokenKind.js';
import { isWorkspaceExpired, workspaceExpiredAuthResult } from './workspaceExpiry.js';

export {
  isWorkspaceExpired,
  authenticateUnexpired,
  workspaceExpiredAuthResult,
  WORKSPACE_EXPIRED_CODE,
  WORKSPACE_EXPIRED_MESSAGE,
} from './workspaceExpiry.js';

/** SHA-256 hash of a raw token to its stored form. */
export function hashToken(token: string): Promise<string> {
  return sha256Hex(token);
}

function unauthorized(message: string, code = 'unauthorized'): AuthResult {
  return { ok: false, status: 401, code, message };
}

/**
 * Admit a resolved workspace only while it is live. An expiring workspace is a
 * room boundary for its callers, so every credential that resolves to it stops
 * working at `expires_at` rather than at the next reap.
 */
function resolved(
  workspace: typeof workspaces.$inferSelect,
  extra: Omit<Extract<AuthResult, { ok: true }>, 'ok' | 'workspace'> = {},
): AuthResult {
  if (isWorkspaceExpired(workspace)) return workspaceExpiredAuthResult();
  return { ok: true, workspace, ...extra };
}

/**
 * The built-in, self-host authentication provider.
 *
 * Reproduces the original `middleware/auth.ts` behavior: bearer tokens prefixed
 * `rk_live_` (workspace) or `at_live_` (agent) are SHA-256 hashed and looked up
 * in the `workspaces` / `agents` tables. The cloud product replaces this with a
 * provider backed by its own accounts/billing system.
 */
export class SqliteApiKeyAuthProvider implements AuthProvider {
  hashToken(token: string): Promise<string> {
    return hashToken(token);
  }

  async authenticate(args: { token: string; require: AuthRequire; db: EngineDb }): Promise<AuthResult> {
    const { token, require, db } = args;
    const parsedToken = parseAuthToken(token);
    if (!parsedToken) {
      return unauthorized('Invalid token format');
    }

    const requirement = validateTokenRequirement(parsedToken.kind, require);
    if (!requirement.ok) {
      return unauthorized(requirement.message, requirement.code);
    }

    const hash = await hashToken(token);

    if (parsedToken.kind === 'workspace') {
      const [workspace] = await db.select().from(workspaces).where(eq(workspaces.apiKeyHash, hash));
      if (!workspace) return unauthorized('Invalid API key');
      return resolved(workspace);
    }

    if (parsedToken.kind === 'agent') {
      // Current slot first — the common case is a token that has not been
      // rotated out from under this caller.
      let [agent] = await db.select().from(agents).where(eq(agents.tokenHash, hash));
      if (!agent) {
        // Fall back to the previous slot inside its grace window. This is the
        // credential a caller that lost a concurrent self-rollover race was
        // handed (relay#1542); it must remain live long enough for that caller
        // to upgrade to a persistent session.
        [agent] = await db
          .select()
          .from(agents)
          .where(and(eq(agents.previousTokenHash, hash), gt(agents.previousTokenExpiresAt, new Date())));
      }
      if (!agent) return unauthorized('Invalid agent token', 'agent_token_invalid');
      const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, agent.workspaceId));
      if (!workspace) return unauthorized('Workspace not found');
      return resolved(workspace, { agent });
    }

    if (parsedToken.kind === 'node') {
      const [node] = await db.select().from(nodes).where(eq(nodes.tokenHash, hash));
      if (!node) return unauthorized('Invalid node token', 'node_token_invalid');
      const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, node.workspaceId));
      if (!workspace) return unauthorized('Workspace not found');
      return resolved(workspace, { node });
    }

    if (parsedToken.kind === 'observer') {
      const observerToken = await getActiveObserverTokenByHash(db, hash);
      if (!observerToken) return unauthorized('Invalid observer token', 'observer_token_invalid');
      const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, observerToken.workspaceId));
      if (!workspace) return unauthorized('Workspace not found');
      return resolved(workspace, { observerToken });
    }

    return unauthorized('Invalid token format');
  }
}
