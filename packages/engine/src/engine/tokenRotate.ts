import { eq, and, sql } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { agents, workspaces } from '../db/schema.js';
import { sha256Hex } from '../lib/crypto.js';
import { codedError } from '../lib/httpError.js';
import { issueCredential } from '../auth/credentials.js';

type Db = ReturnType<typeof getDb>;

/**
 * How long a superseded agent token stays authenticatable after a rotation.
 *
 * Sized to cover concurrent authenticated self-rollover: the loser of that
 * race must have long enough to make the follow-up request that gets it a
 * persistent WebSocket session (which then carries its own auth state).
 * Sixty seconds is well past the observed request latencies for that path and
 * well short of a duration that would functionally weaken a rotate-to-revoke.
 */
export const AGENT_TOKEN_GRACE_MS = 60_000;

export async function rotateAgentToken(db: Db, workspaceId: string, agentName: string) {
  const [existing] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, agentName)));

  if (!existing) {
    throw codedError(`Agent "${agentName}" not found`, 'agent_not_found', 404);
  }

  const newToken = await issueCredential(db, 'agent', workspaceId);
  const newTokenHash = await sha256Hex(newToken);
  const graceExpiresAtSeconds = Math.floor((Date.now() + AGENT_TOKEN_GRACE_MS) / 1000);

  // SQLite evaluates every SET expression against the row's pre-update values
  // before writing any of them. That is what makes the current→previous
  // handoff atomic: two concurrent rotations serialize on the row's write lock,
  // each captures its predecessor into `previous_token_hash`, and the loser of
  // the race authenticates against the previous slot instead of being handed a
  // silently-dead credential. Chained rotations retire the older previous slot
  // — see the "chained rotations" conformance case.
  await db
    .update(agents)
    .set({
      previousTokenHash: sql`${agents.tokenHash}`,
      previousTokenExpiresAt: sql`${graceExpiresAtSeconds}`,
      tokenHash: newTokenHash,
    })
    .where(eq(agents.id, existing.id));

  return {
    name: agentName,
    token: newToken,
  };
}

/**
 * Default continuity window for a workspace-key rotation: long enough for
 * peers and in-flight callers still holding the superseded key to observe the
 * cutover, short enough that it cannot function as a second credential.
 */
export const WORKSPACE_KEY_DEFAULT_GRACE_MS = 60_000;

/**
 * Longest caller-selectable grace window. A grace period is continuity, never
 * rollback: a rotation that needs "the old key again" mints a new key instead,
 * because an old key that stays alive indefinitely is a credential, not a
 * grace window.
 */
export const WORKSPACE_KEY_MAX_GRACE_MS = 3_600_000;

/**
 * Replace a workspace's API key, capturing the superseded key into the
 * previous slot for `graceMs`. `graceMs: 0` is the compromise mode — the old
 * key authenticates nowhere after this call, and nothing about the row lets a
 * stale writer restore it: `apiKeyGeneration` moves forward monotonically, so
 * an out-of-band writer carrying an older generation loses the compare.
 *
 * The return value carries the raw replacement exactly once — it is never
 * persisted in plaintext, never logged, and never included in the stored row.
 */
export async function rotateWorkspaceKey(
  db: Db,
  workspaceId: string,
  options?: { graceMs?: number },
) {
  const graceMs = options?.graceMs ?? WORKSPACE_KEY_DEFAULT_GRACE_MS;
  if (!Number.isInteger(graceMs) || graceMs < 0 || graceMs > WORKSPACE_KEY_MAX_GRACE_MS) {
    throw codedError(
      `grace must be an integer between 0 and ${WORKSPACE_KEY_MAX_GRACE_MS} ms`,
      'invalid_grace',
      400,
    );
  }

  const [existing] = await db
    .select({ id: workspaces.id, generation: workspaces.apiKeyGeneration })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));

  if (!existing) {
    throw codedError('Workspace not found', 'workspace_not_found', 404);
  }

  const newApiKey = await issueCredential(db, 'workspace', workspaceId);
  const newApiKeyHash = await sha256Hex(newApiKey);
  const graceExpiresAt = graceMs === 0 ? null : new Date(Date.now() + graceMs);

  // Same atomic handoff as the agent rotation above: SET expressions read
  // pre-update values, so concurrent rotations serialize on the row lock and
  // each captures its predecessor into the previous slot.
  await db
    .update(workspaces)
    .set({
      previousApiKeyHash: sql`${workspaces.apiKeyHash}`,
      previousApiKeyExpiresAt: graceExpiresAt,
      apiKeyHash: newApiKeyHash,
      apiKeyGeneration: sql`${workspaces.apiKeyGeneration} + 1`,
    })
    .where(eq(workspaces.id, existing.id));

  return {
    workspaceId,
    apiKey: newApiKey,
    apiKeyGeneration: existing.generation + 1,
    previousKeyExpiresAt: graceExpiresAt,
  };
}
