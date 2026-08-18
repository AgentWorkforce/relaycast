import { and, eq } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { workspaces, channels } from '../db/schema.js';
import { randomHex, sha256Hex } from '../lib/crypto.js';
import { generateId } from './snowflake.js';
import { codedError } from '../lib/httpError.js';
import { D1WriteRetryExhaustedError, retryD1Write } from '../lib/d1Retry.js';
import { runAtomicWrites } from '../ports/database.js';

type Db = ReturnType<typeof getDb>;

type WorkspaceWriteResult = [
  Array<typeof workspaces.$inferSelect>,
  Array<typeof channels.$inferSelect>,
];

type CreateWorkspaceOptions =
  | string
  | {
      ownerApiKey?: string;
      ownerApiKeyHash?: string;
    };

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
): Promise<WorkspaceWriteResult | undefined> {
  try {
    const [workspaceRows, channelRows] = await Promise.all([
      db.select().from(workspaces).where(eq(workspaces.id, expected.workspaceId)),
      db.select().from(channels).where(eq(channels.id, expected.channelId)),
    ]);
    const result: WorkspaceWriteResult = [workspaceRows, channelRows];
    return isExpectedWorkspacePair(result, expected) ? result : undefined;
  } catch {
    return undefined;
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
      .where(and(eq(workspaces.name, name), eq(workspaces.apiKeyHash, ownerApiKeyHash)));
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
              .values({ id: workspaceId, name, apiKeyHash })
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
        if (committed) return committed;
        throw codedError('Generated workspace identifier collision', 'workspace_id_collision', 500);
      }
    });
  } catch (cause) {
    if (!(cause instanceof D1WriteRetryExhaustedError)) throw cause;
    const committed = await readCommittedWorkspacePair(db, expected);
    if (committed) {
      writeResult = committed;
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
  };
}

export async function deleteWorkspace(db: Db, workspaceId: string) {
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
}
