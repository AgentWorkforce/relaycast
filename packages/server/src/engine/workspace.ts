import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { workspaces, channels } from '../db/schema.js';
import { generateId } from './snowflake.js';

type Db = ReturnType<typeof getDb>;

export async function createWorkspace(db: Db, name: string) {
  // Check for duplicate name
  const [existing] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.name, name));
  if (existing) {
    const err = new Error(`Workspace "${name}" already exists`);
    Object.assign(err, { code: 'workspace_already_exists', status: 409 });
    throw err;
  }

  const workspaceId = generateId();
  const apiKey = `rk_live_${crypto.randomBytes(16).toString('hex')}`;
  const apiKeyHash = crypto
    .createHash('sha256')
    .update(apiKey)
    .digest('hex');

  const [workspace] = await db
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

  return {
    workspace_id: workspaceId,
    api_key: apiKey,
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
  updates: { name?: string; system_prompt?: string },
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
