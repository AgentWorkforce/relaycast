import { and, asc, eq } from "drizzle-orm";

import type { RequestAuth } from "@/lib/auth/request-auth";
import { getDb } from "@/lib/db";
import {
  authIdentities,
  githubInstallations,
  organizationGithubInstallations,
  organizationJoinRequests,
  organizationMemberships,
  organizations,
  users,
  workspaces,
} from "@/lib/db/schema";
import {
  fetchGithubIdentityOrgs,
  findGithubInstallationsByAccountLogins,
  resolveGithubIdentityConnection,
  type GithubInstallationMatch,
} from "@/lib/integrations/github-oauth-identity";
import type { WorkspaceIntegrationIdentity } from "@/lib/workspaces/workspace-integration-identity-core";

export type GithubJoinLinkErrorCode =
  | "forbidden"
  | "github_join_policy_off"
  | "installation_not_found"
  | "installation_not_matched"
  | "installation_suspended"
  | "installation_unowned"
  | "invalid_request"
  | "join_request_pending"
  | "oauth_required"
  | "ownership_unresolved"
  | "personal_install_join_unavailable"
  | "personal_install_link_unavailable"
  | "sso_required"
  | "user_identity_required"
  | "verified_domain_required"
  | "workspace_organization_required";

export type GithubOrganizationSummary = {
  id: string;
  slug: string;
  name: string;
};

export type GithubInstallationSummary = {
  installationId: string;
  accountLogin: string;
  accountType: string;
  suspended: boolean;
};

export type GithubLandingWorkspace = {
  id: string;
  slug: string;
  name: string;
};

export type GithubWorkspaceSelection = {
  ambiguous: true;
  candidateWorkspaceIds: string[];
};

export type GithubJoinLinkFailure = {
  ok: false;
  status: 400 | 403 | 404 | 409 | 502;
  code: GithubJoinLinkErrorCode;
  error: string;
  joinRequest?: GithubJoinRequestSummary;
};

export type GithubJoinRequestSummary = {
  id: string;
  status: "pending" | "approved" | "denied" | "auto";
  createdAt: string;
};

export type GithubJoinSuccess =
  | {
      ok: true;
      action: "join";
      outcome: "pending_approval";
      organization: GithubOrganizationSummary;
      installation: GithubInstallationSummary;
      joinRequest: GithubJoinRequestSummary;
    }
  | {
      ok: true;
      action: "join";
      outcome: "joined" | "already_member";
      organization: GithubOrganizationSummary;
      installation: GithubInstallationSummary;
      membership: { role: "member"; status: "active" } | { role: string; status: "active" };
      landingWorkspace: GithubLandingWorkspace | null;
      workspaceSelection?: GithubWorkspaceSelection;
    };

export type GithubLinkSuccess = {
  ok: true;
  action: "link";
  outcome: "linked" | "already_linked";
  organization: GithubOrganizationSummary;
  installation: GithubInstallationSummary;
  organizationInstallation: {
    installationId: string;
    isPrimary: boolean;
  };
};

export type GithubJoinResult = GithubJoinSuccess | GithubJoinLinkFailure;
export type GithubLinkResult = GithubLinkSuccess | GithubJoinLinkFailure;

export type GithubJoinApprovalResult =
  | {
      ok: true;
      action: "approve";
      outcome: "approved" | "denied" | "already_resolved";
      organization: GithubOrganizationSummary;
      joinRequest: GithubJoinRequestSummary;
      membership?: { role: "member"; status: "active" };
    }
  | GithubJoinLinkFailure;

type InstallOwnerRow = {
  organizationId: string;
  organizationSlug: string;
  organizationName: string;
  githubJoinPolicy: string;
  githubVerifiedDomains: string[];
  installationId: string;
  accountLogin: string | null;
  accountType: string;
  suspended: boolean;
};

type InstallationRow = {
  installationId: string;
  accountLogin: string | null;
  accountType: string;
  suspended: boolean;
  installedByUserId: string | null;
};

type MembershipRow = {
  role: string;
  status: string;
};

type PendingJoinRequestRow = {
  id: string;
  organizationId: string;
  userId: string;
  status: string;
  createdAt: Date;
};

type WorkspaceRow = {
  id: string;
  slug: string;
  name: string;
};

function failure(
  status: GithubJoinLinkFailure["status"],
  code: GithubJoinLinkErrorCode,
  error: string,
): GithubJoinLinkFailure {
  return { ok: false, status, code, error };
}

function organizationSummary(row: InstallOwnerRow | {
  organizationId: string;
  organizationSlug: string;
  organizationName: string;
}): GithubOrganizationSummary {
  return {
    id: row.organizationId,
    slug: row.organizationSlug,
    name: row.organizationName,
  };
}

function installationSummary(row: Pick<InstallationRow, "installationId" | "accountLogin" | "accountType" | "suspended">): GithubInstallationSummary {
  return {
    installationId: row.installationId,
    accountLogin: row.accountLogin ?? "",
    accountType: row.accountType,
    suspended: row.suspended,
  };
}

function isOrgAuthority(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

function normalizeDomain(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.includes("@")) return null;
  return normalized.replace(/^\.+|\.+$/g, "");
}

function emailDomain(value: string | null | undefined): string | null {
  const email = value?.trim().toLowerCase();
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1).replace(/^\.+|\.+$/g, "");
}

function exactDomainMatch(email: string | null | undefined, domains: readonly string[]): boolean {
  const domain = emailDomain(email);
  if (!domain) return false;
  return domains.some((candidate) => normalizeDomain(candidate) === domain);
}

async function resolveMatchedInstallation(input: {
  userId: string | null | undefined;
  installationId: string;
  oauthConnectionId?: string | null;
}): Promise<
  | { ok: true; match: GithubInstallationMatch }
  | { ok: false; failure: GithubJoinLinkFailure }
> {
  if (!input.userId) {
    return {
      ok: false,
      failure: failure(
        403,
        "user_identity_required",
        "A user identity is required for GitHub installation actions.",
      ),
    };
  }

  const identity = await resolveGithubIdentityConnection(
    input.userId,
    input.oauthConnectionId,
  );
  if (!identity) {
    return {
      ok: false,
      failure: failure(
        409,
        "oauth_required",
        "GitHub user authorization is required before continuing.",
      ),
    };
  }

  let orgs;
  try {
    orgs = await fetchGithubIdentityOrgs(identity.connectionId);
  } catch {
    return {
      ok: false,
      failure: failure(
        502,
        "oauth_required",
        "Failed to validate the GitHub user authorization.",
      ),
    };
  }

  const matches = await findGithubInstallationsByAccountLogins(orgs.candidateLogins);
  const match = matches.find(
    (candidate) => candidate.installationId === input.installationId,
  );
  if (!match) {
    return {
      ok: false,
      failure: failure(
        409,
        "installation_not_matched",
        "The selected GitHub installation does not match the authorized GitHub user.",
      ),
    };
  }

  return { ok: true, match };
}

async function readInstallationOwner(
  installationId: string,
): Promise<InstallOwnerRow | null> {
  const [row] = await getDb()
    .select({
      organizationId: organizationGithubInstallations.organizationId,
      organizationSlug: organizations.slug,
      organizationName: organizations.name,
      githubJoinPolicy: organizations.githubJoinPolicy,
      githubVerifiedDomains: organizations.githubVerifiedDomains,
      installationId: githubInstallations.installationId,
      accountLogin: githubInstallations.accountLogin,
      accountType: githubInstallations.accountType,
      suspended: githubInstallations.suspended,
    })
    .from(organizationGithubInstallations)
    .innerJoin(
      organizations,
      eq(organizations.id, organizationGithubInstallations.organizationId),
    )
    .innerJoin(
      githubInstallations,
      eq(githubInstallations.installationId, organizationGithubInstallations.installationId),
    )
    .where(eq(organizationGithubInstallations.installationId, installationId))
    .orderBy(
      // Primary org ownership is expected to be unique per org; for the rare
      // case where one installation has been linked to several orgs, keep the
      // result deterministic.
      asc(organizations.createdAt),
    )
    .limit(1);

  return row ?? null;
}

async function readInstallation(
  installationId: string,
): Promise<InstallationRow | null> {
  const [row] = await getDb()
    .select({
      installationId: githubInstallations.installationId,
      accountLogin: githubInstallations.accountLogin,
      accountType: githubInstallations.accountType,
      suspended: githubInstallations.suspended,
      installedByUserId: githubInstallations.installedByUserId,
    })
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, installationId))
    .limit(1);
  return row ?? null;
}

async function readActiveMembership(
  organizationId: string,
  userId: string,
): Promise<MembershipRow | null> {
  const [row] = await getDb()
    .select({
      role: organizationMemberships.role,
      status: organizationMemberships.status,
    })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, organizationId),
        eq(organizationMemberships.userId, userId),
        eq(organizationMemberships.status, "active"),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function readPendingJoinRequest(
  organizationId: string,
  userId: string,
): Promise<PendingJoinRequestRow | null> {
  const [row] = await getDb()
    .select({
      id: organizationJoinRequests.id,
      organizationId: organizationJoinRequests.organizationId,
      userId: organizationJoinRequests.userId,
      status: organizationJoinRequests.status,
      createdAt: organizationJoinRequests.createdAt,
    })
    .from(organizationJoinRequests)
    .where(
      and(
        eq(organizationJoinRequests.organizationId, organizationId),
        eq(organizationJoinRequests.userId, userId),
        eq(organizationJoinRequests.status, "pending"),
      ),
    )
    .limit(1);
  return row ?? null;
}

function joinRequestSummary(row: PendingJoinRequestRow): GithubJoinRequestSummary {
  const status = row.status === "approved" || row.status === "denied" || row.status === "auto"
    ? row.status
    : "pending";
  return {
    id: row.id,
    status,
    createdAt: row.createdAt.toISOString(),
  };
}

async function createPendingJoinRequest(input: {
  organizationId: string;
  userId: string;
  accountLogin: string | null;
}): Promise<PendingJoinRequestRow> {
  const [row] = await getDb()
    .insert(organizationJoinRequests)
    .values({
      organizationId: input.organizationId,
      userId: input.userId,
      source: "github_org",
      githubAccountLogin: input.accountLogin,
      status: "pending",
      updatedAt: new Date(),
    })
    .returning({
      id: organizationJoinRequests.id,
      organizationId: organizationJoinRequests.organizationId,
      userId: organizationJoinRequests.userId,
      status: organizationJoinRequests.status,
      createdAt: organizationJoinRequests.createdAt,
    });

  return row!;
}

async function readVerifiedEmailForDomain(
  userId: string,
  domains: readonly string[],
): Promise<string | null> {
  const rows = await getDb()
    .select({ email: authIdentities.email })
    .from(authIdentities)
    .where(
      and(
        eq(authIdentities.userId, userId),
        eq(authIdentities.emailVerified, true),
      ),
    );

  return rows.find((row) => exactDomainMatch(row.email, domains))?.email ?? null;
}

async function ensureActiveMember(input: {
  organizationId: string;
  userId: string;
  role?: string;
}): Promise<MembershipRow> {
  const existing = await readActiveMembership(input.organizationId, input.userId);
  if (existing) return existing;

  const now = new Date();
  const role = input.role ?? "member";
  const [row] = await getDb()
    .insert(organizationMemberships)
    .values({
      organizationId: input.organizationId,
      userId: input.userId,
      role,
      status: "active",
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        organizationMemberships.organizationId,
        organizationMemberships.userId,
      ],
      set: {
        status: "active",
        role,
        joinedAt: now,
        updatedAt: now,
      },
    })
    .returning({
      role: organizationMemberships.role,
      status: organizationMemberships.status,
    });

  return row!;
}

async function listEntitledWorkspaces(
  organizationId: string,
  userId: string,
): Promise<WorkspaceRow[]> {
  const membership = await readActiveMembership(organizationId, userId);
  if (!membership) return [];

  return getDb()
    .select({
      id: workspaces.id,
      slug: workspaces.slug,
      name: workspaces.name,
    })
    .from(workspaces)
    .where(eq(workspaces.organizationId, organizationId))
    .orderBy(asc(workspaces.createdAt));
}

function resolveLandingWorkspace(input: {
  currentWorkspaceId: string | null;
  workspaces: WorkspaceRow[];
}): Pick<GithubJoinSuccess & { outcome: "joined" | "already_member" }, "landingWorkspace" | "workspaceSelection"> {
  if (input.workspaces.length === 0) {
    return {
      landingWorkspace: null,
      workspaceSelection: { ambiguous: true, candidateWorkspaceIds: [] },
    };
  }

  const current = input.currentWorkspaceId
    ? input.workspaces.find((workspace) => workspace.id === input.currentWorkspaceId)
    : null;
  const selected = current ?? input.workspaces[0]!;
  return {
    landingWorkspace: selected,
  };
}

async function activeJoinResponse(input: {
  outcome: "joined" | "already_member";
  owner: InstallOwnerRow;
  membership: MembershipRow;
  userId: string;
  currentWorkspaceId: string | null;
}): Promise<GithubJoinSuccess> {
  const entitledWorkspaces = await listEntitledWorkspaces(
    input.owner.organizationId,
    input.userId,
  );
  return {
    ok: true,
    action: "join",
    outcome: input.outcome,
    organization: organizationSummary(input.owner),
    installation: installationSummary(input.owner),
    membership: {
      role: input.membership.role,
      status: "active",
    },
    ...resolveLandingWorkspace({
      currentWorkspaceId: input.currentWorkspaceId,
      workspaces: entitledWorkspaces,
    }),
  };
}

export async function performGithubJoin(input: {
  auth: RequestAuth;
  identity: WorkspaceIntegrationIdentity;
  installationId: string;
  oauthConnectionId?: string | null;
}): Promise<GithubJoinResult> {
  const installationId = input.installationId.trim();
  if (!installationId) {
    return failure(400, "invalid_request", "installationId is required.");
  }

  const matched = await resolveMatchedInstallation({
    userId: input.auth.userId,
    installationId,
    oauthConnectionId: input.oauthConnectionId,
  });
  if (!matched.ok) return matched.failure;

  const installation = await readInstallation(installationId);
  if (!installation) {
    return failure(
      404,
      "installation_not_found",
      "The selected GitHub installation was not found.",
    );
  }

  if (installation.suspended) {
    return failure(
      409,
      "installation_suspended",
      "The selected GitHub installation is suspended.",
    );
  }

  if (installation.accountType === "User") {
    return failure(
      409,
      "personal_install_join_unavailable",
      "Personal GitHub installations cannot be joined as an organization.",
    );
  }

  let owner = await readInstallationOwner(installationId);
  if (!owner) {
    // First-admin bootstrap: no cloud org has claimed this installation yet.
    // If the connecting user is an owner/admin of their current workspace's org,
    // establish ownership inline via the canonical link path (writes the
    // organization_github_installations tier) so the org tier is populated and
    // members can subsequently join + resolve GitHub org-wide. A non-admin
    // cannot establish ownership, so guide them to an admin instead of failing
    // with the cryptic "no organization owns this installation".
    const link = await performGithubLink({
      auth: input.auth,
      identity: input.identity,
      installationId,
      oauthConnectionId: input.oauthConnectionId,
    });
    if (!link.ok) {
      return failure(
        409,
        "installation_unowned",
        "This GitHub organization isn't linked to a workspace yet. Ask an organization owner or admin to connect GitHub for the org first.",
      );
    }
    owner = await readInstallationOwner(installationId);
    if (!owner) {
      return failure(
        502,
        "ownership_unresolved",
        "GitHub installation ownership could not be established.",
      );
    }
  }

  const existingMembership = await readActiveMembership(
    owner.organizationId,
    input.auth.userId,
  );
  if (existingMembership) {
    return activeJoinResponse({
      outcome: "already_member",
      owner,
      membership: existingMembership,
      userId: input.auth.userId,
      currentWorkspaceId: input.identity.appWorkspaceId,
    });
  }

  switch (owner.githubJoinPolicy) {
    case "off":
      return failure(
        409,
        "github_join_policy_off",
        "This organization does not allow GitHub-derived join requests.",
      );
    case "request_approve": {
      const existing = await readPendingJoinRequest(
        owner.organizationId,
        input.auth.userId,
      );
      if (existing) {
        return {
          ...failure(
            409,
            "join_request_pending",
            "A join request is already pending for this organization.",
          ),
          joinRequest: joinRequestSummary(existing),
        };
      }
      const created = await createPendingJoinRequest({
        organizationId: owner.organizationId,
        userId: input.auth.userId,
        accountLogin: owner.accountLogin,
      });
      return {
        ok: true,
        action: "join",
        outcome: "pending_approval",
        organization: organizationSummary(owner),
        installation: installationSummary(owner),
        joinRequest: joinRequestSummary(created),
      };
    }
    case "verified_domain": {
      const verifiedEmail = await readVerifiedEmailForDomain(
        input.auth.userId,
        owner.githubVerifiedDomains,
      );
      if (!verifiedEmail) {
        return failure(
          409,
          "verified_domain_required",
          "A verified email domain is required to join this organization.",
        );
      }
      const membership = await ensureActiveMember({
        organizationId: owner.organizationId,
        userId: input.auth.userId,
      });
      return activeJoinResponse({
        outcome: "joined",
        owner,
        membership,
        userId: input.auth.userId,
        currentWorkspaceId: input.identity.appWorkspaceId,
      });
    }
    case "sso":
      return failure(
        409,
        "sso_required",
        "This organization requires SSO/SCIM provisioning.",
      );
    default:
      return failure(
        409,
        "github_join_policy_off",
        "This organization does not allow GitHub-derived joins.",
      );
  }
}

async function readOrganizationSummary(
  organizationId: string,
): Promise<GithubOrganizationSummary | null> {
  const [row] = await getDb()
    .select({
      id: organizations.id,
      slug: organizations.slug,
      name: organizations.name,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return row ?? null;
}

async function readOrgAuthority(
  organizationId: string,
  userId: string,
): Promise<boolean> {
  const membership = await readActiveMembership(organizationId, userId);
  return isOrgAuthority(membership?.role);
}

export type GithubJoinRequestListItem = {
  id: string;
  githubAccountLogin: string | null;
  createdAt: string;
  user: { id: string; email: string | null; name: string | null };
};

export type GithubJoinRequestListResult =
  | { ok: true; requests: GithubJoinRequestListItem[] }
  | GithubJoinLinkFailure;

// List an organization's pending GitHub-derived join requests for an org
// owner/admin to action. Org-scoped + authority-gated (same boundary as
// performGithubJoinApproval) — non-admins get a forbidden failure.
export async function listGithubJoinRequests(input: {
  auth: RequestAuth;
  identity: WorkspaceIntegrationIdentity;
}): Promise<GithubJoinRequestListResult> {
  if (!input.auth.userId) {
    return failure(
      403,
      "user_identity_required",
      "A user identity is required to view GitHub join requests.",
    );
  }

  if (!input.identity.organizationId) {
    return failure(
      409,
      "workspace_organization_required",
      "The current workspace is not attached to an organization.",
    );
  }

  const authorized = await readOrgAuthority(input.identity.organizationId, input.auth.userId);
  if (!authorized) {
    return failure(
      403,
      "forbidden",
      "Only organization owners and admins can view GitHub join requests.",
    );
  }

  const rows = await getDb()
    .select({
      id: organizationJoinRequests.id,
      githubAccountLogin: organizationJoinRequests.githubAccountLogin,
      createdAt: organizationJoinRequests.createdAt,
      userId: users.id,
      userEmail: users.primaryEmail,
      userName: users.name,
    })
    .from(organizationJoinRequests)
    .leftJoin(users, eq(users.id, organizationJoinRequests.userId))
    .where(
      and(
        eq(organizationJoinRequests.organizationId, input.identity.organizationId),
        eq(organizationJoinRequests.status, "pending"),
      ),
    )
    .orderBy(asc(organizationJoinRequests.createdAt));

  return {
    ok: true,
    requests: rows.map((row) => ({
      id: row.id,
      githubAccountLogin: row.githubAccountLogin,
      createdAt:
        row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
      user: { id: row.userId ?? "", email: row.userEmail ?? null, name: row.userName ?? null },
    })),
  };
}

export async function performGithubLink(input: {
  auth: RequestAuth;
  identity: WorkspaceIntegrationIdentity;
  installationId: string;
  oauthConnectionId?: string | null;
}): Promise<GithubLinkResult> {
  const installationId = input.installationId.trim();
  if (!installationId) {
    return failure(400, "invalid_request", "installationId is required.");
  }
  if (!input.identity.organizationId) {
    return failure(
      409,
      "workspace_organization_required",
      "The current workspace is not attached to an organization.",
    );
  }

  const matched = await resolveMatchedInstallation({
    userId: input.auth.userId,
    installationId,
    oauthConnectionId: input.oauthConnectionId,
  });
  if (!matched.ok) return matched.failure;

  const organization = await readOrganizationSummary(input.identity.organizationId);
  if (!organization) {
    return failure(
      409,
      "workspace_organization_required",
      "The current workspace organization could not be found.",
    );
  }

  const authorized = await readOrgAuthority(
    input.identity.organizationId,
    input.auth.userId,
  );
  if (!authorized) {
    return failure(
      403,
      "forbidden",
      "Only organization owners and admins can link GitHub installations.",
    );
  }

  const installation = await readInstallation(installationId);
  if (!installation) {
    return failure(
      404,
      "installation_not_found",
      "The selected GitHub installation was not found.",
    );
  }
  if (installation.suspended) {
    return failure(
      409,
      "installation_suspended",
      "The selected GitHub installation is suspended.",
    );
  }
  if (
    installation.accountType === "User" &&
    installation.installedByUserId !== input.auth.userId
  ) {
    return failure(
      409,
      "personal_install_link_unavailable",
      "Only the installing user can link a personal GitHub installation.",
    );
  }

  const db = getDb();
  const existingRows = await db
    .select({
      installationId: organizationGithubInstallations.installationId,
      isPrimary: organizationGithubInstallations.isPrimary,
    })
    .from(organizationGithubInstallations)
    .where(
      eq(organizationGithubInstallations.organizationId, input.identity.organizationId),
    )
    .orderBy(asc(organizationGithubInstallations.createdAt));
  const existing = existingRows.find((row) => row.installationId === installationId);
  if (existing) {
    return {
      ok: true,
      action: "link",
      outcome: "already_linked",
      organization,
      installation: installationSummary(installation),
      organizationInstallation: {
        installationId,
        isPrimary: existing.isPrimary,
      },
    };
  }

  const isPrimary = existingRows.length === 0;
  await db.insert(organizationGithubInstallations).values({
    organizationId: input.identity.organizationId,
    installationId,
    isPrimary,
    linkedByUserId: input.auth.userId,
    updatedAt: new Date(),
  });

  return {
    ok: true,
    action: "link",
    outcome: "linked",
    organization,
    installation: installationSummary(installation),
    organizationInstallation: {
      installationId,
      isPrimary,
    },
  };
}

async function readJoinRequestById(
  requestId: string,
): Promise<PendingJoinRequestRow | null> {
  const [row] = await getDb()
    .select({
      id: organizationJoinRequests.id,
      organizationId: organizationJoinRequests.organizationId,
      userId: organizationJoinRequests.userId,
      status: organizationJoinRequests.status,
      createdAt: organizationJoinRequests.createdAt,
    })
    .from(organizationJoinRequests)
    .where(eq(organizationJoinRequests.id, requestId))
    .limit(1);

  return row ?? null;
}

async function readOrganizationForApproval(
  organizationId: string,
): Promise<{
  organizationId: string;
  organizationSlug: string;
  organizationName: string;
} | null> {
  const [row] = await getDb()
    .select({
      organizationId: organizations.id,
      organizationSlug: organizations.slug,
      organizationName: organizations.name,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return row ?? null;
}

export async function performGithubJoinApproval(input: {
  auth: RequestAuth;
  identity: WorkspaceIntegrationIdentity;
  requestId: string;
  decision: "approve" | "deny";
}): Promise<GithubJoinApprovalResult> {
  const requestId = input.requestId.trim();
  if (!requestId) {
    return failure(400, "invalid_request", "requestId is required.");
  }
  if (!input.identity.organizationId) {
    return failure(
      409,
      "workspace_organization_required",
      "The current workspace is not attached to an organization.",
    );
  }

  const joinRequest = await readJoinRequestById(requestId);
  if (!joinRequest || joinRequest.organizationId !== input.identity.organizationId) {
    return failure(404, "installation_not_found", "Join request not found.");
  }

  const organization = await readOrganizationForApproval(joinRequest.organizationId);
  if (!organization) {
    return failure(
      409,
      "workspace_organization_required",
      "The join request organization could not be found.",
    );
  }

  const authorized = await readOrgAuthority(
    joinRequest.organizationId,
    input.auth.userId,
  );
  if (!authorized) {
    return failure(
      403,
      "forbidden",
      "Only organization owners and admins can approve GitHub join requests.",
    );
  }

  if (joinRequest.status !== "pending") {
    return {
      ok: true,
      action: "approve",
      outcome: "already_resolved",
      organization: organizationSummary(organization),
      joinRequest: joinRequestSummary(joinRequest),
    };
  }

  const status = input.decision === "approve" ? "approved" : "denied";
  const [updated] = await getDb()
    .update(organizationJoinRequests)
    .set({
      status,
      decidedByUserId: input.auth.userId,
      updatedAt: new Date(),
    })
    .where(eq(organizationJoinRequests.id, joinRequest.id))
    .returning({
      id: organizationJoinRequests.id,
      organizationId: organizationJoinRequests.organizationId,
      userId: organizationJoinRequests.userId,
      status: organizationJoinRequests.status,
      createdAt: organizationJoinRequests.createdAt,
    });

  if (input.decision === "deny") {
    return {
      ok: true,
      action: "approve",
      outcome: "denied",
      organization: organizationSummary(organization),
      joinRequest: joinRequestSummary(updated ?? joinRequest),
    };
  }

  await ensureActiveMember({
    organizationId: joinRequest.organizationId,
    userId: joinRequest.userId,
  });

  return {
    ok: true,
    action: "approve",
    outcome: "approved",
    organization: organizationSummary(organization),
    joinRequest: joinRequestSummary(updated ?? joinRequest),
    membership: { role: "member", status: "active" },
  };
}
