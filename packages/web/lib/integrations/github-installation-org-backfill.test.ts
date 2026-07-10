import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setDbForTesting } from "@/lib/db";

let pg: PGlite | null = null;

const USER_ID = "00000000-0000-0000-0000-000000000001";
const ORG_ID = "10000000-0000-0000-0000-000000000001";
const PERSONAL_ORG_ID = "10000000-0000-0000-0000-000000000002";
const WORKSPACE_ONE_ID = "20000000-0000-0000-0000-000000000001";
const WORKSPACE_TWO_ID = "20000000-0000-0000-0000-000000000002";
const PRODUCTIZED_APP_WORKSPACE_ID = "20000000-0000-0000-0000-000000000003";
const PERSONAL_WORKSPACE_ID = "20000000-0000-0000-0000-000000000004";
const PRODUCTIZED_RELAY_WORKSPACE_ID = "rw_productized";
const ORPHAN_RELAY_WORKSPACE_ID = "rw_orphan";

async function exec(sql: string): Promise<void> {
  await pg!.exec(sql);
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
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
      connection_id text,
      provider_config_key text,
      installation_id text,
      metadata_json text NOT NULL DEFAULT '{}',
      writeback_dispatch_via text NOT NULL DEFAULT 'bridge',
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      updated_at timestamp with time zone NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX workspace_integrations_provider_connection_unique
      ON workspace_integrations (provider, connection_id)
      WHERE provider <> 'github';

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

    CREATE TABLE workspace_github_installation_links (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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

    CREATE TABLE organization_github_installations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      installation_id text NOT NULL REFERENCES github_installations(installation_id) ON DELETE CASCADE,
      is_primary boolean NOT NULL DEFAULT true,
      linked_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      updated_at timestamp with time zone NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX organization_github_installations_org_installation_unique
      ON organization_github_installations (organization_id, installation_id);
    CREATE UNIQUE INDEX organization_github_installations_org_primary_unique
      ON organization_github_installations (organization_id)
      WHERE is_primary;
  `);
}

async function seedRepresentativeFixtures(): Promise<void> {
  await exec(`
    INSERT INTO users (id, primary_email, name)
      VALUES (${quote(USER_ID)}, 'user@example.com', 'Test User');

    INSERT INTO organizations (id, slug, name, created_by_user_id)
      VALUES
        (${quote(ORG_ID)}, 'acme', 'Acme', ${quote(USER_ID)}),
        (${quote(PERSONAL_ORG_ID)}, 'personal', 'Personal', ${quote(USER_ID)});

    INSERT INTO workspaces (id, organization_id, slug, name, relay_workspace_id)
      VALUES
        (${quote(WORKSPACE_ONE_ID)}, ${quote(ORG_ID)}, 'one', 'One', NULL),
        (${quote(WORKSPACE_TWO_ID)}, ${quote(ORG_ID)}, 'two', 'Two', NULL),
        (${quote(PRODUCTIZED_APP_WORKSPACE_ID)}, ${quote(ORG_ID)}, 'productized', 'Productized', ${quote(PRODUCTIZED_RELAY_WORKSPACE_ID)}),
        (${quote(PERSONAL_WORKSPACE_ID)}, ${quote(PERSONAL_ORG_ID)}, 'personal', 'Personal', NULL);

    INSERT INTO github_installations (
      installation_id,
      account_type,
      account_login,
      provider_config_key,
      connection_id
    )
      VALUES
        ('100', 'Organization', 'acme', NULL, NULL),
        ('101', 'Organization', 'acme', 'github-relay', 'conn-productized'),
        ('102', 'User', 'octocat', 'github-relay', 'conn-personal'),
        ('103', 'Organization', 'orphaned', 'github-relay', 'conn-orphan');

    INSERT INTO workspace_integrations (
      id,
      workspace_id,
      provider,
      connection_id,
      provider_config_key,
      installation_id
    )
      VALUES
        ('30000000-0000-0000-0000-000000000001', ${quote(WORKSPACE_ONE_ID)}, 'github', 'conn-shared', 'github-relay', '100'),
        ('30000000-0000-0000-0000-000000000002', ${quote(WORKSPACE_TWO_ID)}, 'github', 'conn-shared', 'github-relay', '100'),
        ('30000000-0000-0000-0000-000000000003', ${quote(ORPHAN_RELAY_WORKSPACE_ID)}, 'github', 'conn-orphan', 'github-relay', '103'),
        ('30000000-0000-0000-0000-000000000004', ${quote(PERSONAL_WORKSPACE_ID)}, 'github', 'conn-personal', 'github-relay', '102');

    INSERT INTO workspace_github_installation_links (
      id,
      workspace_id,
      installation_id,
      connection_id,
      provider_config_key
    )
      VALUES (
        '40000000-0000-0000-0000-000000000001',
        ${quote(PRODUCTIZED_RELAY_WORKSPACE_ID)},
        '101',
        'conn-productized',
        'github-relay'
      );
  `);
}

async function snapshotBackfilledTables(): Promise<Record<string, unknown[]>> {
  const orgRows = await pg!.query(`
    SELECT organization_id, installation_id, is_primary
    FROM organization_github_installations
    ORDER BY organization_id, installation_id
  `);
  const installationRows = await pg!.query(`
    SELECT installation_id, account_type, provider_config_key, connection_id
    FROM github_installations
    ORDER BY installation_id
  `);
  const sourceRows = await pg!.query(`
    SELECT id, workspace_id, provider, connection_id, provider_config_key, installation_id
    FROM workspace_integrations
    ORDER BY id
  `);
  const linkRows = await pg!.query(`
    SELECT id, workspace_id, installation_id, connection_id, provider_config_key
    FROM workspace_github_installation_links
    ORDER BY id
  `);
  return {
    organizationGithubInstallations: orgRows.rows,
    githubInstallations: installationRows.rows,
    workspaceIntegrations: sourceRows.rows,
    workspaceGithubInstallationLinks: linkRows.rows,
  };
}

describe("backfillGithubInstallationOrgOwnership", () => {
  beforeEach(async () => {
    pg = new PGlite();
    await setupSchema();
    await seedRepresentativeFixtures();
    setDbForTesting(drizzle(pg) as never);
  });

  afterEach(async () => {
    setDbForTesting(null);
    await pg?.close();
    pg = null;
  });

  it("dry-runs with zero writes while reporting fixture counts and orphans", async () => {
    const before = await snapshotBackfilledTables();
    const { backfillGithubInstallationOrgOwnership } = await import(
      "./github-installation-org-backfill"
    );

    const summary = await backfillGithubInstallationOrgOwnership();
    const after = await snapshotBackfilledTables();

    expect(summary.dryRun).toBe(true);
    expect(summary.scanned).toBe(5);
    expect(summary.eligible).toBe(2);
    expect(summary.wouldInsert).toBe(2);
    expect(summary.inserted).toBe(0);
    expect(summary.updated).toBe(0);
    expect(summary.connectionDivergences).toEqual([]);
    expect(summary.orphans).toEqual([
      expect.objectContaining({
        workspaceId: ORPHAN_RELAY_WORKSPACE_ID,
        installationId: "103",
        reason: "missing_organization",
      }),
    ]);
    expect(summary.skippedPersonal).toEqual([
      expect.objectContaining({
        workspaceId: PERSONAL_WORKSPACE_ID,
        installationId: "102",
      }),
    ]);
    expect(after).toEqual(before);
  });

  it("reports divergent connection candidates without writing", async () => {
    await exec(`
      UPDATE workspace_integrations
      SET connection_id = 'conn-shared-alt'
      WHERE id = '30000000-0000-0000-0000-000000000002'
    `);
    const before = await snapshotBackfilledTables();
    const { backfillGithubInstallationOrgOwnership } = await import(
      "./github-installation-org-backfill"
    );

    const summary = await backfillGithubInstallationOrgOwnership({
      reportDivergence: true,
    });
    const after = await snapshotBackfilledTables();

    expect(summary.connectionDivergences).toEqual([
      {
        organizationId: ORG_ID,
        installationId: "100",
        workspaceIds: [WORKSPACE_ONE_ID, WORKSPACE_TWO_ID],
        sources: ["workspace_integration"],
        chosenConnectionId: "conn-shared",
        connectionIds: ["conn-shared", "conn-shared-alt"],
        alternatives: ["conn-shared-alt"],
        candidates: [
          {
            source: "workspace_integration",
            sourceId: "30000000-0000-0000-0000-000000000001",
            workspaceId: WORKSPACE_ONE_ID,
            connectionId: "conn-shared",
          },
          {
            source: "workspace_integration",
            sourceId: "30000000-0000-0000-0000-000000000002",
            workspaceId: WORKSPACE_TWO_ID,
            connectionId: "conn-shared-alt",
          },
        ],
      },
    ]);
    expect(summary.results).toContainEqual(
      expect.objectContaining({
        organizationId: ORG_ID,
        installationId: "100",
        connectionId: "conn-shared",
        status: "would_insert",
      }),
    );
    expect(after).toEqual(before);
  });

  it("does not report divergent connection candidates during an ordinary dry-run", async () => {
    await exec(`
      UPDATE workspace_integrations
      SET connection_id = 'conn-shared-alt'
      WHERE id = '30000000-0000-0000-0000-000000000002'
    `);
    const before = await snapshotBackfilledTables();
    const { backfillGithubInstallationOrgOwnership } = await import(
      "./github-installation-org-backfill"
    );

    const summary = await backfillGithubInstallationOrgOwnership();
    const after = await snapshotBackfilledTables();

    expect(summary.dryRun).toBe(true);
    expect(summary.connectionDivergences).toEqual([]);
    expect(summary.results).toContainEqual(
      expect.objectContaining({
        organizationId: ORG_ID,
        installationId: "100",
        connectionId: "conn-shared",
        status: "would_insert",
      }),
    );
    expect(after).toEqual(before);
  });

  it("forces dry-run mode when reporting divergent connection candidates", async () => {
    const { backfillGithubInstallationOrgOwnership } = await import(
      "./github-installation-org-backfill"
    );

    const summary = await backfillGithubInstallationOrgOwnership({
      dryRun: false,
      reportDivergence: true,
    });

    expect(summary.dryRun).toBe(true);
    expect(summary.inserted).toBe(0);
    expect(summary.wouldInsert).toBe(2);
  });

  it("applies idempotently: multi-workspace org rows collapse, productized resolves via identity, second run has no changes", async () => {
    const { backfillGithubInstallationOrgOwnership } = await import(
      "./github-installation-org-backfill"
    );

    const first = await backfillGithubInstallationOrgOwnership({ dryRun: false });
    const afterFirst = await snapshotBackfilledTables();
    const second = await backfillGithubInstallationOrgOwnership({ dryRun: false });
    const afterSecond = await snapshotBackfilledTables();

    expect(first.inserted).toBe(2);
    expect(first.updated).toBe(0);
    expect(first.results).toEqual([
      expect.objectContaining({
        organizationId: ORG_ID,
        installationId: "100",
        workspaceIds: [WORKSPACE_ONE_ID, WORKSPACE_TWO_ID],
        sources: ["workspace_integration"],
        connectionId: "conn-shared",
        isPrimary: true,
        status: "inserted",
      }),
      expect.objectContaining({
        organizationId: ORG_ID,
        installationId: "101",
        workspaceIds: [PRODUCTIZED_RELAY_WORKSPACE_ID],
        sources: ["workspace_link"],
        connectionId: "conn-productized",
        isPrimary: false,
        status: "inserted",
      }),
    ]);

    expect(afterFirst.organizationGithubInstallations).toEqual([
      {
        organization_id: ORG_ID,
        installation_id: "100",
        is_primary: true,
      },
      {
        organization_id: ORG_ID,
        installation_id: "101",
        is_primary: false,
      },
    ]);
    expect(afterFirst.githubInstallations).toContainEqual({
      installation_id: "100",
      account_type: "Organization",
      provider_config_key: "github-relay",
      connection_id: "conn-shared",
    });
    expect(afterFirst.organizationGithubInstallations).not.toContainEqual(
      expect.objectContaining({
        organization_id: PERSONAL_ORG_ID,
        installation_id: "102",
      }),
    );

    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.existing).toBe(2);
    expect(second.results.every((result) => result.status === "existing")).toBe(true);
    expect(afterSecond).toEqual(afterFirst);
  });
});
