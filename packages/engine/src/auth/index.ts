import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { workspaces, agents } from '../db/schema.js';
import type { AuthProvider, AuthResult, AuthRequire } from '../ports/auth.js';
import type { EngineDb } from '../ports/database.js';

/** SHA-256 hash of a raw token to its stored form. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
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
  hashToken(token: string): string {
    return hashToken(token);
  }

  async authenticate(args: { token: string; require: AuthRequire; db: EngineDb }): Promise<AuthResult> {
    const { token, require, db } = args;
    const hash = hashToken(token);

    if (token.startsWith('rk_live_')) {
      if (require === 'agent') {
        return unauthorized('Agent token required (at_live_...)');
      }
      const [workspace] = await db.select().from(workspaces).where(eq(workspaces.apiKeyHash, hash));
      if (!workspace) return unauthorized('Invalid API key');
      return { ok: true, workspace };
    }

    if (token.startsWith('at_live_')) {
      if (require === 'workspace') {
        return unauthorized('Workspace key required (rk_live_...)');
      }
      const [agent] = await db.select().from(agents).where(eq(agents.tokenHash, hash));
      if (!agent) return unauthorized('Invalid agent token', 'agent_token_invalid');
      const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, agent.workspaceId));
      if (!workspace) return unauthorized('Workspace not found');
      return { ok: true, workspace, agent };
    }

    return unauthorized('Invalid token format');
  }
}
