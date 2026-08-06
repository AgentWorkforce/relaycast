import { eq } from 'drizzle-orm';
import { workspaces, agents, nodes } from '../db/schema.js';
import { sha256Hex } from '../lib/crypto.js';
import { getActiveObserverTokenByHash } from '../engine/observerToken.js';
import { revokeAgentToken } from '../engine/agent.js';
import type { AuthProvider, AuthResult, AuthRequire } from '../ports/auth.js';
import type { EngineDb } from '../ports/database.js';
import { parseAuthToken, validateTokenRequirement } from './tokenKind.js';

/** SHA-256 hash of a raw token to its stored form. */
export function hashToken(token: string): Promise<string> {
  return sha256Hex(token);
}

function unauthorized(message: string, code = 'unauthorized'): AuthResult {
  return { ok: false, status: 401, code, message };
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

  /**
   * This provider owns `agents.token_hash`, so it can enforce revocation itself
   * — the check lives in `authenticate` below, which every path resolving an
   * agent token goes through.
   */
  revokeAgentCredential(args: {
    workspaceId: string;
    agentName: string;
    db: EngineDb;
  }): Promise<{ revokedAt: Date; alreadyRevoked: boolean } | null> {
    return revokeAgentToken(args.db as Parameters<typeof revokeAgentToken>[0], args.workspaceId, args.agentName);
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
      return { ok: true, workspace };
    }

    if (parsedToken.kind === 'agent') {
      const [agent] = await db.select().from(agents).where(eq(agents.tokenHash, hash));
      if (!agent) return unauthorized('Invalid agent token', 'agent_token_invalid');
      // Refuse a revoked credential. This is the main lookup resolving an
      // `at_live_` token to an identity, and the realtime WS path rejects agent
      // tokens outright (see engine/wsAuth.ts) — but it is NOT the only one. The
      // A2A webhook (`routes/a2a.ts`) compares the stored hash directly without
      // going through this provider and carries its own check; any new path that
      // matches on `agents.token_hash` must do the same, or revocation silently
      // stops covering it. Distinct code from `agent_token_invalid` so an
      // operator can tell "revoked" from "never existed" — a deleted row reports
      // the latter, and that difference is the point of keeping the record.
      if (agent.revokedAt) return unauthorized('Agent token revoked', 'agent_token_revoked');
      const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, agent.workspaceId));
      if (!workspace) return unauthorized('Workspace not found');
      return { ok: true, workspace, agent };
    }

    if (parsedToken.kind === 'node') {
      const [node] = await db.select().from(nodes).where(eq(nodes.tokenHash, hash));
      if (!node) return unauthorized('Invalid node token', 'node_token_invalid');
      const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, node.workspaceId));
      if (!workspace) return unauthorized('Workspace not found');
      return { ok: true, workspace, node };
    }

    if (parsedToken.kind === 'observer') {
      const observerToken = await getActiveObserverTokenByHash(db, hash);
      if (!observerToken) return unauthorized('Invalid observer token', 'observer_token_invalid');
      const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, observerToken.workspaceId));
      if (!workspace) return unauthorized('Workspace not found');
      return { ok: true, workspace, observerToken };
    }

    return unauthorized('Invalid token format');
  }
}
