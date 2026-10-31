import { and, eq, exists, gt, lt, ne, notExists, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { getDb } from '../db/index.js';
import { channels, workspaces } from '../db/schema.js';
import { randomHex, sha256Hex } from '../lib/crypto.js';
import { acceptsOnlyAr, canMintAr, credentialFormat, issueCredential } from '../auth/credentials.js';
import { codedError } from '../lib/httpError.js';
import { runAtomicWrites } from '../ports/database.js';
import { generateId } from './snowflake.js';
import { WORKSPACE_KEY_MAX_GRACE_MS } from './tokenRotate.js';

type Db = ReturnType<typeof getDb>;

/**
 * Capability advertisement for a control plane driving the internal admin API.
 *
 * The `workspace_key_push` block is the hosted gateway's contract verbatim, so
 * a control plane's pre-rotation capability gate passes unchanged. On the
 * self-host engine every key fence lives in the same SQLite row and there is
 * no auth cache, so `revocation_markers` is satisfied by the previous-key slot
 * itself: a superseded key stops authenticating the moment its slot expires,
 * with no KV marker to arm or repair.
 *
 * `workspace_admin` is a self-host extension (absent on the hosted gateway):
 * `create` advertises POST /internal/workspaces and `server_minted_key` that
 * POST /internal/workspaces/:id/api-key may omit `api_key` to have the engine
 * mint the replacement.
 */
export const INTERNAL_CAPABILITIES = {
  workspace_key_push: {
    generation_cas: true,
    generation_required_once_fenced: true,
    grace_ms: true,
    max_grace_ms: WORKSPACE_KEY_MAX_GRACE_MS,
    revocation_markers: true,
    previous_key_slot: true,
  },
  workspace_admin: {
    create: true,
    delete: true,
    server_minted_key: true,
  },
} as const;

// The self-host engine is a single process. Keep a per-database deletion
// fence so a key push already in flight cannot recreate a workspace after an
// internal-admin delete has claimed it. The trusted control plane also fences
// its own app row before calling this endpoint; this closes the engine-local
// request race.
interface InternalDeletionState {
  active: number;
  tombstoned: boolean;
}

const internalDeletionFences = new WeakMap<object, Map<string, InternalDeletionState>>();

function deletionFences(db: Db): Map<string, InternalDeletionState> {
  const key = db as object;
  const existing = internalDeletionFences.get(key);
  if (existing) return existing;
  const created = new Map<string, InternalDeletionState>();
  internalDeletionFences.set(key, created);
  return created;
}

export interface InternalWorkspaceDeletionFence {
  commit(): void;
  release(): void;
}

export function beginInternalWorkspaceDeletion(
  db: Db,
  workspaceId: string,
): InternalWorkspaceDeletionFence {
  const fences = deletionFences(db);
  const state = fences.get(workspaceId) ?? { active: 0, tombstoned: false };
  state.active += 1;
  fences.set(workspaceId, state);
  let settled = false;
  const settle = (committed: boolean) => {
    if (settled) return;
    settled = true;
    state.active -= 1;
    if (committed) state.tombstoned = true;
    if (state.active === 0 && !state.tombstoned) fences.delete(workspaceId);
  };
  return {
    commit: () => settle(true),
    release: () => settle(false),
  };
}

function assertInternalWorkspaceWritable(db: Db, workspaceId: string): void {
  if (deletionFences(db).has(workspaceId)) {
    throw codedError('Workspace is being deleted', 'workspace_deleted', 410);
  }
}

/** Minimum length of `config.internalSecret` (e.g. `openssl rand -hex 32` is 64). */
export const MIN_INTERNAL_SECRET_LENGTH = 32;

/**
 * Throw when a configured internal secret is too short to be a credential.
 * Unset/empty is fine (the admin API stays disabled).
 */
export function assertInternalSecretStrength(secret: string | undefined): void {
  if (secret === undefined || secret === '') return;
  if (secret !== secret.trim()) {
    // The route trims the presented bearer, so a padded secret could never match.
    throw new Error('RELAYCAST_INTERNAL_SECRET must not have leading or trailing whitespace');
  }
  if (secret.length < MIN_INTERNAL_SECRET_LENGTH) {
    throw new Error(
      `RELAYCAST_INTERNAL_SECRET must be at least ${MIN_INTERNAL_SECRET_LENGTH} characters ` +
        '(generate one with `openssl rand -hex 32`)',
    );
  }
}

export interface PushWorkspaceKeyInput {
  /** Caller-minted `rk_live_` key. Omitted → the engine mints one (self-host extension). */
  apiKey?: string;
  keyGeneration?: number;
  graceMs?: number;
}

export interface PushWorkspaceKeyResult {
  created: boolean;
  workspaceId: string;
  apiKeyGeneration: number;
  /** Present only when the engine minted the key; returned exactly once. */
  mintedApiKey?: string;
}

type KeyRow = Pick<
  typeof workspaces.$inferSelect,
  'id' | 'apiKeyHash' | 'apiKeyGeneration'
>;

function staleGeneration(workspaceId: string, requested: number, stored: number): Error {
  return codedError(
    `key_generation ${requested} does not beat the stored generation ${stored} for workspace ` +
      `${workspaceId}; the push is stale and was not applied`,
    'stale_key_generation',
    409,
  );
}

function isUniqueConstraintError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cause = err;
  while (cause && typeof cause === 'object' && !seen.has(cause)) {
    seen.add(cause);
    const e = cause as { code?: string; message?: string; cause?: unknown };
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true;
    if (typeof e.message === 'string' && e.message.toLowerCase().includes('unique constraint failed')) return true;
    cause = e.cause;
  }
  return false;
}

/**
 * A server-minted key in the deployment's credential format. The admin API
 * accepts workspace ids (`[A-Za-z0-9_-]`) that an `ar_` credential cannot
 * carry (it needs a 64-bit snowflake); those keep a legacy key, which a
 * deployment that accepts legacy credentials still authenticates. A
 * deployment that accepts only `ar_` credentials refuses such ids.
 */
async function mintWorkspaceKey(db: Db, workspaceId: string): Promise<string> {
  if (credentialFormat(db) === 'ar' && !canMintAr(db, workspaceId)) {
    if (acceptsOnlyAr(db)) {
      throw codedError('This deployment needs a 64-bit snowflake workspace id', 'invalid_request', 400);
    }
    return `rk_live_${randomHex(16)}`;
  }
  return issueCredential(db, 'workspace', workspaceId);
}

/** The create batch's ownership guard tripped (see pushWorkspaceKey). */
function isKeyGuardViolation(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cause = err;
  while (cause && typeof cause === 'object' && !seen.has(cause)) {
    seen.add(cause);
    const e = cause as { message?: string; cause?: unknown };
    if (typeof e.message === 'string' && /NOT NULL constraint failed: channels\.workspace_id/i.test(e.message)) return true;
    cause = e.cause;
  }
  return false;
}

async function readKeyRow(db: Db, workspaceId: string): Promise<KeyRow | undefined> {
  const [row] = await db
    .select({ id: workspaces.id, apiKeyHash: workspaces.apiKeyHash, apiKeyGeneration: workspaces.apiKeyGeneration })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return row;
}

/**
 * Rows of *other* workspaces that hold `apiKeyHash` as a credential that still
 * authenticates — their current key, or a previous key inside its grace
 * window. Authentication resolves current-slot matches before previous-slot
 * matches, so binding a key that is live in another workspace's grace slot
 * would silently move that workspace's callers onto this one.
 */
function liveElsewhereQuery(db: Db, apiKeyHash: string, workspaceId: string) {
  const other = alias(workspaces, 'other_workspace');
  return db
    .select({ id: other.id })
    .from(other)
    .where(and(
      ne(other.id, workspaceId),
      or(
        eq(other.apiKeyHash, apiKeyHash),
        and(eq(other.previousApiKeyHash, apiKeyHash), gt(other.previousApiKeyExpiresAt, new Date())),
      ),
    ));
}

async function keyOwnedElsewhere(db: Db, apiKeyHash: string, workspaceId: string): Promise<boolean> {
  const [owner] = await liveElsewhereQuery(db, apiKeyHash, workspaceId).limit(1);
  return Boolean(owner);
}

/**
 * The same ownership invariant as a guard on the key-changing UPDATE, so a
 * concurrent rotation elsewhere cannot slip in between the pre-check and the
 * write.
 */
function keyFreeElsewhere(db: Db, apiKeyHash: string, workspaceId: string): SQL {
  return notExists(liveElsewhereQuery(db, apiKeyHash, workspaceId));
}

function keyConflict(): Error {
  return codedError('api_key is already bound to a different workspace', 'api_key_conflict', 409);
}

/**
 * Register or rotate a workspace's API key on behalf of a trusted control
 * plane — the self-host port of the hosted gateway's
 * `POST /internal/workspaces/:id/api-key`.
 *
 * Semantics (identical to hosted where they overlap):
 * - UPSERT: a missing workspace is created with `id = name = :id` (plus its
 *   `#general` channel) when the caller supplies the key. A server-minted
 *   rotation of a missing workspace is 404 instead — create it explicitly.
 * - Re-pushing the live key is idempotent at any generation; a higher
 *   generation bumps the stored fence.
 * - A hash-changing push carrying `key_generation` commits only through a CAS
 *   on (current hash, generation < N); a stale or out-of-order write is 409
 *   `stale_key_generation`. The superseded key keeps authenticating for
 *   `grace_ms` (default 0: dead immediately).
 * - Once fenced (generation > 0), generationless hash changes are 409
 *   `key_generation_required`.
 * - Server-minted rotation (no `api_key`) always fences: it uses
 *   `key_generation` when given, otherwise stored generation + 1.
 */
export async function pushWorkspaceKey(
  db: Db,
  workspaceId: string,
  input: PushWorkspaceKeyInput,
): Promise<PushWorkspaceKeyResult> {
  assertInternalWorkspaceWritable(db, workspaceId);
  const minted = input.apiKey === undefined;
  const apiKey = input.apiKey ?? await mintWorkspaceKey(db, workspaceId);
  const apiKeyHash = await sha256Hex(apiKey);
  const { graceMs } = input;
  let keyGeneration = input.keyGeneration;
  // A server-minted rotation without key_generation fences at stored + 1,
  // re-derived from each fresh read so a lost race retries instead of
  // reporting a stale generation the caller never sent.
  const derivedGeneration = minted && input.keyGeneration === undefined;

  let row = await readKeyRow(db, workspaceId);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assertInternalWorkspaceWritable(db, workspaceId);
    if (!row) {
      if (minted) throw codedError('Workspace not found', 'workspace_not_found', 404);
      if (await keyOwnedElsewhere(db, apiKeyHash, workspaceId)) throw keyConflict();
      const generation = keyGeneration ?? 0;
      // Re-check after the awaits above: a delete may have claimed the id.
      assertInternalWorkspaceWritable(db, workspaceId);
      try {
        await runAtomicWrites(
          db,
          (writeDb) => [
            writeDb.insert(workspaces).values({
              id: workspaceId,
              name: workspaceId,
              apiKeyHash,
              apiKeyGeneration: generation,
            }),
            // Ownership guard inside the batch: if another workspace took this
            // key (current slot, or a previous slot still in grace) after the
            // pre-check, the NULL workspace_id fails NOT NULL and the whole
            // batch, including the workspace insert, rolls back.
            writeDb.insert(channels).values({
              id: generateId(),
              workspaceId: sql`(CASE WHEN ${exists(liveElsewhereQuery(writeDb, apiKeyHash, workspaceId))} THEN NULL ELSE ${workspaceId} END)`,
              name: 'general',
              topic: 'General discussion',
            }),
          ],
          { requireAtomic: true },
        );
        return { created: true, workspaceId, apiKeyGeneration: generation };
      } catch (error) {
        if (isKeyGuardViolation(error)) throw keyConflict();
        if (!isUniqueConstraintError(error)) throw error;
        // A concurrent push created the row — re-decide against it. Otherwise
        // the key hash collided with another workspace.
        const fresh = await readKeyRow(db, workspaceId);
        if (!fresh) throw keyConflict();
        row = fresh;
        continue;
      }
    }

    const stored = row.apiKeyGeneration ?? 0;

    if (row.apiKeyHash === apiKeyHash) {
      // Idempotent re-push of the live key; a higher generation bumps the fence.
      if (keyGeneration !== undefined && keyGeneration > stored) {
        assertInternalWorkspaceWritable(db, workspaceId);
        const bumped = await db
          .update(workspaces)
          .set({ apiKeyGeneration: keyGeneration })
          .where(and(
            eq(workspaces.id, row.id),
            eq(workspaces.apiKeyHash, apiKeyHash),
            lt(workspaces.apiKeyGeneration, keyGeneration),
          ))
          .returning({ id: workspaces.id });
        if (bumped.length === 0) {
          row = await readKeyRow(db, workspaceId);
          continue;
        }
        return { created: false, workspaceId, apiKeyGeneration: keyGeneration };
      }
      return { created: false, workspaceId, apiKeyGeneration: stored };
    }

    if (await keyOwnedElsewhere(db, apiKeyHash, workspaceId)) throw keyConflict();

    if (derivedGeneration) {
      if (stored >= Number.MAX_SAFE_INTEGER) {
        throw codedError(
          `workspace ${workspaceId} is at the maximum api_key_generation; it cannot be rotated further`,
          'key_generation_exhausted',
          409,
        );
      }
      keyGeneration = stored + 1;
    }

    if (keyGeneration === undefined) {
      if (stored > 0) {
        throw codedError(
          `workspace ${workspaceId} is fenced at api_key_generation ${stored}; ` +
            'pushes that change the key must carry key_generation greater than that',
          'key_generation_required',
          409,
        );
      }
      assertInternalWorkspaceWritable(db, workspaceId);
      const applied = await db
        .update(workspaces)
        .set({ apiKeyHash })
        .where(and(
          eq(workspaces.id, row.id),
          eq(workspaces.apiKeyHash, row.apiKeyHash),
          eq(workspaces.apiKeyGeneration, 0),
          keyFreeElsewhere(db, apiKeyHash, row.id),
        ))
        .returning({ id: workspaces.id });
      if (applied.length === 0) {
        row = await readKeyRow(db, workspaceId);
        continue;
      }
      return { created: false, workspaceId, apiKeyGeneration: 0 };
    }

    if (keyGeneration <= stored) throw staleGeneration(workspaceId, keyGeneration, stored);

    const grace = graceMs ?? 0;
    // Zero grace (compromise) leaves no authenticatable previous slot: the
    // auth lookup requires a strictly-future expiry, and null never matches.
    const previousExpiresAt = grace === 0 ? null : new Date(Date.now() + grace);
    assertInternalWorkspaceWritable(db, workspaceId);
    const applied = await db
      .update(workspaces)
      .set({
        apiKeyHash,
        apiKeyGeneration: keyGeneration,
        previousApiKeyHash: row.apiKeyHash,
        previousApiKeyExpiresAt: previousExpiresAt,
      })
      .where(and(
        eq(workspaces.id, row.id),
        eq(workspaces.apiKeyHash, row.apiKeyHash),
        lt(workspaces.apiKeyGeneration, keyGeneration),
        keyFreeElsewhere(db, apiKeyHash, row.id),
      ))
      .returning({ id: workspaces.id });
    if (applied.length === 0) {
      const fresh = await readKeyRow(db, workspaceId);
      // A concurrent push of the same key won. Done only if its generation
      // already covers ours; otherwise loop so the idempotent branch bumps
      // the fence to the requested generation.
      if (fresh && fresh.apiKeyHash === apiKeyHash && keyGeneration <= fresh.apiKeyGeneration) {
        return { created: false, workspaceId, apiKeyGeneration: fresh.apiKeyGeneration };
      }
      if (fresh && !derivedGeneration && keyGeneration <= fresh.apiKeyGeneration) {
        throw staleGeneration(workspaceId, keyGeneration, fresh.apiKeyGeneration);
      }
      row = fresh;
      continue;
    }
    return {
      created: false,
      workspaceId,
      apiKeyGeneration: keyGeneration,
      ...(minted ? { mintedApiKey: apiKey } : {}),
    };
  }

  throw codedError(
    `Concurrent key writes are contending workspace ${workspaceId}; retry`,
    'key_write_conflict',
    409,
  );
}
