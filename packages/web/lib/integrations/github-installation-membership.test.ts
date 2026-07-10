import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RequestAuth } from "@/lib/auth/request-auth";
import { setDbForTesting } from "@/lib/db";
import type { WorkspaceIntegrationIdentity } from "@/lib/workspaces/workspace-integration-identity";

const githubIdentityMocks = vi.hoisted(() => ({
  resolveGithubIdentityConnection: vi.fn(),
  fetchGithubIdentityOrgs: vi.fn(),
  findGithubInstallationsByAccountLogins: vi.fn(),
}));

vi.mock("@/lib/integrations/github-oauth-identity", () => ({
  resolveGithubIdentityConnection: githubIdentityMocks.resolveGithubIdentityConnection,
  fetchGithubIdentityOrgs: githubIdentityMocks.fetchGithubIdentityOrgs,
  findGithubInstallationsByAccountLogins: githubIdentityMocks.findGithubInstallationsByAccountLogins,
}));

import {
  listGithubJoinRequests,
  performGithubJoin,
  performGithubJoinApproval,
  performGithubLink,
} from "@/lib/integrations/github-installation-membership";

let pg: PGlite | null = null;

const USER_ID = "00000000-0000-0000-0000-000000000001";
const ADMIN_ID = "00000000-0000-0000-0000-000000000002";
const MEMBER_ID = "00000000-0000-0000-0000-000000000003";
const INSTALLER_ID = "00000000-0000-0000-0000-000000000004";
const ORG_ID = "10000000-0000-0000-0000-000000000001";
const LINK_ORG_ID = "10000000-0000-0000-0000-000000000002";
const WORKSPACE_ID = "20000000-0000-0000-0000-000000000001";
const LINK_WORKSPACE_ID = "20000000-0000-0000-0000-000000000002";
const INSTALLATION_ID = "300";
const PERSONAL_INSTALLATION_ID = "301";
const SUSPENDED_INSTALLATION_ID = "302";
const LINK_INSTALLATION_ID = "400";

type Match = {
  installationId: string;
  accountLogin: string;
  accountType: string;
  suspended: boolean;
};

async function exec(sql: string): Promise<void> {
  await pg!.exec(sql);
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function arrayLiteral(values: string[]): string {
  return `ARRAY[${values.map(quote).join(", ")}]::text[]`;
}

function auth(userId = USER_ID, workspaceId = WORKSPACE_ID, organizationId = ORG_ID): RequestAuth {
  return {
    userId,
    workspaceId,
    organizationId,
    source: "session",
  };
}

function identity(workspaceId = WORKSPACE_ID, organizationId: string | null = ORG_ID): WorkspaceIntegrationIdentity {
  return {
    requestedWorkspaceId: workspaceId,
    appWorkspaceId: workspaceId,
    relayWorkspaceId: workspaceId,
    organizationId,
    candidateWorkspaceIds: [workspaceId],
  };
}

function setOauth(matches: Match[] = [{
  installationId: INSTALLATION_ID,
  accountLogin: "acme",
  accountType: "Organization",
  suspended: false,
}]): void {
  githubIdentityMocks.resolveGithubIdentityConnection.mockResolvedValue({
    connectionId: "oauth-connection",
  });
  githubIdentityMocks.fetchGithubIdentityOrgs.mockResolvedValue({
    userLogin: "octocat",
    candidateLogins: ["octocat", "acme"],
    orgCount: 1,
  });
  githubIdentityMocks.findGithubInstallationsByAccountLogins.mockResolvedValue(matches);
}

async function setupSchema(): Promise<void> {
  await exec(`
    CREATE TABLE users (
      id uuid PRIMARY KEY,
      primary_email text,
      name text,
      avatar_url text,
      cloud_agent_spawn_quota_override integer,
      last_organization_id uuid,
      last_workspace_id uuid,
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      updated_at timestamp with time zone NOT NULL DEFAULT now()
    );

    CREATE TABLE auth_identities (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL,
      provider text NOT NULL,
      provider_user_id text NOT NULL,
      email text,
      email_verified boolean NOT NULL DEFAULT false,
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      updated_at timestamp with time zone NOT NULL DEFAULT now()
    );

    CREATE TABLE organizations (
      id uuid PRIMARY KEY,
      slug text NOT NULL,
      name text NOT NULL,
      created_by_user_id uuid NOT NULL,
      github_join_policy text NOT NULL DEFAULT 'request_approve',
      github_verified_domains text[] NOT NULL DEFAULT ARRAY[]::text[],
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      updated_at timestamp with time zone NOT NULL DEFAULT now()
    );

    CREATE TABLE organization_memberships (
      organization_id uuid NOT NULL,
      user_id uuid NOT NULL,
      role text NOT NULL,
      status text NOT NULL,
      joined_at timestamp with time zone NOT NULL DEFAULT now(),
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      updated_at timestamp with time zone NOT NULL DEFAULT now(),
      PRIMARY KEY (organization_id, user_id)
    );

    CREATE TABLE workspaces (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      slug text NOT NULL,
      name text NOT NULL,
      default_runtime jsonb,
      relay_workspace_id text,
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      updated_at timestamp with time zone NOT NULL DEFAULT now()
    );

    CREATE TABLE github_installations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      installation_id text NOT NULL UNIQUE,
      account_type text NOT NULL DEFAULT 'unknown',
      account_login text,
      account_id text,
      repository_selection text NOT NULL DEFAULT 'unknown',
      permissions_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      events text[] NOT NULL DEFAULT ARRAY[]::text[],
      suspended boolean NOT NULL DEFAULT false,
      suspended_at timestamp with time zone,
      suspended_by text,
      installed_by_user_id uuid,
      provider_config_key text,
      connection_id text,
      metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      updated_at timestamp with time zone NOT NULL DEFAULT now()
    );

    CREATE TABLE organization_github_installations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      installation_id text NOT NULL,
      is_primary boolean NOT NULL DEFAULT true,
      linked_by_user_id uuid,
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      updated_at timestamp with time zone NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX organization_github_installations_org_installation_unique
      ON organization_github_installations (organization_id, installation_id);
    CREATE UNIQUE INDEX organization_github_installations_org_primary_unique
      ON organization_github_installations (organization_id)
      WHERE is_primary;

    CREATE TABLE organization_join_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      user_id uuid NOT NULL,
      source text NOT NULL DEFAULT 'github_org',
      github_account_login text,
      status text NOT NULL DEFAULT 'pending',
      decided_by_user_id uuid,
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      updated_at timestamp with time zone NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX organization_join_requests_open_unique
      ON organization_join_requests (organization_id, user_id)
      WHERE status = 'pending';
  `);
}

async function seedBase(input: {
  policy?: "off" | "request_approve" | "verified_domain" | "sso";
  verifiedDomains?: string[];
  userEmail?: string;
  userEmailVerified?: boolean;
} = {}): Promise<void> {
  const policy = input.policy ?? "request_approve";
  const domains = input.verifiedDomains ?? [];
  await exec(`
    INSERT INTO users (id, primary_email, name)
      VALUES
        (${quote(USER_ID)}, 'user@acme.com', 'User'),
        (${quote(ADMIN_ID)}, 'admin@acme.com', 'Admin'),
        (${quote(MEMBER_ID)}, 'member@acme.com', 'Member'),
        (${quote(INSTALLER_ID)}, 'installer@acme.com', 'Installer');

    INSERT INTO auth_identities (
      id,
      user_id,
      provider,
      provider_user_id,
      email,
      email_verified
    )
      VALUES (
        '40000000-0000-0000-0000-000000000001',
        ${quote(USER_ID)},
        'google',
        'google-user',
        ${quote(input.userEmail ?? 'user@acme.com')},
        ${input.userEmailVerified ?? true}
      );

    INSERT INTO organizations (
      id,
      slug,
      name,
      created_by_user_id,
      github_join_policy,
      github_verified_domains
    )
      VALUES
        (${quote(ORG_ID)}, 'acme', 'Acme', ${quote(ADMIN_ID)}, ${quote(policy)}, ${arrayLiteral(domains)}),
        (${quote(LINK_ORG_ID)}, 'linkco', 'LinkCo', ${quote(ADMIN_ID)}, 'request_approve', ARRAY[]::text[]);

    INSERT INTO organization_memberships (organization_id, user_id, role, status)
      VALUES
        (${quote(ORG_ID)}, ${quote(ADMIN_ID)}, 'owner', 'active'),
        (${quote(LINK_ORG_ID)}, ${quote(ADMIN_ID)}, 'admin', 'active'),
        (${quote(LINK_ORG_ID)}, ${quote(MEMBER_ID)}, 'member', 'active');

    INSERT INTO workspaces (id, organization_id, slug, name)
      VALUES
        (${quote(WORKSPACE_ID)}, ${quote(ORG_ID)}, 'default', 'Default Workspace'),
        (${quote(LINK_WORKSPACE_ID)}, ${quote(LINK_ORG_ID)}, 'link', 'Link Workspace');

    INSERT INTO github_installations (
      installation_id,
      account_type,
      account_login,
      suspended,
      installed_by_user_id
    )
      VALUES
        (${quote(INSTALLATION_ID)}, 'Organization', 'acme', false, ${quote(ADMIN_ID)}),
        (${quote(PERSONAL_INSTALLATION_ID)}, 'User', 'octocat', false, ${quote(INSTALLER_ID)}),
        (${quote(SUSPENDED_INSTALLATION_ID)}, 'Organization', 'acme', true, ${quote(ADMIN_ID)}),
        (${quote(LINK_INSTALLATION_ID)}, 'Organization', 'linkco', false, ${quote(ADMIN_ID)});

    INSERT INTO organization_github_installations (
      organization_id,
      installation_id,
      is_primary,
      linked_by_user_id
    )
      VALUES
        (${quote(ORG_ID)}, ${quote(INSTALLATION_ID)}, true, ${quote(ADMIN_ID)}),
        (${quote(ORG_ID)}, ${quote(PERSONAL_INSTALLATION_ID)}, false, ${quote(INSTALLER_ID)}),
        (${quote(ORG_ID)}, ${quote(SUSPENDED_INSTALLATION_ID)}, false, ${quote(ADMIN_ID)});
  `);
}

async function countMemberships(userId = USER_ID, organizationId = ORG_ID): Promise<number> {
  const result = await pg!.query(
    `SELECT count(*)::int AS count FROM organization_memberships WHERE organization_id = $1 AND user_id = $2`,
    [organizationId, userId],
  ) as { rows: Array<{ count: number }> };
  return Number(result.rows[0]?.count ?? 0);
}

async function pendingRequestCount(userId = USER_ID, organizationId = ORG_ID): Promise<number> {
  const result = await pg!.query(
    `SELECT count(*)::int AS count FROM organization_join_requests WHERE organization_id = $1 AND user_id = $2 AND status = 'pending'`,
    [organizationId, userId],
  ) as { rows: Array<{ count: number }> };
  return Number(result.rows[0]?.count ?? 0);
}

async function latestJoinRequestId(): Promise<string> {
  const result = await pg!.query(
    `SELECT id FROM organization_join_requests ORDER BY created_at DESC LIMIT 1`,
  ) as { rows: Array<{ id: string }> };
  return String(result.rows[0]!.id);
}

describe("GitHub installation membership policy", () => {
  beforeEach(async () => {
    pg = new PGlite();
    setDbForTesting(drizzle(pg) as never);
    await setupSchema();
    vi.clearAllMocks();
    setOauth();
  });

  afterEach(async () => {
    setDbForTesting(null);
    await pg?.close();
    pg = null;
  });

  it("request_approve creates a pending request without a membership or landing workspace", async () => {
    await seedBase({ policy: "request_approve" });

    const result = await performGithubJoin({
      auth: auth(),
      identity: identity(),
      installationId: INSTALLATION_ID,
    });

    expect(result).toMatchObject({
      ok: true,
      outcome: "pending_approval",
      joinRequest: { status: "pending" },
    });
    expect(result).not.toHaveProperty("landingWorkspace");
    expect(await countMemberships()).toBe(0);
    expect(await pendingRequestCount()).toBe(1);
  });

  it("listGithubJoinRequests returns pending requests to an org admin", async () => {
    await seedBase({ policy: "request_approve" });
    await performGithubJoin({ auth: auth(), identity: identity(), installationId: INSTALLATION_ID });

    const result = await listGithubJoinRequests({
      auth: auth(ADMIN_ID),
      identity: identity(WORKSPACE_ID, ORG_ID),
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("expected ok");
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({ githubAccountLogin: "acme" });
    expect(result.requests[0]!.user.id).toBe(USER_ID);
  });

  it("listGithubJoinRequests requires a user identity", async () => {
    await seedBase({ policy: "request_approve" });

    const result = await listGithubJoinRequests({
      auth: auth(""), // no resolved user identity (e.g. service/token caller)
      identity: identity(WORKSPACE_ID, ORG_ID),
    });

    expect(result).toMatchObject({ ok: false, status: 403, code: "user_identity_required" });
  });

  it("listGithubJoinRequests forbids a non-admin", async () => {
    await seedBase({ policy: "request_approve" });
    await performGithubJoin({ auth: auth(), identity: identity(), installationId: INSTALLATION_ID });

    const result = await listGithubJoinRequests({
      auth: auth(), // USER_ID — not an org owner/admin
      identity: identity(WORKSPACE_ID, ORG_ID),
    });

    expect(result).toMatchObject({ ok: false, status: 403, code: "forbidden" });
  });

  it("rejects duplicate pending join requests without creating a membership", async () => {
    await seedBase({ policy: "request_approve" });
    await performGithubJoin({
      auth: auth(),
      identity: identity(),
      installationId: INSTALLATION_ID,
    });

    const result = await performGithubJoin({
      auth: auth(),
      identity: identity(),
      installationId: INSTALLATION_ID,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      code: "join_request_pending",
      joinRequest: { status: "pending" },
    });
    expect(await countMemberships()).toBe(0);
    expect(await pendingRequestCount()).toBe(1);
  });

  it("policy off refuses GitHub-derived joins without a membership", async () => {
    await seedBase({ policy: "off" });

    const result = await performGithubJoin({
      auth: auth(),
      identity: identity(),
      installationId: INSTALLATION_ID,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      code: "github_join_policy_off",
    });
    expect(await countMemberships()).toBe(0);
  });

  it("first admin connecting an unowned installation establishes org ownership inline", async () => {
    await seedBase({ policy: "request_approve" });
    // No cloud org has claimed this installation yet.
    await exec(`DELETE FROM organization_github_installations WHERE installation_id = ${quote(INSTALLATION_ID)};`);

    const result = await performGithubJoin({
      auth: auth(ADMIN_ID),
      identity: identity(WORKSPACE_ID, ORG_ID),
      installationId: INSTALLATION_ID,
    });

    expect(result).toMatchObject({ ok: true });
    const owned = (await pg!.query(
      `SELECT count(*)::int AS count FROM organization_github_installations WHERE organization_id = $1 AND installation_id = $2`,
      [ORG_ID, INSTALLATION_ID],
    )) as { rows: Array<{ count: number }> };
    expect(Number(owned.rows[0]?.count ?? 0)).toBe(1);
  });

  it("non-admin joining an unowned installation is guided to an admin and establishes nothing", async () => {
    await seedBase({ policy: "request_approve" });
    await exec(`DELETE FROM organization_github_installations WHERE installation_id = ${quote(INSTALLATION_ID)};`);

    const result = await performGithubJoin({
      auth: auth(USER_ID), // not a member/admin of ORG_ID
      identity: identity(WORKSPACE_ID, ORG_ID),
      installationId: INSTALLATION_ID,
    });

    expect(result).toMatchObject({ ok: false, status: 409, code: "installation_unowned" });
    const owned = (await pg!.query(
      `SELECT count(*)::int AS count FROM organization_github_installations WHERE installation_id = $1`,
      [INSTALLATION_ID],
    )) as { rows: Array<{ count: number }> };
    expect(Number(owned.rows[0]?.count ?? 0)).toBe(0);
  });

  it("verified_domain joins only with a provider-verified exact domain and returns an active landing workspace", async () => {
    await seedBase({ policy: "verified_domain", verifiedDomains: ["acme.com"] });

    const result = await performGithubJoin({
      auth: auth(),
      identity: identity(),
      installationId: INSTALLATION_ID,
    });

    expect(result).toMatchObject({
      ok: true,
      outcome: "joined",
      membership: { role: "member", status: "active" },
      landingWorkspace: {
        id: WORKSPACE_ID,
        slug: "default",
        name: "Default Workspace",
      },
    });
    expect(result).not.toHaveProperty("workspaceSelection");
    expect(await countMemberships()).toBe(1);
  });

  it("verified_domain rejects unverified email and near-miss domains without a membership", async () => {
    await seedBase({
      policy: "verified_domain",
      verifiedDomains: ["acme.com"],
      userEmailVerified: false,
    });

    const unverified = await performGithubJoin({
      auth: auth(),
      identity: identity(),
      installationId: INSTALLATION_ID,
    });
    expect(unverified).toMatchObject({
      ok: false,
      status: 409,
      code: "verified_domain_required",
    });
    expect(await countMemberships()).toBe(0);

    await exec("DELETE FROM auth_identities");
    await exec(`
      INSERT INTO auth_identities (
        id,
        user_id,
        provider,
        provider_user_id,
        email,
        email_verified
      )
        VALUES
          ('40000000-0000-0000-0000-000000000002', ${quote(USER_ID)}, 'google', 'evil-1', 'user@evil-acme.com', true),
          ('40000000-0000-0000-0000-000000000003', ${quote(USER_ID)}, 'google', 'evil-2', 'user@acme.com.evil.com', true);
    `);

    const nearMiss = await performGithubJoin({
      auth: auth(),
      identity: identity(),
      installationId: INSTALLATION_ID,
    });
    expect(nearMiss).toMatchObject({
      ok: false,
      status: 409,
      code: "verified_domain_required",
    });
    expect(await countMemberships()).toBe(0);
  });

  it("sso policy defers without writing a membership", async () => {
    await seedBase({ policy: "sso" });

    const result = await performGithubJoin({
      auth: auth(),
      identity: identity(),
      installationId: INSTALLATION_ID,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      code: "sso_required",
    });
    expect(await countMemberships()).toBe(0);
  });

  it("requires a non-bypassable OAuth installation match before join success", async () => {
    await seedBase({ policy: "verified_domain", verifiedDomains: ["acme.com"] });
    githubIdentityMocks.resolveGithubIdentityConnection.mockResolvedValue(null);

    const missingOauth = await performGithubJoin({
      auth: auth(),
      identity: identity(),
      installationId: INSTALLATION_ID,
    });
    expect(missingOauth).toMatchObject({
      ok: false,
      status: 409,
      code: "oauth_required",
    });

    setOauth([]);
    const notMatched = await performGithubJoin({
      auth: auth(),
      identity: identity(),
      installationId: INSTALLATION_ID,
    });
    expect(notMatched).toMatchObject({
      ok: false,
      status: 409,
      code: "installation_not_matched",
    });
    expect(await countMemberships()).toBe(0);
  });

  it("refuses personal and suspended installations for join", async () => {
    await seedBase({ policy: "verified_domain", verifiedDomains: ["acme.com"] });

    setOauth([{
      installationId: PERSONAL_INSTALLATION_ID,
      accountLogin: "octocat",
      accountType: "User",
      suspended: false,
    }]);
    const personal = await performGithubJoin({
      auth: auth(),
      identity: identity(),
      installationId: PERSONAL_INSTALLATION_ID,
    });
    expect(personal).toMatchObject({
      ok: false,
      status: 409,
      code: "personal_install_join_unavailable",
    });

    setOauth([{
      installationId: SUSPENDED_INSTALLATION_ID,
      accountLogin: "acme",
      accountType: "Organization",
      suspended: true,
    }]);
    const suspended = await performGithubJoin({
      auth: auth(),
      identity: identity(),
      installationId: SUSPENDED_INSTALLATION_ID,
    });
    expect(suspended).toMatchObject({
      ok: false,
      status: 409,
      code: "installation_suspended",
    });
    expect(await countMemberships()).toBe(0);
  });

  it("link is owner/admin-only and still requires the caller OAuth match", async () => {
    await seedBase();
    setOauth([{
      installationId: LINK_INSTALLATION_ID,
      accountLogin: "linkco",
      accountType: "Organization",
      suspended: false,
    }]);

    const member = await performGithubLink({
      auth: auth(MEMBER_ID, LINK_WORKSPACE_ID, LINK_ORG_ID),
      identity: identity(LINK_WORKSPACE_ID, LINK_ORG_ID),
      installationId: LINK_INSTALLATION_ID,
    });
    expect(member).toMatchObject({
      ok: false,
      status: 403,
      code: "forbidden",
    });

    githubIdentityMocks.resolveGithubIdentityConnection.mockResolvedValue(null);
    const missingOauth = await performGithubLink({
      auth: auth(ADMIN_ID, LINK_WORKSPACE_ID, LINK_ORG_ID),
      identity: identity(LINK_WORKSPACE_ID, LINK_ORG_ID),
      installationId: LINK_INSTALLATION_ID,
    });
    expect(missingOauth).toMatchObject({
      ok: false,
      status: 409,
      code: "oauth_required",
    });

    setOauth([{
      installationId: LINK_INSTALLATION_ID,
      accountLogin: "linkco",
      accountType: "Organization",
      suspended: false,
    }]);
    const admin = await performGithubLink({
      auth: auth(ADMIN_ID, LINK_WORKSPACE_ID, LINK_ORG_ID),
      identity: identity(LINK_WORKSPACE_ID, LINK_ORG_ID),
      installationId: LINK_INSTALLATION_ID,
    });
    expect(admin).toMatchObject({
      ok: true,
      outcome: "linked",
      organizationInstallation: {
        installationId: LINK_INSTALLATION_ID,
        isPrimary: true,
      },
    });
  });

  it("approving a join request requires owner/admin authority", async () => {
    await seedBase({ policy: "request_approve" });
    await performGithubJoin({
      auth: auth(),
      identity: identity(),
      installationId: INSTALLATION_ID,
    });
    const requestId = await latestJoinRequestId();

    const member = await performGithubJoinApproval({
      auth: auth(MEMBER_ID, LINK_WORKSPACE_ID, ORG_ID),
      identity: identity(WORKSPACE_ID, ORG_ID),
      requestId,
      decision: "approve",
    });
    expect(member).toMatchObject({
      ok: false,
      status: 403,
      code: "forbidden",
    });
    expect(await countMemberships()).toBe(0);

    const admin = await performGithubJoinApproval({
      auth: auth(ADMIN_ID, WORKSPACE_ID, ORG_ID),
      identity: identity(WORKSPACE_ID, ORG_ID),
      requestId,
      decision: "approve",
    });
    expect(admin).toMatchObject({
      ok: true,
      outcome: "approved",
      membership: { role: "member", status: "active" },
    });
    expect(await countMemberships()).toBe(1);
  });
});
