import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { getDb } from '../db/index.js';
import { agents, nodes, runAuthorities, runTokens } from '../db/schema.js';
import { randomHex, sha256Hex } from '../lib/crypto.js';
import { codedError } from '../lib/httpError.js';
import { generateId } from './snowflake.js';

type Db = ReturnType<typeof getDb>;
export type RunTokenRow = typeof runTokens.$inferSelect;

/** Run tokens are short-lived access credentials; Cloud re-mints before expiry. */
export const RUN_TOKEN_DEFAULT_TTL_SECONDS = 900;
export const RUN_TOKEN_MAX_TTL_SECONDS = 3600;
export const RUN_TOKEN_MIN_TTL_SECONDS = 60;

/** Cloud run ids are opaque, URL-safe identifiers. */
export const runIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

export const mintRunTokenSchema = z.object({
  ttl_seconds: z.number().int().min(RUN_TOKEN_MIN_TTL_SECONDS).optional(),
});

/** Clamp a requested lifetime to the policy cap. */
export function runTokenTtlSeconds(requested?: number): number {
  return Math.min(requested ?? RUN_TOKEN_DEFAULT_TTL_SECONDS, RUN_TOKEN_MAX_TTL_SECONDS);
}

function toSecondPrecision(ms: number): Date {
  // SQLite timestamp-mode integers hold seconds; return what the verifier reads.
  return new Date(Math.floor(ms / 1_000) * 1_000);
}

export function isRunTokenExpired(token: { expiresAt: Date }, now = new Date()): boolean {
  const expiresAt = token.expiresAt.getTime();
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime();
}

/**
 * Resolve a presented run token hash to its live row. Expiry, token revocation
 * and run-authority revocation are all read from the database on every call.
 */
export async function getActiveRunTokenByHash(db: Db, tokenHash: string, now = new Date()): Promise<RunTokenRow | null> {
  const [row] = await db
    .select({ token: runTokens, authorityRevokedAt: runAuthorities.revokedAt })
    .from(runTokens)
    .innerJoin(runAuthorities, and(
      eq(runAuthorities.workspaceId, runTokens.workspaceId),
      eq(runAuthorities.runId, runTokens.runId),
    ))
    .where(eq(runTokens.tokenHash, tokenHash))
    .limit(1);
  if (!row) return null;
  if (row.token.revokedAt || row.authorityRevokedAt) return null;
  if (isRunTokenExpired(row.token, now)) return null;
  return row.token;
}

/** True when the run authority exists and has been revoked. */
export async function isRunAuthorityRevoked(db: Db, workspaceId: string, runId: string): Promise<boolean> {
  const [row] = await db
    .select({ revokedAt: runAuthorities.revokedAt })
    .from(runAuthorities)
    .where(and(eq(runAuthorities.workspaceId, workspaceId), eq(runAuthorities.runId, runId)))
    .limit(1);
  // A run-stamped principal with no authority row cannot have been created
  // through a run token; fail closed.
  return !row || row.revokedAt !== null;
}

export interface MintedRunToken {
  token: string;
  token_expires_at: string;
  run_id: string;
}

/**
 * Issue a fresh run token for the run authority, creating the authority on
 * first mint. Re-minting while the run is active is how Cloud refreshes.
 */
export async function mintRunToken(
  db: Db,
  workspaceId: string,
  runId: string,
  ttlSeconds?: number,
  now = new Date(),
): Promise<MintedRunToken> {
  await db
    .insert(runAuthorities)
    .values({ workspaceId, runId, createdAt: now })
    .onConflictDoNothing({ target: [runAuthorities.workspaceId, runAuthorities.runId] });
  const [authority] = await db
    .select()
    .from(runAuthorities)
    .where(and(eq(runAuthorities.workspaceId, workspaceId), eq(runAuthorities.runId, runId)));
  if (!authority || authority.revokedAt) {
    throw codedError('Run authority has been revoked', 'run_authority_revoked', 410);
  }

  // Refresh leaves a trail of expired rows; drop this run's dead ones.
  await db
    .delete(runTokens)
    .where(and(
      eq(runTokens.workspaceId, workspaceId),
      eq(runTokens.runId, runId),
      lte(runTokens.expiresAt, now),
    ));

  const token = `rt_live_${randomHex(24)}`;
  const expiresAt = toSecondPrecision(now.getTime() + runTokenTtlSeconds(ttlSeconds) * 1_000);
  await db.insert(runTokens).values({
    id: `rtk_${generateId()}`,
    workspaceId,
    runId,
    tokenHash: await sha256Hex(token),
    expiresAt,
    createdAt: now,
  });
  // A revoke that lands between the authority read and this insert still
  // wins: verification joins the authority on every request.
  return { token, token_expires_at: expiresAt.toISOString(), run_id: runId };
}

export interface RevokedRunAuthority {
  run_id: string;
  revoked_at: string;
  run_tokens_revoked: number;
  agents_revoked: number;
  nodes_revoked: number;
}

/**
 * Permanently revoke a run authority, its run tokens, and every agent/node
 * credential stamped with the run. Idempotent; revoking an unknown run records
 * a revoked authority so the run id can never mint later.
 *
 * Returns the affected node ids (including each run agent's implicit direct
 * node) so the caller can force-close live connections.
 */
export async function revokeRunAuthority(
  db: Db,
  workspaceId: string,
  runId: string,
  now = new Date(),
): Promise<{ result: RevokedRunAuthority; agentIds: string[]; nodeIds: string[] }> {
  const revokedAt = toSecondPrecision(now.getTime());
  // Authority first: once this lands, verification rejects every principal of
  // the run even if a later credential write fails.
  await db
    .insert(runAuthorities)
    .values({ workspaceId, runId, createdAt: revokedAt, revokedAt })
    .onConflictDoUpdate({
      target: [runAuthorities.workspaceId, runAuthorities.runId],
      set: { revokedAt: sql`coalesce(${runAuthorities.revokedAt}, excluded.revoked_at)` },
    });
  const [authority] = await db
    .select()
    .from(runAuthorities)
    .where(and(eq(runAuthorities.workspaceId, workspaceId), eq(runAuthorities.runId, runId)));

  const tokenRows = await db
    .update(runTokens)
    .set({ revokedAt })
    .where(and(eq(runTokens.workspaceId, workspaceId), eq(runTokens.runId, runId), isNull(runTokens.revokedAt)))
    .returning({ id: runTokens.id });

  // `token_hash` is NOT NULL UNIQUE; rotate it to a per-row value no presented
  // token can hash to, and clear the grace slot (see deleteAgent).
  const agentRows = await db
    .update(agents)
    .set({
      tokenHash: sql`'revoked:' || ${agents.id} || ':' || lower(hex(randomblob(16)))`,
      tokenExpiresAt: revokedAt,
      previousTokenHash: null,
      previousTokenExpiresAt: null,
    })
    .where(and(
      eq(agents.workspaceId, workspaceId),
      eq(agents.runId, runId),
      sql`${agents.tokenHash} NOT LIKE 'revoked:%'`,
    ))
    .returning({ id: agents.id });

  const nodeRows = await db
    .update(nodes)
    .set({
      tokenHash: sql`'revoked:' || ${nodes.id} || ':' || lower(hex(randomblob(16)))`,
      previousTokenHash: null,
      previousTokenExpiresAt: null,
      rotationIdempotencyKeyHash: null,
      rotationRequestDigest: null,
    })
    .where(and(
      eq(nodes.workspaceId, workspaceId),
      eq(nodes.runId, runId),
      sql`${nodes.tokenHash} NOT LIKE 'revoked:%'`,
    ))
    .returning({ id: nodes.id });

  const agentIds = agentRows.map((row) => row.id);
  return {
    result: {
      run_id: runId,
      revoked_at: (authority?.revokedAt ?? revokedAt).toISOString(),
      run_tokens_revoked: tokenRows.length,
      agents_revoked: agentIds.length,
      nodes_revoked: nodeRows.length,
    },
    agentIds,
    nodeIds: nodeRows.map((row) => row.id),
  };
}
