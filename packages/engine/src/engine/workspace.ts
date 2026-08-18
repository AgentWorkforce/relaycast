import { and, asc, eq, gt, inArray, isNull, like, lte, or, sql } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { workspaces, channels, fileCleanupQueue, workspaceEvents } from '../db/schema.js';
import { randomHex, sha256Hex } from '../lib/crypto.js';
import { generateId } from './snowflake.js';
import { codedError } from '../lib/httpError.js';
import { D1WriteRetryExhaustedError, retryD1Write } from '../lib/d1Retry.js';
import { runAtomicWrites } from '../ports/database.js';
import type { FileStorage } from '../ports/files.js';

type Db = ReturnType<typeof getDb>;

type WorkspaceWriteResult = [
  Array<typeof workspaces.$inferSelect>,
  Array<typeof channels.$inferSelect>,
];

type CommittedWorkspacePairRead =
  | { status: 'match'; value: WorkspaceWriteResult }
  | { status: 'mismatch' }
  | { status: 'unavailable' };

type CreateWorkspaceOptions =
  | string
  | {
      ownerApiKey?: string;
      ownerApiKeyHash?: string;
      expiresAt?: Date;
    };

export const DEFAULT_WORKSPACE_REAP_LIMIT = 25;
export const DEFAULT_FILE_CLEANUP_LIMIT = 90;
const MAX_FILE_CLEANUP_LIMIT = 90;
const FILE_CLEANUP_RETRY_MS = 30_000;

function hashApiKey(apiKey: string): Promise<string> {
  return sha256Hex(apiKey);
}

function buildWorkspaceResponse(
  workspace: typeof workspaces.$inferSelect,
  apiKey?: string,
) {
  return {
    workspace_id: workspace.id,
    ...(apiKey ? { api_key: apiKey } : {}),
    created_at: workspace.createdAt.toISOString(),
    expires_at: workspace.expiresAt?.toISOString() ?? null,
  };
}

function isExpectedWorkspacePair(
  writeResult: WorkspaceWriteResult,
  expected: {
    workspaceId: string;
    name: string;
    apiKeyHash: string;
    channelId: string;
  },
): boolean {
  const [workspaceRows, channelRows] = writeResult;
  const createdWorkspace = workspaceRows[0];
  const createdChannel = channelRows[0];
  return Boolean(
    createdWorkspace &&
    createdWorkspace.id === expected.workspaceId &&
    createdWorkspace.name === expected.name &&
    createdWorkspace.apiKeyHash === expected.apiKeyHash &&
    createdChannel &&
    createdChannel.id === expected.channelId &&
    createdChannel.workspaceId === expected.workspaceId &&
    createdChannel.name === 'general'
  );
}

async function readCommittedWorkspacePair(
  db: Db,
  expected: {
    workspaceId: string;
    name: string;
    apiKeyHash: string;
    channelId: string;
  },
): Promise<CommittedWorkspacePairRead> {
  try {
    const [workspaceRows, channelRows] = await Promise.all([
      db.select().from(workspaces).where(eq(workspaces.id, expected.workspaceId)),
      db.select().from(channels).where(eq(channels.id, expected.channelId)),
    ]);
    const result: WorkspaceWriteResult = [workspaceRows, channelRows];
    return isExpectedWorkspacePair(result, expected)
      ? { status: 'match', value: result }
      : { status: 'mismatch' };
  } catch {
    return { status: 'unavailable' };
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();

  for (let depth = 0; current !== undefined && depth < 6 && !seen.has(current); depth += 1) {
    seen.add(current);
    if (typeof current === 'string') {
      const message = current.toLowerCase();
      if (
        message.startsWith('d1_error:') &&
        (message.includes('unique constraint failed') || message.includes('sqlite_constraint_unique'))
      ) {
        return true;
      }
      break;
    }
    if (!current || typeof current !== 'object') break;

    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    const code = typeof candidate.code === 'string' ? candidate.code : '';
    const message = typeof candidate.message === 'string' ? candidate.message.toLowerCase() : '';
    if (
      code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
      (
        code === 'SQLITE_CONSTRAINT' &&
        (message.includes('unique constraint failed') || message.includes('sqlite_constraint_unique'))
      ) ||
      (
        message.startsWith('d1_error:') &&
        (message.includes('unique constraint failed') || message.includes('sqlite_constraint_unique'))
      )
    ) {
      return true;
    }
    current = candidate.cause;
  }

  return false;
}

export async function createWorkspace(
  db: Db,
  name: string,
  options?: CreateWorkspaceOptions,
) {
  const providedOwnerApiKeyHash = typeof options === 'string' ? undefined : options?.ownerApiKeyHash;
  const providedOwnerApiKey = typeof options === 'string' ? options : options?.ownerApiKey;
  const expiresAt = typeof options === 'string' ? undefined : options?.expiresAt;
  const derivedOwnerApiKeyHash = providedOwnerApiKey ? await hashApiKey(providedOwnerApiKey) : undefined;

  if (providedOwnerApiKeyHash && derivedOwnerApiKeyHash && providedOwnerApiKeyHash !== derivedOwnerApiKeyHash) {
    throw codedError('ownerApiKeyHash must match the provided ownerApiKey', 'invalid_owner_api_key_hash', 400);
  }

  const ownerApiKeyHash = providedOwnerApiKeyHash ?? derivedOwnerApiKeyHash;

  // Repeated creates from the same owner/key should reuse the existing workspace.
  if (ownerApiKeyHash) {
    const [existing] = await db
      .select()
      .from(workspaces)
      .where(and(
        eq(workspaces.name, name),
        eq(workspaces.apiKeyHash, ownerApiKeyHash),
        or(isNull(workspaces.expiresAt), gt(workspaces.expiresAt, new Date())),
      ));
    if (existing) {
      const workspace = buildWorkspaceResponse(existing, providedOwnerApiKey);
      return {
        workspace,
        created: false,
        ...workspace,
      };
    }
  }

  const workspaceId = generateId();
  const apiKey = `rk_live_${randomHex(16)}`;
  const apiKeyHash = await hashApiKey(apiKey);

  const channelId = generateId();
  const expected = { workspaceId, name, apiKeyHash, channelId };
  let writeResult: WorkspaceWriteResult;
  try {
    writeResult = await retryD1Write(async () => {
      try {
        return await runAtomicWrites(
          db,
          (writeDb) => [
            writeDb
              .insert(workspaces)
              .values({ id: workspaceId, name, apiKeyHash, expiresAt })
              .returning(),
            writeDb
              .insert(channels)
              .values({
                id: channelId,
                workspaceId,
                name: 'general',
                topic: 'General discussion',
              })
              .returning(),
          ],
          { requireAtomic: true },
        ) as WorkspaceWriteResult;
      } catch (cause) {
        if (!isUniqueConstraintError(cause)) throw cause;

        // A prior attempt may have committed before its response was lost.
        // Accept only that exact generated pair; mismatched IDs fail closed.
        const committed = await readCommittedWorkspacePair(db, expected);
        if (committed.status === 'match') return committed.value;
        if (committed.status === 'unavailable') {
          const error = codedError(
            'Workspace storage temporarily unavailable',
            'workspace_storage_unavailable',
            503,
          );
          error.diagnostics = {
            operation: 'workspace.create',
            storage_error: 'readback_unavailable',
          };
          throw error;
        }
        throw codedError('Generated workspace identifier collision', 'workspace_id_collision', 500);
      }
    });
  } catch (cause) {
    if (!(cause instanceof D1WriteRetryExhaustedError)) throw cause;
    const committed = await readCommittedWorkspacePair(db, expected);
    if (committed.status === 'match') {
      writeResult = committed.value;
    } else {
      const error = codedError(
        'Workspace storage temporarily unavailable',
        'workspace_storage_unavailable',
        503,
      );
      error.diagnostics = {
        attempts: cause.attempts,
        operation: 'workspace.create',
        storage_error: cause.storageError,
      };
      throw error;
    }
  }

  const [workspaceRows] = writeResult;
  const createdWorkspace = workspaceRows[0];

  // A conflict can only be an idempotent replay of this exact generated pair.
  if (!isExpectedWorkspacePair(writeResult, expected) || !createdWorkspace) {
    throw codedError('Generated workspace identifier collision', 'workspace_id_collision', 500);
  }

  const workspace = buildWorkspaceResponse(createdWorkspace, apiKey);
  return {
    workspace,
    created: true,
    ...workspace,
  };
}

export async function getWorkspaceByName(db: Db, name: string) {
  const [workspace] = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      createdAt: workspaces.createdAt,
    })
    .from(workspaces)
    .where(eq(workspaces.name, name));
  if (!workspace) return null;

  return {
    id: workspace.id,
    name: workspace.name,
    created_at: workspace.createdAt.toISOString(),
  };
}

export async function getWorkspace(db: Db, workspaceId: string) {
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!workspace) return null;

  return {
    id: workspace.id,
    name: workspace.name,
    plan: workspace.plan,
    system_prompt: workspace.systemPrompt,
    created_at: workspace.createdAt.toISOString(),
    metadata: workspace.metadata,
    expires_at: workspace.expiresAt?.toISOString() ?? null,
  };
}

export async function updateWorkspace(
  db: Db,
  workspaceId: string,
  updates: { name?: string; system_prompt?: string | null },
) {
  const setClause: Record<string, unknown> = {};
  if (updates.name !== undefined) setClause.name = updates.name;
  if (updates.system_prompt !== undefined)
    setClause.systemPrompt = updates.system_prompt;

  if (Object.keys(setClause).length === 0) {
    return getWorkspace(db, workspaceId);
  }

  const [updated] = await db
    .update(workspaces)
    .set(setClause)
    .where(eq(workspaces.id, workspaceId))
    .returning();

  if (!updated) return null;

  return {
    id: updated.id,
    name: updated.name,
    plan: updated.plan,
    system_prompt: updated.systemPrompt,
    created_at: updated.createdAt.toISOString(),
    metadata: updated.metadata,
    expires_at: updated.expiresAt?.toISOString() ?? null,
  };
}

async function deleteWorkspaceBatch(
  db: Db,
  storage: FileStorage,
  workspaceIds: string[],
): Promise<string[]> {
  if (workspaceIds.length === 0) return [];

  if (typeof storage.deleteObjects !== 'function') {
    throw codedError(
      'The configured file storage cannot delete workspace objects',
      'file_storage_delete_unsupported',
      503,
    );
  }

  // Deleting the workspace cascades its file rows. Migration 0037's file
  // trigger writes each storage key to the durable cleanup outbox in this same
  // transaction, so database rollback can never strand retained rows whose
  // blobs were already removed. SQLite/D1 write serialization also means a
  // concurrent file insert either commits before this delete and is queued by
  // the cascade, or observes the deleted workspace and fails its FK check.
  const results = await runAtomicWrites(db, (writeDb) => [
    writeDb
      .delete(workspaceEvents)
      .where(inArray(workspaceEvents.workspaceId, workspaceIds)),
    writeDb
      .delete(workspaces)
      .where(inArray(workspaces.id, workspaceIds))
      .returning({ id: workspaces.id }),
  ]);
  const deleted = results[1] as Array<{ id: string }>;
  const deletedIds = deleted.map((workspace) => workspace.id);

  // Best-effort immediate revocation keeps old GET URLs from reading existing
  // bytes. The outbox row intentionally remains through the PUT URL's expiry,
  // then a scheduled drain deletes once more to catch a late presigned upload.
  // A storage failure is not surfaced as a failed workspace delete: the DB
  // commit is authoritative and the durable row is retried by later drains.
  try {
    await deleteQueuedWorkspaceObjects(db, storage, deletedIds);
  } catch {
    // The committed outbox is the source of truth after database deletion. A
    // post-commit query/update failure must not turn a completed DELETE into a
    // misleading error response; the maintenance drain will retry the row.
  }
  return deletedIds;
}

function cleanupErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function markCleanupFailure(
  db: Db,
  storageKeys: string[],
  err: unknown,
  now: Date,
): Promise<boolean> {
  if (storageKeys.length === 0) return true;
  try {
    await db
      .update(fileCleanupQueue)
      .set({
        attempts: sql`${fileCleanupQueue.attempts} + 1`,
        lastError: cleanupErrorMessage(err).slice(0, 2_000),
        processAfter: new Date(now.getTime() + FILE_CLEANUP_RETRY_MS),
      })
      .where(inArray(fileCleanupQueue.storageKey, storageKeys));
    return true;
  } catch {
    // The cleanup rows were already committed with the workspace deletion.
    // Preserve the original storage failure and let the next sweep retry even
    // if recording diagnostics itself races a database outage. The caller
    // stops its current loop so it cannot spin on the still-due rows.
    return false;
  }
}

async function deleteCleanupRows(
  db: Db,
  storage: FileStorage,
  rows: Array<{ storageKey: string; deleteAfter: Date }>,
  now: Date,
): Promise<{ settled: number; progressed: boolean }> {
  if (rows.length === 0) return { settled: 0, progressed: true };
  const storageKeys = rows.map((row) => row.storageKey);
  try {
    await storage.deleteObjects({ storageKeys });
  } catch (err) {
    return {
      settled: 0,
      progressed: await markCleanupFailure(db, storageKeys, err, now),
    };
  }

  const settledKeys = rows
    .filter((row) => row.deleteAfter.getTime() <= now.getTime())
    .map((row) => row.storageKey);
  const deferredKeys = rows
    .filter((row) => row.deleteAfter.getTime() > now.getTime())
    .map((row) => row.storageKey);
  if (settledKeys.length > 0) {
    await db.delete(fileCleanupQueue).where(inArray(fileCleanupQueue.storageKey, settledKeys));
  }
  if (deferredKeys.length > 0) {
    await db
      .update(fileCleanupQueue)
      .set({
        attempts: sql`${fileCleanupQueue.attempts} + 1`,
        lastError: null,
        processAfter: fileCleanupQueue.deleteAfter,
      })
      .where(inArray(fileCleanupQueue.storageKey, deferredKeys));
  }
  return { settled: settledKeys.length, progressed: true };
}

async function deleteQueuedWorkspaceObjects(
  db: Db,
  storage: FileStorage,
  workspaceIds: string[],
): Promise<void> {
  if (workspaceIds.length === 0) return;
  const prefixConditions = workspaceIds.map((workspaceId) =>
    like(fileCleanupQueue.storageKey, `${workspaceId}/%`));
  const now = new Date();
  for (;;) {
    const rows = await db
      .select({
        storageKey: fileCleanupQueue.storageKey,
        deleteAfter: fileCleanupQueue.deleteAfter,
      })
      .from(fileCleanupQueue)
      .where(and(
        or(...prefixConditions),
        lte(fileCleanupQueue.processAfter, now),
      ))
      .orderBy(asc(fileCleanupQueue.processAfter), asc(fileCleanupQueue.storageKey))
      .limit(MAX_FILE_CLEANUP_LIMIT);
    if (rows.length === 0) return;
    const result = await deleteCleanupRows(db, storage, rows, now);
    if (!result.progressed) return;
  }
}

/**
 * Retry durable blob tombstones that are due for an immediate attempt, a
 * storage-failure retry, or the final pass after the last upload capability
 * expires. Hosts should run this from their maintenance schedule; the Node
 * adapter does so every 15 seconds. Deletion is idempotent, making overlapping
 * sweepers safe.
 */
export async function drainFileCleanup(
  db: Db,
  storage: FileStorage,
  options: { now?: Date; limit?: number } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const requestedLimit = options.limit ?? DEFAULT_FILE_CLEANUP_LIMIT;
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(Math.trunc(requestedLimit), MAX_FILE_CLEANUP_LIMIT))
    : DEFAULT_FILE_CLEANUP_LIMIT;
  const rows = await db
    .select({
      storageKey: fileCleanupQueue.storageKey,
      deleteAfter: fileCleanupQueue.deleteAfter,
    })
    .from(fileCleanupQueue)
    .where(lte(fileCleanupQueue.processAfter, now))
    .orderBy(asc(fileCleanupQueue.processAfter), asc(fileCleanupQueue.storageKey))
    .limit(limit);
  return (await deleteCleanupRows(db, storage, rows, now)).settled;
}

export async function deleteWorkspace(
  db: Db,
  storage: FileStorage,
  workspaceId: string,
) {
  await deleteWorkspaceBatch(db, storage, [workspaceId]);
}

/**
 * Delete a bounded batch of workspaces whose callers explicitly opted into an
 * expiry deadline at creation. No inferred signal (name, age, agents, or
 * messages) participates in this predicate.
 */
export async function reapExpiredWorkspaces(
  db: Db,
  storage: FileStorage,
  options: { now?: Date; limit?: number } = {},
): Promise<string[]> {
  const now = options.now ?? new Date();
  // Always service prior durable cleanup work, even when no workspace reaches
  // its expiry in this tick. Existing cron integrations therefore pick up the
  // post-commit outbox without needing a second scheduler.
  await drainFileCleanup(db, storage, { now });
  const requestedLimit = options.limit ?? DEFAULT_WORKSPACE_REAP_LIMIT;
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(Math.trunc(requestedLimit), 90))
    : DEFAULT_WORKSPACE_REAP_LIMIT;
  const expired = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(lte(workspaces.expiresAt, now))
    .orderBy(asc(workspaces.expiresAt), asc(workspaces.id))
    .limit(limit);

  if (expired.length === 0) return [];

  const ids = expired.map((workspace) => workspace.id);
  return deleteWorkspaceBatch(db, storage, ids);
}
