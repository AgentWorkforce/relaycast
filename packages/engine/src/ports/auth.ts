import type { workspaces, agents } from '../db/schema.js';
import type { EngineDb } from './database.js';

export type Workspace = typeof workspaces.$inferSelect;
export type Agent = typeof agents.$inferSelect;

export type AuthRequire = 'workspace' | 'agent' | 'any';

export type AuthResult =
  | { ok: true; workspace: Workspace; agent?: Agent }
  | { ok: false; status: number; code: string; message: string };

/**
 * Pluggable authentication — the hosting seam.
 *
 * Self-host uses the built-in `SqliteApiKeyAuthProvider` (today's
 * `middleware/auth.ts` logic: SHA-256 hash of `rk_live_`/`at_live_` tokens looked
 * up in the `workspaces`/`agents` tables). The cloud product injects its own
 * provider backed by its accounts/billing system — it may validate against the
 * same gateway D1 or a different identity store entirely. The engine never
 * assumes how a token maps to a workspace/agent.
 */
export interface AuthProvider {
  /**
   * Resolve a bearer token to a workspace (and optionally an agent). `require`
   * narrows the acceptable token kind for routes that demand one specifically.
   * The engine passes its `db` handle so the default provider can query without
   * holding its own connection; custom providers may ignore it.
   */
  authenticate(args: { token: string; require: AuthRequire; db: EngineDb }): Promise<AuthResult>;

  /**
   * Hash a raw token to its stored form. Used by the `/v1/ws` upgrade, which
   * looks tokens up directly. Providers that don't use hashed keys may return
   * the token unchanged.
   */
  hashToken(token: string): Promise<string>;
}
