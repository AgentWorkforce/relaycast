import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../db";
import {
  authIdentities,
  organizationMemberships,
  organizations,
  users,
  workspaces,
} from "../db/schema";
import type { AuthContext, AuthUser } from "./types";

export type GoogleLoginInput = {
  providerUserId: string;
  email?: string | null;
  emailVerified?: boolean;
  name?: string | null;
  avatarUrl?: string | null;
};

function now(): Date {
  return new Date();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 48) || "workspace";
}

function randomSuffix(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

function personalOrganizationName(input: { name?: string | null; email?: string | null }): string {
  const candidate = input.name?.trim() || input.email?.split("@")[0]?.trim() || "Personal";
  return `${candidate}'s Workspace`;
}

async function createUserWithDefaultOrganization(payload: GoogleLoginInput): Promise<string> {
  const db = getDb();
  const userId = crypto.randomUUID();
  const organizationId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const timestamp = now();
  const orgName = personalOrganizationName(payload);
  const orgSlug = `${slugify(orgName)}-${randomSuffix()}`;

  await db.transaction(async (tx) => {
    await tx.insert(users).values({
      id: userId,
      primaryEmail: payload.email ?? null,
      name: payload.name ?? null,
      avatarUrl: payload.avatarUrl ?? null,
      lastOrganizationId: organizationId,
      lastWorkspaceId: workspaceId,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await tx.insert(authIdentities).values({
      id: crypto.randomUUID(),
      userId,
      provider: "google",
      providerUserId: payload.providerUserId,
      email: payload.email ?? null,
      emailVerified: payload.emailVerified === true,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await tx.insert(organizations).values({
      id: organizationId,
      slug: orgSlug,
      name: orgName,
      createdByUserId: userId,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await tx.insert(organizationMemberships).values({
      organizationId,
      userId,
      role: "owner",
      status: "active",
      joinedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await tx.insert(workspaces).values({
      id: workspaceId,
      organizationId,
      slug: "default",
      name: "Default",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  });

  return userId;
}

export async function upsertGoogleUser(payload: GoogleLoginInput): Promise<string> {
  const db = getDb();
  const existing = await db
    .select({ userId: authIdentities.userId })
    .from(authIdentities)
    .where(
      and(
        eq(authIdentities.provider, "google"),
        eq(authIdentities.providerUserId, payload.providerUserId),
      ),
    )
    .limit(1);

  const existingIdentity = existing[0];

  if (!existingIdentity) {
    return createUserWithDefaultOrganization(payload);
  }

  const timestamp = now();

  await db
    .update(authIdentities)
    .set({
      email: payload.email ?? null,
      emailVerified: payload.emailVerified === true,
      updatedAt: timestamp,
    })
    .where(
      and(
        eq(authIdentities.provider, "google"),
        eq(authIdentities.providerUserId, payload.providerUserId),
      ),
    );

  await db
    .update(users)
    .set({
      primaryEmail: payload.email ?? undefined,
      name: payload.name ?? undefined,
      avatarUrl: payload.avatarUrl ?? undefined,
      updatedAt: timestamp,
    })
    .where(eq(users.id, existingIdentity.userId));

  return existingIdentity.userId;
}

async function resolveAccessibleWorkspace(
  userId: string,
  preferredWorkspaceId?: string | null,
  preferredOrganizationId?: string | null,
) {
  const db = getDb();

  if (preferredWorkspaceId) {
    const preferred = await db
      .select({
        id: workspaces.id,
        organizationId: workspaces.organizationId,
        slug: workspaces.slug,
        name: workspaces.name,
      })
      .from(workspaces)
      .innerJoin(
        organizationMemberships,
        eq(organizationMemberships.organizationId, workspaces.organizationId),
      )
      .where(
        and(
          eq(workspaces.id, preferredWorkspaceId),
          eq(organizationMemberships.userId, userId),
          eq(organizationMemberships.status, "active"),
        ),
      )
      .limit(1);

    const preferredWorkspace = preferred[0];

    if (preferredWorkspace) {
      return preferredWorkspace;
    }
  }

  if (preferredOrganizationId) {
    const [organizationWorkspace] = await db
      .select({
        id: workspaces.id,
        organizationId: workspaces.organizationId,
        slug: workspaces.slug,
        name: workspaces.name,
      })
      .from(workspaces)
      .innerJoin(
        organizationMemberships,
        eq(organizationMemberships.organizationId, workspaces.organizationId),
      )
      .where(
        and(
          eq(workspaces.organizationId, preferredOrganizationId),
          eq(organizationMemberships.userId, userId),
          eq(organizationMemberships.status, "active"),
        ),
      )
      .orderBy(asc(workspaces.createdAt))
      .limit(1);

    if (organizationWorkspace) {
      return organizationWorkspace;
    }
  }

  const [workspace] = await db
    .select({
      id: workspaces.id,
      organizationId: workspaces.organizationId,
      slug: workspaces.slug,
      name: workspaces.name,
    })
    .from(workspaces)
    .innerJoin(
      organizationMemberships,
      eq(organizationMemberships.organizationId, workspaces.organizationId),
    )
    .where(
      and(
        eq(organizationMemberships.userId, userId),
        eq(organizationMemberships.status, "active"),
      ),
    )
    .orderBy(asc(workspaces.createdAt))
    .limit(1);

  return workspace;
}

export async function getAuthContext(
  userId: string,
  preferredWorkspaceId?: string | null,
  preferredOrganizationId?: string | null,
): Promise<AuthContext> {
  const db = getDb();

  const user = await db
    .select({
      id: users.id,
      email: users.primaryEmail,
      name: users.name,
      avatarUrl: users.avatarUrl,
      lastOrganizationId: users.lastOrganizationId,
      lastWorkspaceId: users.lastWorkspaceId,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const currentUser = user[0];

  if (!currentUser) {
    throw new Error("User not found");
  }

  const organizationRows = await db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      name: organizations.name,
      role: organizationMemberships.role,
      status: organizationMemberships.status,
    })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
    .where(
      and(
        eq(organizationMemberships.userId, userId),
        eq(organizationMemberships.status, "active"),
      ),
    )
    .orderBy(asc(organizations.createdAt));

  const currentWorkspace = await resolveAccessibleWorkspace(
    userId,
    preferredWorkspaceId ?? currentUser.lastWorkspaceId,
    preferredOrganizationId ?? currentUser.lastOrganizationId,
  );

  if (!currentWorkspace) {
    throw new Error("No active workspace");
  }

  const currentOrganization =
    organizationRows.find((organization) => organization.id === currentWorkspace.organizationId) ??
    organizationRows[0];

  if (!currentOrganization) {
    throw new Error("No active organization");
  }

  const workspaceRows = await db
    .select({
      id: workspaces.id,
      organization_id: workspaces.organizationId,
      slug: workspaces.slug,
      name: workspaces.name,
    })
    .from(workspaces)
    .innerJoin(
      organizationMemberships,
      eq(organizationMemberships.organizationId, workspaces.organizationId),
    )
    .where(
      and(
        eq(organizationMemberships.userId, userId),
        eq(organizationMemberships.status, "active"),
      ),
    )
    .orderBy(asc(workspaces.createdAt));

  if (
    currentUser.lastWorkspaceId !== currentWorkspace.id ||
    currentUser.lastOrganizationId !== currentOrganization.id
  ) {
    await db
      .update(users)
      .set({
        lastWorkspaceId: currentWorkspace.id,
        lastOrganizationId: currentOrganization.id,
        updatedAt: now(),
      })
      .where(eq(users.id, userId));
  }

  return {
    user: {
      id: currentUser.id,
      email: currentUser.email,
      name: currentUser.name,
      avatarUrl: currentUser.avatarUrl,
    },
    organizations: organizationRows,
    currentOrganization,
    workspaces: workspaceRows,
    currentWorkspace: {
      id: currentWorkspace.id,
      organization_id: currentWorkspace.organizationId,
      slug: currentWorkspace.slug,
      name: currentWorkspace.name,
    },
  };
}

export async function getAuthUserProfile(userId: string): Promise<AuthUser> {
  const db = getDb();
  const [user] = await db
    .select({
      id: users.id,
      email: users.primaryEmail,
      name: users.name,
      avatarUrl: users.avatarUrl,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    throw new Error("User not found");
  }

  return user;
}
