import crypto from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { workspaces, channels } from '../db/schema.js';
import { generateId } from './snowflake.js';

type Db = ReturnType<typeof getDb>;

type CreateWorkspaceOptions =
  | string
  | {
      ownerApiKey?: string;
      ownerApiKeyHash?: string;
    };

function hashApiKey(apiKey: string) {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
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

export async function createWorkspace(
  db: Db,
  name: string,
  options?: CreateWorkspaceOptions,
) {
  const providedOwnerApiKeyHash = typeof options === 'string' ? undefined : options?.ownerApiKeyHash;
  const providedOwnerApiKey = typeof options === 'string' ? options : options?.ownerApiKey;
  const derivedOwnerApiKeyHash = providedOwnerApiKey ? hashApiKey(providedOwnerApiKey) : undefined;

  if (providedOwnerApiKeyHash && derivedOwnerApiKeyHash && providedOwnerApiKeyHash !== derivedOwnerApiKeyHash) {
    const err = new Error('ownerApiKeyHash must match the provided ownerApiKey');
    Object.assign(err, { code: 'invalid_owner_api_key_hash', status: 400 });
    throw err;
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
  const apiKey = `rk_live_${crypto.randomBytes(16).toString('hex')}`;
  const apiKeyHash = hashApiKey(apiKey);

  const [createdWorkspace] = await db
    .insert(workspaces)
    .values({
      id: workspaceId,
      name,
      apiKeyHash,
    })
    .returning();

  // Auto-create #general channel
  const channelId = generateId();
  await db.insert(channels).values({
    id: channelId,
    workspaceId,
    name: 'general',
    topic: 'General discussion',
  });

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
