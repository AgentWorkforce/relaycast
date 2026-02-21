import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { workspaces, channels, organizations } from '../db/schema.js';
import { generateId } from './snowflake.js';
import { createShadowOrg } from './organization.js';

type Db = ReturnType<typeof getDb>;

export async function createWorkspace(db: Db, name: string, organizationId?: string) {
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

  // If no org provided, create a shadow org
  const orgId = organizationId ?? await createShadowOrg(db, name);

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
      organizationId: orgId,
      name,
      apiKeyHash,
      lastActivityAt: new Date(),
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

  // Get plan from org
  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, workspace.organizationId));

  return {
    id: workspace.id,
    organization_id: workspace.organizationId,
    name: workspace.name,
    plan: (org?.plan ?? 'free') as string,
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

  await db
    .update(workspaces)
    .set(setClause)
    .where(eq(workspaces.id, workspaceId));

  return getWorkspace(db, workspaceId);
}

export async function deleteWorkspace(db: Db, workspaceId: string) {
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
}

export async function touchLastActivity(db: Db, workspaceId: string) {
  await db
    .update(workspaces)
    .set({ lastActivityAt: new Date() })
    .where(eq(workspaces.id, workspaceId));
}
