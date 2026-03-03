import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { organizations, workspaces, orgMemberships, users } from '../db/schema.js';
import { generateId } from './snowflake.js';
import { hashToken } from '../middleware/auth.js';

type Db = ReturnType<typeof getDb>;

function generateOrgApiKey(): { key: string; hash: string } {
  const key = `rk_org_${crypto.randomBytes(16).toString('hex')}`;
  const hash = hashToken(key);
  return { key, hash };
}

/**
 * Create a new organization with the given user as owner.
 */
export async function createOrg(
  db: Db,
  userId: string,
  input: { name: string },
) {
  const orgId = generateId();
  const { key: orgApiKey, hash: orgApiKeyHash } = generateOrgApiKey();

  const [org] = await db
    .insert(organizations)
    .values({
      id: orgId,
      name: input.name,
      orgApiKeyHash,
    })
    .returning();

  // Add the creating user as owner
  await db.insert(orgMemberships).values({
    userId,
    organizationId: orgId,
    role: 'owner',
  });

  return {
    organization_id: orgId,
    org_api_key: orgApiKey,
    created_at: org.createdAt.toISOString(),
  };
}

/**
 * Create a shadow org for anonymous workspace creation (no user, no API key).
 */
export async function createShadowOrg(db: Db, name: string) {
  const orgId = generateId();
  await db.insert(organizations).values({
    id: orgId,
    name: `shadow-${name}`,
  });
  return orgId;
}

export async function getOrg(db: Db, orgId: string) {
  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, orgId));
  if (!org) return null;

  return {
    id: org.id,
    name: org.name,
    plan: org.plan,
    created_at: org.createdAt.toISOString(),
  };
}

export async function getOrgByApiKeyHash(db: Db, hash: string) {
  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.orgApiKeyHash, hash));
  return org || null;
}

export async function updateOrg(
  db: Db,
  orgId: string,
  updates: { name?: string },
) {
  const setClause: Record<string, unknown> = {};
  if (updates.name !== undefined) setClause.name = updates.name;

  if (Object.keys(setClause).length === 0) {
    return getOrg(db, orgId);
  }

  await db
    .update(organizations)
    .set(setClause)
    .where(eq(organizations.id, orgId));

  return getOrg(db, orgId);
}

export async function claimWorkspace(
  db: Db,
  orgId: string,
  workspaceApiKey: string,
) {
  const hash = hashToken(workspaceApiKey);
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.apiKeyHash, hash));

  if (!workspace) {
    const err = new Error('Invalid workspace API key');
    Object.assign(err, { code: 'invalid_workspace_key', status: 400 });
    throw err;
  }

  // Check the workspace's current org is a shadow org (no API key = shadow)
  const [currentOrg] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, workspace.organizationId));

  if (currentOrg && currentOrg.orgApiKeyHash) {
    const err = new Error('This workspace already belongs to a claimed organization');
    Object.assign(err, { code: 'workspace_already_claimed', status: 409 });
    throw err;
  }

  // Move workspace to the new org
  await db
    .update(workspaces)
    .set({ organizationId: orgId })
    .where(eq(workspaces.id, workspace.id));

  // Delete the old shadow org if it has no remaining workspaces
  if (currentOrg) {
    const remaining = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.organizationId, currentOrg.id));
    if (remaining.length === 0) {
      await db.delete(organizations).where(eq(organizations.id, currentOrg.id));
    }
  }

  return { workspace_id: workspace.id, organization_id: orgId };
}

export async function getOrgWorkspaces(db: Db, orgId: string) {
  const rows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.organizationId, orgId));

  return rows
    .filter((w) => !w.deletedAt)
    .map((w) => ({
      id: w.id,
      name: w.name,
      created_at: w.createdAt.toISOString(),
      last_activity_at: w.lastActivityAt?.toISOString() ?? null,
    }));
}

export async function setOrgPlan(
  db: Db,
  orgId: string,
  plan: string,
) {
  await db
    .update(organizations)
    .set({ plan })
    .where(eq(organizations.id, orgId));

  return getOrg(db, orgId);
}

// ── Membership management ──

export async function getOrgMembers(db: Db, orgId: string) {
  const memberships = await db
    .select()
    .from(orgMemberships)
    .where(eq(orgMemberships.organizationId, orgId));

  const result: {
    user_id: string;
    organization_id: string;
    role: string;
    user_email: string;
    user_name: string;
    created_at: string;
  }[] = [];

  for (const m of memberships) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, m.userId));
    if (user) {
      result.push({
        user_id: user.id,
        organization_id: orgId,
        role: m.role,
        user_email: user.email,
        user_name: user.name,
        created_at: m.createdAt.toISOString(),
      });
    }
  }

  return result;
}

export async function inviteMember(
  db: Db,
  orgId: string,
  email: string,
  role: string = 'member',
) {
  // Find user by email
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email));

  if (!user) {
    const err = new Error('No user found with this email. They must sign up first.');
    Object.assign(err, { code: 'user_not_found', status: 404 });
    throw err;
  }

  // Check if already a member
  const [existing] = await db
    .select()
    .from(orgMemberships)
    .where(
      and(
        eq(orgMemberships.userId, user.id),
        eq(orgMemberships.organizationId, orgId),
      ),
    );

  if (existing) {
    const err = new Error('User is already a member of this organization');
    Object.assign(err, { code: 'already_member', status: 409 });
    throw err;
  }

  await db.insert(orgMemberships).values({
    userId: user.id,
    organizationId: orgId,
    role,
  });

  return {
    user_id: user.id,
    organization_id: orgId,
    role,
    user_email: user.email,
    user_name: user.name,
  };
}

export async function removeMember(
  db: Db,
  orgId: string,
  userId: string,
) {
  // Don't allow removing the last owner
  const members = await db
    .select()
    .from(orgMemberships)
    .where(eq(orgMemberships.organizationId, orgId));

  const owners = members.filter((m) => m.role === 'owner');
  const isOwner = owners.some((m) => m.userId === userId);
  if (isOwner && owners.length === 1) {
    const err = new Error('Cannot remove the last owner of an organization');
    Object.assign(err, { code: 'last_owner', status: 400 });
    throw err;
  }

  await db
    .delete(orgMemberships)
    .where(
      and(
        eq(orgMemberships.userId, userId),
        eq(orgMemberships.organizationId, orgId),
      ),
    );
}
