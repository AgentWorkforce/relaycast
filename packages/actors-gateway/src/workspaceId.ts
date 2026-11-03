/**
 * The id a new workspace (and its actor) gets. A plain create takes a fresh
 * snowflake. A create carrying an `Idempotency-Key` takes an id derived from
 * the deployment's bootstrap secret and the key, so a retry reaches the same
 * actor and the engine's own idempotency record (owner-scoped or anonymous,
 * with its request digest) answers it; without the secret such a create
 * fails closed with the engine's own error.
 */
import type { IncomingMessage } from 'node:http';
import { deriveKeyedWorkspaceId, generateWorkspaceId } from '@relaycast/engine/gateway';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

export type WorkspaceIdChoice =
  | { workspaceId: string }
  | { error: { status: number; code: string; message: string } };

export async function chooseWorkspaceId(req: IncomingMessage, bootstrapSecret: string | undefined): Promise<WorkspaceIdChoice> {
  const presented = req.headers[IDEMPOTENCY_KEY_HEADER];
  const key = (Array.isArray(presented) ? presented[0] : presented)?.trim();
  // Absent or blank: the actor answers a blank key with the engine's 400 and creates nothing.
  if (!key) return { workspaceId: generateWorkspaceId() };
  if (!bootstrapSecret) {
    return { error: { status: 503, code: 'workspace_create_idempotency_unavailable', message: 'Anonymous workspace create idempotency is not configured on this deployment' } };
  }
  return { workspaceId: await deriveKeyedWorkspaceId(bootstrapSecret, key) };
}
