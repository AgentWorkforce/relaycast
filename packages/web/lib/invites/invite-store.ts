import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  organizationInvites,
  organizationMemberships,
  organizations,
  users,
} from "@/lib/db/schema";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function now(): Date {
  return new Date();
}

export async function requireOrgOwner(organizationId: string, userId: string): Promise<boolean> {
  const db = getDb();
  const [membership] = await db
    .select({ role: organizationMemberships.role })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, organizationId),
        eq(organizationMemberships.userId, userId),
        eq(organizationMemberships.status, "active"),
      ),
    )
    .limit(1);

  return membership?.role === "owner";
}

export async function requireOrgMember(organizationId: string, userId: string): Promise<boolean> {
  const db = getDb();
  const [membership] = await db
    .select({ role: organizationMemberships.role })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, organizationId),
        eq(organizationMemberships.userId, userId),
        eq(organizationMemberships.status, "active"),
      ),
    )
    .limit(1);

  return Boolean(membership);
}

export type CreateInviteInput = {
  organizationId: string;
  email: string;
  role: string;
  invitedByUserId: string;
};

export type Invite = {
  id: string;
  organizationId: string;
  organizationName: string;
  email: string;
  role: string;
  token: string;
  invitedByUserId: string;
  invitedByName: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  canceledAt: Date | null;
  createdAt: Date;
};

export async function createInvite(input: CreateInviteInput): Promise<Invite> {
  const db = getDb();
  const timestamp = now();

  const isOwner = await requireOrgOwner(input.organizationId, input.invitedByUserId);
  if (!isOwner) {
    throw new Error("Only organization owners can invite members");
  }

  // Check if user is already a member
  const existingMember = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(
      organizationMemberships,
      and(
        eq(organizationMemberships.userId, users.id),
        eq(organizationMemberships.organizationId, input.organizationId),
        eq(organizationMemberships.status, "active"),
      ),
    )
    .where(eq(users.primaryEmail, input.email))
    .limit(1);

  if (existingMember.length > 0) {
    throw new Error("User is already a member of this organization");
  }

  // Cancel any existing pending invite for this email+org
  await db
    .update(organizationInvites)
    .set({ canceledAt: timestamp, updatedAt: timestamp })
    .where(
      and(
        eq(organizationInvites.organizationId, input.organizationId),
        eq(organizationInvites.email, input.email.toLowerCase()),
        isNull(organizationInvites.acceptedAt),
        isNull(organizationInvites.canceledAt),
      ),
    );

  const id = crypto.randomUUID();
  const token = crypto.randomUUID();

  await db.insert(organizationInvites).values({
    id,
    organizationId: input.organizationId,
    email: input.email.toLowerCase(),
    role: input.role,
    token,
    invitedByUserId: input.invitedByUserId,
    expiresAt: new Date(timestamp.getTime() + INVITE_TTL_MS),
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .limit(1);

  const [inviter] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, input.invitedByUserId))
    .limit(1);

  return {
    id,
    organizationId: input.organizationId,
    organizationName: org?.name ?? "Unknown",
    email: input.email.toLowerCase(),
    role: input.role,
    token,
    invitedByUserId: input.invitedByUserId,
    invitedByName: inviter?.name ?? null,
    expiresAt: new Date(timestamp.getTime() + INVITE_TTL_MS),
    acceptedAt: null,
    canceledAt: null,
    createdAt: timestamp,
  };
}

export async function listPendingInvites(organizationId: string) {
  const db = getDb();

  const rows = await db
    .select({
      id: organizationInvites.id,
      email: organizationInvites.email,
      role: organizationInvites.role,
      expiresAt: organizationInvites.expiresAt,
      createdAt: organizationInvites.createdAt,
      invitedByName: users.name,
    })
    .from(organizationInvites)
    .innerJoin(users, eq(users.id, organizationInvites.invitedByUserId))
    .where(
      and(
        eq(organizationInvites.organizationId, organizationId),
        isNull(organizationInvites.acceptedAt),
        isNull(organizationInvites.canceledAt),
      ),
    );

  return rows.filter((row) => row.expiresAt > now());
}

export async function cancelInvite(inviteId: string, userId: string): Promise<void> {
  const db = getDb();

  const [invite] = await db
    .select({
      organizationId: organizationInvites.organizationId,
    })
    .from(organizationInvites)
    .where(
      and(
        eq(organizationInvites.id, inviteId),
        isNull(organizationInvites.acceptedAt),
        isNull(organizationInvites.canceledAt),
      ),
    )
    .limit(1);

  if (!invite) {
    throw new Error("Invite not found");
  }

  const isOwner = await requireOrgOwner(invite.organizationId, userId);
  if (!isOwner) {
    throw new Error("Only organization owners can cancel invites");
  }

  await db
    .update(organizationInvites)
    .set({ canceledAt: now(), updatedAt: now() })
    .where(eq(organizationInvites.id, inviteId));
}

export async function resolveInviteByToken(token: string) {
  const db = getDb();

  const [invite] = await db
    .select({
      id: organizationInvites.id,
      organizationId: organizationInvites.organizationId,
      organizationName: organizations.name,
      email: organizationInvites.email,
      role: organizationInvites.role,
      token: organizationInvites.token,
      invitedByName: users.name,
      expiresAt: organizationInvites.expiresAt,
      acceptedAt: organizationInvites.acceptedAt,
      canceledAt: organizationInvites.canceledAt,
    })
    .from(organizationInvites)
    .innerJoin(organizations, eq(organizations.id, organizationInvites.organizationId))
    .innerJoin(users, eq(users.id, organizationInvites.invitedByUserId))
    .where(eq(organizationInvites.token, token))
    .limit(1);

  return invite ?? null;
}

export async function acceptInvite(token: string, userId: string): Promise<{ organizationId: string }> {
  const db = getDb();
  const timestamp = now();

  const invite = await resolveInviteByToken(token);

  if (!invite) {
    throw new Error("Invite not found");
  }

  if (invite.acceptedAt) {
    throw new Error("Invite has already been accepted");
  }

  if (invite.canceledAt) {
    throw new Error("Invite has been canceled");
  }

  if (invite.expiresAt <= timestamp) {
    throw new Error("Invite has expired");
  }

  // Verify the accepting user's email matches
  const [user] = await db
    .select({ email: users.primaryEmail })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user || user.email?.toLowerCase() !== invite.email.toLowerCase()) {
    throw new Error("This invite was sent to a different email address");
  }

  // Check for any existing membership row (active or inactive)
  const [existingMembership] = await db
    .select({
      role: organizationMemberships.role,
      status: organizationMemberships.status,
    })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, invite.organizationId),
        eq(organizationMemberships.userId, userId),
      ),
    )
    .limit(1);

  await db.transaction(async (tx) => {
    if (existingMembership) {
      if (existingMembership.status !== "active") {
        // Reactivate an inactive membership
        await tx
          .update(organizationMemberships)
          .set({
            role: invite.role,
            status: "active",
            joinedAt: timestamp,
            updatedAt: timestamp,
          })
          .where(
            and(
              eq(organizationMemberships.organizationId, invite.organizationId),
              eq(organizationMemberships.userId, userId),
            ),
          );
      }
    } else {
      await tx.insert(organizationMemberships).values({
        organizationId: invite.organizationId,
        userId,
        role: invite.role,
        status: "active",
        joinedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }

    await tx
      .update(organizationInvites)
      .set({ acceptedAt: timestamp, updatedAt: timestamp })
      .where(eq(organizationInvites.id, invite.id));
  });

  return { organizationId: invite.organizationId };
}

export async function acceptPendingInvitesForEmail(email: string, userId: string): Promise<void> {
  const db = getDb();
  const timestamp = now();

  const pendingInvites = await db
    .select({
      id: organizationInvites.id,
      organizationId: organizationInvites.organizationId,
      role: organizationInvites.role,
      expiresAt: organizationInvites.expiresAt,
    })
    .from(organizationInvites)
    .where(
      and(
        eq(organizationInvites.email, email.toLowerCase()),
        isNull(organizationInvites.acceptedAt),
        isNull(organizationInvites.canceledAt),
      ),
    );

  for (const invite of pendingInvites) {
    if (invite.expiresAt <= timestamp) {
      continue;
    }

    const [existing] = await db
      .select({
        role: organizationMemberships.role,
        status: organizationMemberships.status,
      })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, invite.organizationId),
          eq(organizationMemberships.userId, userId),
        ),
      )
      .limit(1);

    if (!existing) {
      await db.insert(organizationMemberships).values({
        organizationId: invite.organizationId,
        userId,
        role: invite.role,
        status: "active",
        joinedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    } else if (existing.status !== "active") {
      // Reactivate an inactive membership
      await db
        .update(organizationMemberships)
        .set({
          role: invite.role,
          status: "active",
          joinedAt: timestamp,
          updatedAt: timestamp,
        })
        .where(
          and(
            eq(organizationMemberships.organizationId, invite.organizationId),
            eq(organizationMemberships.userId, userId),
          ),
        );
    }

    await db
      .update(organizationInvites)
      .set({ acceptedAt: timestamp, updatedAt: timestamp })
      .where(eq(organizationInvites.id, invite.id));
  }
}
