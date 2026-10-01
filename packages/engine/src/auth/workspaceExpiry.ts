import type { AuthProvider, AuthRequire, AuthResult, Workspace } from '../ports/auth.js';
import type { EngineDb } from '../ports/database.js';

/** Error code every credential path returns for a workspace past `expires_at`. */
export const WORKSPACE_EXPIRED_CODE = 'workspace_expired';
export const WORKSPACE_EXPIRED_MESSAGE = 'Workspace has expired';

/**
 * True once a workspace that opted into an expiry deadline has reached it.
 *
 * Reaping is a bounded background batch, so a workspace stays readable in the
 * database for some time after its deadline. Authentication must not wait for
 * that batch: expiry is the boundary callers were promised (relaycast#464).
 */
export function isWorkspaceExpired(
  workspace: Pick<Workspace, 'expiresAt'>,
  now: Date = new Date(),
): boolean {
  const expiresAt = workspace.expiresAt;
  return expiresAt != null && expiresAt.getTime() <= now.getTime();
}

export function workspaceExpiredAuthResult(): AuthResult {
  return {
    ok: false,
    status: 401,
    code: WORKSPACE_EXPIRED_CODE,
    message: WORKSPACE_EXPIRED_MESSAGE,
  };
}

/**
 * Authenticate through `auth` and reject an expired workspace.
 *
 * The built-in provider already enforces this, but authentication is a hosting
 * seam: a cloud provider backed by its own identity store must not be able to
 * admit an expired workspace. Every credential-accepting path in the engine
 * goes through this wrapper so the check holds whatever provider is installed.
 */
export async function authenticateUnexpired(
  auth: AuthProvider,
  args: { token: string; require: AuthRequire; db: EngineDb },
): Promise<AuthResult> {
  const result = await auth.authenticate(args);
  if (!result.ok) return result;
  if (isWorkspaceExpired(result.workspace)) return workspaceExpiredAuthResult();
  return result;
}
