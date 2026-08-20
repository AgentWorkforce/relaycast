import { eq, and, sql } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { agents } from '../db/schema.js';
import { randomHex, sha256Hex } from '../lib/crypto.js';
import { codedError } from '../lib/httpError.js';

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

  const newToken = `at_live_${randomHex(16)}`;
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
