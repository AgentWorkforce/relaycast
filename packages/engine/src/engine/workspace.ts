import { and, eq } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { workspaces, channels } from '../db/schema.js';
import { randomHex, sha256Hex } from '../lib/crypto.js';
import { generateId } from './snowflake.js';
import { codedError } from '../lib/httpError.js';

type Db = ReturnType<typeof getDb>;

type CreateWorkspaceOptions =
  | string
  | {
      ownerApiKey?: string;
      ownerApiKeyHash?: string;
      sponsorOrgId?: string;
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

export async function createWorkspace(
  db: Db,
  name: string,
  options?: CreateWorkspaceOptions,
) {
  const providedOwnerApiKeyHash = typeof options === 'string' ? undefined : options?.ownerApiKeyHash;
  const providedOwnerApiKey = typeof options === 'string' ? options : options?.ownerApiKey;
  const sponsorOrgId = typeof options === 'string' ? undefined : options?.sponsorOrgId;
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
      if (sponsorOrgId !== undefined && existing.sponsorOrgId !== sponsorOrgId) {
        throw codedError(
          existing.sponsorOrgId === null
            ? 'Legacy workspace must be migrated by an incumbent agent before sponsored reuse'
            : 'Sponsor proof organization does not match this workspace',
          existing.sponsorOrgId === null ? 'workspace_sponsor_migration_required' : 'workspace_sponsor_org_mismatch',
          existing.sponsorOrgId === null ? 409 : 403,
        );
      }
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

  const [createdWorkspace] = await db
    .insert(workspaces)
    .values({
      id: workspaceId,
      name,
      apiKeyHash,
      sponsorOrgId,
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
