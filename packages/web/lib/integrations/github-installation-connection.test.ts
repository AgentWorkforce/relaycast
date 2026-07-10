import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setDbForTesting } from "@/lib/db";

let pg: PGlite | null = null;

const USER_ID = "00000000-0000-0000-0000-000000000001";
const ORG_ID = "10000000-0000-0000-0000-000000000001";
const WORKSPACE_ID = "20000000-0000-0000-0000-000000000001";

const migrationSql = readFileSync(
  new URL("../../drizzle/0086_github_installation_org_ownership.sql", import.meta.url),
  "utf8",
);

async function exec(sql: string): Promise<void> {
  await pg!.exec(sql);
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function setupPrePhase1Schema(): Promise<void> {
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

    CREATE TABLE organizations (
      id uuid PRIMARY KEY,
      slug text NOT NULL,
      name text NOT NULL,
      created_by_user_id uuid NOT NULL,
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      updated_at timestamp with time zone NOT NULL DEFAULT now()
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

    CREATE TABLE workspace_integrations (
      id uuid PRIMARY KEY,
      workspace_id text NOT NULL,
      provider text NOT NULL,
      adapter text NOT NULL DEFAULT 'nango',
      name text,
      display_name text,
      created_by_user_id uuid,
      connection_id text NOT NULL,
      provider_config_key text,
      installation_id text,
      metadata_json text NOT NULL DEFAULT '{}',
      writeback_dispatch_via text NOT NULL DEFAULT 'bridge',
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      updated_at timestamp with time zone NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX workspace_integrations_provider_connection_unique
      ON workspace_integrations (provider, connection_id);

    CREATE TABLE github_installations (
      id uuid PRIMARY KEY,
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

    CREATE TABLE workspace_github_installation_links (
      id uuid PRIMARY KEY,
      workspace_id text NOT NULL,
      installation_id text NOT NULL REFERENCES github_installations(installation_id) ON DELETE CASCADE,
      linked_by_user_id uuid,
      workspace_integration_id uuid,
      connection_id text,
      provider_config_key text,
      metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      updated_at timestamp with time zone NOT NULL DEFAULT now()
    );
  `);
  await exec(migrationSql);
  await exec(`
    INSERT INTO users (id, primary_email, name)
      VALUES (${quote(USER_ID)}, 'user@example.com', 'Test User');
    INSERT INTO organizations (id, slug, name, created_by_user_id)
      VALUES (${quote(ORG_ID)}, 'acme', 'Acme', ${quote(USER_ID)});
  `);
}

async function insertWorkspace(
  workspaceId: string,
  organizationId = ORG_ID,
  relayWorkspaceId: string | null = null,
): Promise<void> {
  await exec(`
    INSERT INTO workspaces (id, organization_id, slug, name, relay_workspace_id)
      VALUES (
        ${quote(workspaceId)},
        ${quote(organizationId)},
        ${quote(`workspace-${workspaceId.slice(0, 8)}`)},
        ${quote(`Workspace ${workspaceId.slice(0, 8)}`)},
        ${relayWorkspaceId ? quote(relayWorkspaceId) : "NULL"}
      );
  `);
}

async function insertInstallation(input: {
  installationId: string;
  connectionId: string | null;
  providerConfigKey?: string | null;
  accountLogin?: string | null;
  accountType?: "Organization" | "User" | "unknown";
  repositorySelection?: "all" | "selected" | "unknown";
  suspended?: boolean;
}): Promise<void> {
  await exec(`
    INSERT INTO github_installations (
      id,
      installation_id,
      account_type,
      account_login,
      repository_selection,
      suspended,
      provider_config_key,
      connection_id
    )
    VALUES (
      ${quote(`30000000-0000-0000-0000-${input.installationId.padStart(12, "0").slice(-12)}`)},
      ${quote(input.installationId)},
      ${quote(input.accountType ?? "Organization")},
      ${input.accountLogin === null ? "NULL" : quote(input.accountLogin ?? "acme")},
      ${quote(input.repositorySelection ?? "selected")},
      ${input.suspended ? "true" : "false"},
      ${input.providerConfigKey === null ? "NULL" : quote(input.providerConfigKey ?? "github-relay")},
      ${input.connectionId === null ? "NULL" : quote(input.connectionId)}
    );
  `);
}

async function linkOrgInstallation(
  organizationId: string,
  installationId: string,
  isPrimary = true,
): Promise<void> {
  await exec(`
    INSERT INTO organization_github_installations (
      id,
      organization_id,
      installation_id,
      is_primary,
      linked_by_user_id
    )
    VALUES (
      gen_random_uuid(),
      ${quote(organizationId)},
      ${quote(installationId)},
      ${isPrimary ? "true" : "false"},
      ${quote(USER_ID)}
    );
  `);
}

async function linkWorkspaceInstallation(
  workspaceId: string,
  installationId: string,
): Promise<void> {
  await exec(`
    INSERT INTO workspace_github_installation_links (
      id,
      workspace_id,
      installation_id,
      linked_by_user_id
    )
    VALUES (gen_random_uuid(), ${quote(workspaceId)}, ${quote(installationId)}, ${quote(USER_ID)});
  `);
}

async function insertWorkspaceIntegration(input: {
  id?: string;
  workspaceId: string;
  provider: string;
  connectionId: string | null;
  installationId?: string | null;
  providerConfigKey?: string | null;
}): Promise<void> {
  await exec(`
    INSERT INTO workspace_integrations (
      id,
      workspace_id,
      provider,
      connection_id,
      provider_config_key,
      installation_id
    )
    VALUES (
      ${quote(input.id ?? crypto.randomUUID())},
      ${quote(input.workspaceId)},
      ${quote(input.provider)},
      ${input.connectionId === null ? "NULL" : quote(input.connectionId)},
      ${input.providerConfigKey === null ? "NULL" : quote(input.providerConfigKey ?? "github-relay")},
      ${input.installationId === null ? "NULL" : input.installationId ? quote(input.installationId) : "NULL"}
    );
  `);
}

describe("github installation connection resolver", () => {
  beforeEach(async () => {
    pg = new PGlite();
    await setupPrePhase1Schema();
    setDbForTesting(drizzle(pg) as never);
  });

  afterEach(async () => {
    setDbForTesting(null);
    await pg?.close();
    pg = null;
  });

  it("resolves an organization's primary installation", async () => {
    await insertInstallation({ installationId: "101", connectionId: "conn-org" });
    await linkOrgInstallation(ORG_ID, "101");

    const { resolveGithubConnectionForOrganization } = await import(
      "./github-installation-connection"
    );

    await expect(resolveGithubConnectionForOrganization(ORG_ID)).resolves.toMatchObject({
      installationId: "101",
      connectionId: "conn-org",
      providerConfigKey: "github-relay",
      source: "org-installation",
    });
  });

  it("resolves a workspace through its organization primary installation", async () => {
    await insertWorkspace(WORKSPACE_ID);
    await insertInstallation({ installationId: "102", connectionId: "conn-workspace-org" });
    await linkOrgInstallation(ORG_ID, "102");

    const { resolveGithubConnectionForWorkspace } = await import(
      "./github-installation-connection"
    );

    await expect(resolveGithubConnectionForWorkspace(WORKSPACE_ID)).resolves.toMatchObject({
      installationId: "102",
      connectionId: "conn-workspace-org",
      source: "org-installation",
    });
  });

  it("resolves sibling workspaces under one org to the same connection id", async () => {
    const workspaceIds = [
      WORKSPACE_ID,
      "20000000-0000-0000-0000-000000000002",
      "20000000-0000-0000-0000-000000000003",
    ];
    for (const workspaceId of workspaceIds) {
      await insertWorkspace(workspaceId);
    }
    await insertInstallation({ installationId: "103", connectionId: "conn-shared" });
    await linkOrgInstallation(ORG_ID, "103");

    const { resolveGithubConnectionForWorkspace } = await import(
      "./github-installation-connection"
    );
    const results = await Promise.all(
      workspaceIds.map((workspaceId) => resolveGithubConnectionForWorkspace(workspaceId)),
    );

    expect(results.map((result) => result?.connectionId)).toEqual([
      "conn-shared",
      "conn-shared",
      "conn-shared",
    ]);
    expect(new Set(results.map((result) => result?.connectionId))).toHaveLength(1);
    expect(results.every((result) => result?.source === "org-installation")).toBe(true);
  });

  it("falls back to a workspace installation link for productized relay ids without an org row", async () => {
    await insertInstallation({ installationId: "104", connectionId: "conn-link" });
    await linkWorkspaceInstallation("rw_productized", "104");

    const { resolveGithubConnectionForWorkspace } = await import(
      "./github-installation-connection"
    );

    await expect(resolveGithubConnectionForWorkspace("rw_productized")).resolves.toMatchObject({
      installationId: "104",
      connectionId: "conn-link",
      source: "workspace-link",
    });
  });

  it("uses legacy workspace_integrations only after org and link misses", async () => {
    await insertWorkspace(WORKSPACE_ID);
    await insertInstallation({ installationId: "105", connectionId: "conn-indexed" });
    await insertWorkspaceIntegration({
      workspaceId: WORKSPACE_ID,
      provider: "github",
      connectionId: "conn-legacy",
      installationId: "105",
      providerConfigKey: "github-custom",
    });

    const { resolveGithubConnectionForWorkspace } = await import(
      "./github-installation-connection"
    );

    await expect(resolveGithubConnectionForWorkspace(WORKSPACE_ID)).resolves.toMatchObject({
      installationId: "105",
      connectionId: "conn-indexed",
      providerConfigKey: "github-relay",
      source: "legacy-workspace-integration",
    });
  });

  it("returns null when no github connection source exists", async () => {
    await insertWorkspace(WORKSPACE_ID);
    const { resolveGithubConnectionForWorkspace } = await import(
      "./github-installation-connection"
    );

    await expect(resolveGithubConnectionForWorkspace(WORKSPACE_ID)).resolves.toBeNull();
  });

  it("returns suspended installations without gating them", async () => {
    await insertWorkspace(WORKSPACE_ID);
    await insertInstallation({
      installationId: "106",
      connectionId: "conn-suspended",
      suspended: true,
    });
    await linkOrgInstallation(ORG_ID, "106");

    const { resolveGithubConnectionForWorkspace } = await import(
      "./github-installation-connection"
    );

    await expect(resolveGithubConnectionForWorkspace(WORKSPACE_ID)).resolves.toMatchObject({
      suspended: true,
    });
  });

  it("prefers the primary installation when an org has multiple installations", async () => {
    await insertWorkspace(WORKSPACE_ID);
    await insertInstallation({ installationId: "106", connectionId: "conn-secondary" });
    await insertInstallation({ installationId: "107", connectionId: "conn-primary" });
    await linkOrgInstallation(ORG_ID, "106", false);
    await linkOrgInstallation(ORG_ID, "107", true);

    const { resolveGithubConnectionForWorkspace } = await import(
      "./github-installation-connection"
    );

    await expect(resolveGithubConnectionForWorkspace(WORKSPACE_ID)).resolves.toMatchObject({
      installationId: "107",
      connectionId: "conn-primary",
    });
  });

  it("resolves personal-account installations", async () => {
    await insertWorkspace(WORKSPACE_ID);
    await insertInstallation({
      installationId: "108",
      connectionId: "conn-user",
      accountLogin: "octocat",
      accountType: "User",
      repositorySelection: "all",
    });
    await linkOrgInstallation(ORG_ID, "108");

    const { resolveGithubConnectionForWorkspace } = await import(
      "./github-installation-connection"
    );

    await expect(resolveGithubConnectionForWorkspace(WORKSPACE_ID)).resolves.toMatchObject({
      accountLogin: "octocat",
      accountType: "User",
      repositorySelection: "all",
    });
  });
});

describe("github installation ownership migration constraints", () => {
  beforeEach(async () => {
    pg = new PGlite();
    await setupPrePhase1Schema();
    setDbForTesting(drizzle(pg) as never);
  });

  afterEach(async () => {
    setDbForTesting(null);
    await pg?.close();
    pg = null;
  });

  it("allows github reference rows with null connection ids", async () => {
    await expect(
      insertWorkspaceIntegration({
        workspaceId: "workspace-a",
        provider: "github",
        connectionId: null,
      }),
    ).resolves.toBeUndefined();
    await expect(
      insertWorkspaceIntegration({
        workspaceId: "workspace-b",
        provider: "github",
        connectionId: null,
      }),
    ).resolves.toBeUndefined();
  });

  it("keeps non-github connection ids unique", async () => {
    await insertWorkspaceIntegration({
      workspaceId: "workspace-c",
      provider: "slack",
      connectionId: "conn-shared",
      providerConfigKey: "slack-relay",
    });
    await expect(
      insertWorkspaceIntegration({
        workspaceId: "workspace-d",
        provider: "slack",
        connectionId: "conn-shared",
        providerConfigKey: "slack-relay",
      }),
    ).rejects.toThrow();
  });

  it("rejects non-github rows without a connection id", async () => {
    await expect(
      insertWorkspaceIntegration({
        workspaceId: "workspace-e",
        provider: "slack",
        connectionId: null,
        providerConfigKey: "slack-relay",
      }),
    ).rejects.toThrow();
  });

  it("rejects a second primary github installation for the same org", async () => {
    await insertInstallation({ installationId: "201", connectionId: "conn-one" });
    await insertInstallation({ installationId: "202", connectionId: "conn-two" });
    await linkOrgInstallation(ORG_ID, "201", true);

    await expect(linkOrgInstallation(ORG_ID, "202", true)).rejects.toThrow();
  });

  it("allows one open join request per org/user and permits non-pending history", async () => {
    await exec(`
      INSERT INTO organization_join_requests (
        id,
        organization_id,
        user_id,
        status
      )
      VALUES (
        gen_random_uuid(),
        ${quote(ORG_ID)},
        ${quote(USER_ID)},
        'pending'
      );
    `);

    await expect(exec(`
      INSERT INTO organization_join_requests (
        id,
        organization_id,
        user_id,
        status
      )
      VALUES (
        gen_random_uuid(),
        ${quote(ORG_ID)},
        ${quote(USER_ID)},
        'pending'
      );
    `)).rejects.toThrow();

    await expect(exec(`
      INSERT INTO organization_join_requests (
        id,
        organization_id,
        user_id,
        status
      )
      VALUES (
        gen_random_uuid(),
        ${quote(ORG_ID)},
        ${quote(USER_ID)},
        'approved'
      );
    `)).resolves.toBeUndefined();
  });

  it("enforces the github join policy values", async () => {
    await expect(exec(`
      UPDATE organizations
      SET github_join_policy = 'verified_domain'
      WHERE id = ${quote(ORG_ID)};
    `)).resolves.toBeUndefined();

    await expect(exec(`
      UPDATE organizations
      SET github_join_policy = 'surprise'
      WHERE id = ${quote(ORG_ID)};
    `)).rejects.toThrow();
  });
});
