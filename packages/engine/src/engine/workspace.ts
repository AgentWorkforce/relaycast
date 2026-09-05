import { and, asc, eq, gt, inArray, isNull, like, lte, or, sql } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { workspaces, channels, fileCleanupQueue, workspaceEvents, workspaceCreateIdempotency } from '../db/schema.js';
import { hmacSha256Hex, randomHex, sha256Hex } from '../lib/crypto.js';
import { generateId } from './snowflake.js';
import { codedError } from '../lib/httpError.js';
import { D1WriteRetryExhaustedError, retryD1Write } from '../lib/d1Retry.js';
import { runAtomicWrites } from '../ports/database.js';
import type { FileStorage } from '../ports/files.js';
import type { WorkspaceProvenanceRecord } from '../db/schema.js';
import { resolveEffectiveMessageRetention } from './retention.js';

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
      idempotencyKey?: string;
      requestDigest?: string;
      expiresAt?: Date;
      provenance?: WorkspaceProvenanceRecord;
      usageClassification?: 'internal' | 'external' | 'unknown';
      classificationSource?: 'creator' | 'operator' | 'unclassified';
      classificationReason?: string | null;
      classifiedAt?: Date | null;
    };

export const DEFAULT_WORKSPACE_REAP_LIMIT = 25;
export const DEFAULT_FILE_CLEANUP_LIMIT = 90;
const MAX_FILE_CLEANUP_LIMIT = 90;
const FILE_CLEANUP_RETRY_MS = 30_000;

function hashApiKey(apiKey: string): Promise<string> {
  return sha256Hex(apiKey);
}

/** Canonical digest for the public workspace-create request contract. */
export function workspaceCreateRequestDigest(input: {
  name: string;
  expiresInSeconds?: number;
  provenance?: Pick<WorkspaceProvenanceRecord, 'source' | 'origin_id' | 'classification'>;
}): Promise<string> {
  const provenance = input.provenance === undefined
    ? undefined
    : {
        source: input.provenance.source,
        ...(input.provenance.origin_id === undefined ? {} : { origin_id: input.provenance.origin_id }),
        ...(input.provenance.classification === undefined
          ? {}
          : { classification: input.provenance.classification }),
      };

  return sha256Hex(JSON.stringify({
    name: input.name,
    ...(input.expiresInSeconds === undefined ? {} : { expires_in_seconds: input.expiresInSeconds }),
    ...(provenance === undefined ? {} : { provenance }),
  }));
}

async function deriveIdempotentWorkspaceApiKey(ownerApiKey: string, idempotencyKey: string, requestDigest: string): Promise<string> {
  const material = `relaycast:workspace-create:v1:${idempotencyKey}:${requestDigest}`;
  return `rk_live_${(await hmacSha256Hex(material, ownerApiKey)).slice(0, 32)}`;
}

function idempotencyConflict(message: string, code = 'workspace_create_idempotency_conflict') {
  return codedError(message, code, 409);
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
  const createOptions = typeof options === 'string' ? undefined : options;
  const idempotencyKey = createOptions?.idempotencyKey;
  const requestDigest = createOptions?.requestDigest;

  if (idempotencyKey && !providedOwnerApiKey) {
    throw codedError(
      'An authenticated owner API key is required when Idempotency-Key is supplied',
      'workspace_create_idempotency_owner_required',
      401,
    );
  }
  if (idempotencyKey && !requestDigest) {
    throw codedError(
      'A request digest is required for workspace create idempotency',
      'workspace_create_idempotency_digest_required',
      400,
    );
  }

  const idempotencyKeyHash = idempotencyKey ? await hashApiKey(idempotencyKey) : undefined;
  const deterministicApiKey = idempotencyKey && requestDigest
    ? await deriveIdempotentWorkspaceApiKey(providedOwnerApiKey!, idempotencyKey, requestDigest)
    : undefined;

  if (ownerApiKeyHash && idempotencyKeyHash && requestDigest) {
    const [binding] = await db
      .select()
      .from(workspaceCreateIdempotency)
      .where(and(
        eq(workspaceCreateIdempotency.ownerScopeHash, ownerApiKeyHash),
        eq(workspaceCreateIdempotency.idempotencyKeyHash, idempotencyKeyHash),
      ));
    if (binding) {
      if (binding.requestDigest !== requestDigest) {
        throw idempotencyConflict('Idempotency-Key was reused with a different request payload');
      }
      if (binding.status !== 'active') {
        throw idempotencyConflict(
          'The workspace create idempotency binding has been terminalized and cannot be replayed',
          'workspace_create_idempotency_terminalized',
        );
      }
      const [existing] = await db.select().from(workspaces).where(eq(workspaces.id, binding.workspaceId));
      if (!existing || existing.apiKeyHash !== await hashApiKey(deterministicApiKey!)) {
        throw idempotencyConflict(
          'The workspace create idempotency binding cannot recover its child workspace',
          'workspace_create_idempotency_unusable',
        );
      }
      const workspace = buildWorkspaceResponse(existing, deterministicApiKey);
      return { workspace, created: false, ...workspace };
    }
  }

  // Repeated creates from the same owner/key should reuse the existing workspace.
  if (ownerApiKeyHash && !idempotencyKey) {
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
  const apiKey = deterministicApiKey ?? `rk_live_${randomHex(16)}`;
  const apiKeyHash = await hashApiKey(apiKey);

  const channelId = generateId();
  const expected = { workspaceId, name, apiKeyHash, channelId };
  let replayedWorkspace: typeof workspaces.$inferSelect | undefined;
  let recoveredOwnWorkspace = false;
  let writeResult: WorkspaceWriteResult;
  try {
    writeResult = await retryD1Write(async () => {
      try {
        return await runAtomicWrites(
          db,
          (writeDb) => [
            writeDb
              .insert(workspaces)
              .values({
                id: workspaceId,
                name,
                apiKeyHash,
                expiresAt,
                provenance: createOptions?.provenance,
                usageClassification: createOptions?.usageClassification ?? 'unknown',
                classificationSource: createOptions?.classificationSource ?? 'unclassified',
                classificationReason: createOptions?.classificationReason ?? null,
                classifiedAt: createOptions?.classifiedAt ?? null,
              })
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
            ...(ownerApiKeyHash && idempotencyKeyHash && requestDigest
              ? [writeDb.insert(workspaceCreateIdempotency).values({
                ownerScopeHash: ownerApiKeyHash,
                idempotencyKeyHash,
                requestDigest,
                workspaceId,
              }).returning()]
              : []),
          ],
          { requireAtomic: true },
        ) as WorkspaceWriteResult;
      } catch (cause) {
        if (isUniqueConstraintError(cause) && ownerApiKeyHash && idempotencyKeyHash && requestDigest) {
          const [binding] = await db.select().from(workspaceCreateIdempotency).where(and(
            eq(workspaceCreateIdempotency.ownerScopeHash, ownerApiKeyHash),
            eq(workspaceCreateIdempotency.idempotencyKeyHash, idempotencyKeyHash),
          ));
          if (binding) {
            if (binding.requestDigest !== requestDigest) {
              throw idempotencyConflict('Idempotency-Key was reused with a different request payload');
            }
            if (binding.status !== 'active') {
              throw idempotencyConflict(
                'The workspace create idempotency binding has been terminalized and cannot be replayed',
                'workspace_create_idempotency_terminalized',
              );
            }
            const [existing] = await db.select().from(workspaces).where(eq(workspaces.id, binding.workspaceId));
            if (!existing || existing.apiKeyHash !== apiKeyHash) {
              throw idempotencyConflict(
                'The workspace create idempotency binding cannot recover its child workspace',
                'workspace_create_idempotency_unusable',
              );
            }
            replayedWorkspace = existing;
            // The binding can point at this invocation's generated workspace
            // when the first atomic write committed but its response was lost.
            // Preserve the original create semantics in that case; a binding
            // owned by another invocation is a replay and must remain 200/false.
            recoveredOwnWorkspace = existing.id === workspaceId;
            return [[existing], await db.select().from(channels).where(eq(channels.workspaceId, existing.id))] as WorkspaceWriteResult;
          }
        }
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

  if (replayedWorkspace) {
    const workspace = buildWorkspaceResponse(replayedWorkspace, apiKey);
    return { workspace, created: recoveredOwnWorkspace, ...workspace };
  }

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

export async function getWorkspace(
  db: Db,
  workspaceId: string,
  deploymentMessageTtlDays?: number | null,
) {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) return null;

  let effectiveMessageRetention;
  try {
    effectiveMessageRetention = await resolveEffectiveMessageRetention(
      db,
      workspaceId,
      deploymentMessageTtlDays,
    );
  } catch {
    effectiveMessageRetention = {
      policy: 'unknown' as const,
      message_ttl_days: null,
      retained_since: null,
      source: 'unknown' as const,
      reason: 'boundary_unavailable' as const,
    };
  }

  return {
    id: workspace.id,
    name: workspace.name,
    plan: workspace.plan,
    system_prompt: workspace.systemPrompt,
    created_at: workspace.createdAt.toISOString(),
    metadata: workspace.metadata,
    effective_retention: { messages: effectiveMessageRetention },
    expires_at: workspace.expiresAt?.toISOString() ?? null,
    provenance: workspace.provenance ?? null,
    usage_classification: workspace.usageClassification,
    classification_source: workspace.classificationSource,
    classification_reason: workspace.classificationReason,
    classified_at: workspace.classifiedAt?.toISOString() ?? null,
  };
}

export async function updateWorkspace(
  db: Db,
  workspaceId: string,
  updates: { name?: string; system_prompt?: string | null },
  deploymentMessageTtlDays?: number | null,
) {
  const setClause: Record<string, unknown> = {};
  if (updates.name !== undefined) setClause.name = updates.name;
  if (updates.system_prompt !== undefined)
    setClause.systemPrompt = updates.system_prompt;

  if (Object.keys(setClause).length === 0) {
    return getWorkspace(db, workspaceId, deploymentMessageTtlDays);
  }

  const [updated] = await db
    .update(workspaces)
    .set(setClause)
    .where(eq(workspaces.id, workspaceId))
    .returning();

  if (!updated) return null;

  return getWorkspace(db, updated.id, deploymentMessageTtlDays);
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
  try {
    await retryD1Write(() => runAtomicWrites(
      db,
      (writeDb) => [
        writeDb
          .delete(workspaceEvents)
          .where(inArray(workspaceEvents.workspaceId, workspaceIds)),
        writeDb
          .update(workspaceCreateIdempotency)
          .set({ status: 'terminalized', terminalizedAt: new Date() })
          .where(inArray(workspaceCreateIdempotency.workspaceId, workspaceIds)),
        writeDb
          .delete(workspaces)
          .where(inArray(workspaces.id, workspaceIds)),
      ],
      { requireAtomic: true },
    ));
  } catch (cause) {
    if (!(cause instanceof D1WriteRetryExhaustedError)) throw cause;

    let committed = false;
    let storageError: string = cause.storageError;
    try {
      const remaining = await db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(inArray(workspaces.id, workspaceIds));
      committed = remaining.length === 0;
    } catch {
      storageError = 'readback_unavailable';
    }
    if (!committed) {
      const error = codedError(
        'Workspace storage temporarily unavailable',
        'workspace_storage_unavailable',
        503,
      );
      error.diagnostics = {
        attempts: cause.attempts,
        operation: 'workspace.delete',
        storage_error: storageError,
      };
      throw error;
    }
  }
  const deletedIds = workspaceIds;

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
  if (typeof storage.deleteObjects !== 'function') {
    const error = codedError(
      'The configured file storage cannot delete workspace objects',
      'file_storage_delete_unsupported',
      503,
    );
    return {
      settled: 0,
      progressed: await markCleanupFailure(db, storageKeys, error, now),
    };
  }
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
