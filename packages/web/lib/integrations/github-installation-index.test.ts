import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDbForTesting } from "@/lib/db";

const connectionMocks = vi.hoisted(() => ({
  resolveGithubConnectionWorkspaceIdentity: vi.fn(),
}));
vi.mock("./github-installation-connection", () => ({
  resolveGithubConnectionWorkspaceIdentity:
    connectionMocks.resolveGithubConnectionWorkspaceIdentity,
}));

import {
  ensureOrganizationInstallationOwnership,
  parseGithubInstallationIndexPayload,
} from "./github-installation-index";

describe("parseGithubInstallationIndexPayload", () => {
  it("extracts canonical installation account metadata and active repositories", () => {
    const parsed = parseGithubInstallationIndexPayload({
      payload: {
        action: "created",
        installation: {
          id: 12345,
          account: { type: "Organization", login: "AgentWorkforce", id: 987 },
          repository_selection: "selected",
          permissions: { contents: "write", pull_requests: "read" },
          events: ["push", "pull_request"],
        },
        repositories: [
          { id: 111, full_name: "AgentWorkforce/cloud", name: "cloud" },
        ],
      },
    });

    expect(parsed?.installation).toEqual({
      installationId: "12345",
      accountType: "Organization",
      accountLogin: "AgentWorkforce",
      accountId: "987",
      repositorySelection: "selected",
      permissions: { contents: "write", pull_requests: "read" },
      events: ["push", "pull_request"],
      suspended: false,
      suspendedAt: null,
      suspendedBy: null,
    });
    expect(parsed?.repositories).toEqual([
      {
        installationId: "12345",
        repoOwner: "agentworkforce",
        repoName: "cloud",
        repoId: "111",
        accessState: "active",
      },
    ]);
  });

  it("marks removed repositories as access_removed and preserves unknown legacy account type", () => {
    const parsed = parseGithubInstallationIndexPayload({
      installationId: "inst_legacy",
      payload: {
        repositories_removed: [
          { full_name: "AgentWorkforce/old-repo" },
        ],
      },
    });

    expect(parsed?.installation.accountType).toBe("unknown");
    expect(parsed?.installation.repositorySelection).toBe("unknown");
    expect(parsed?.repositories).toEqual([
      {
        installationId: "inst_legacy",
        repoOwner: "agentworkforce",
        repoName: "old-repo",
        repoId: null,
        accessState: "access_removed",
      },
    ]);
  });

  it("normalizes mixed-case repository coordinates before indexing", () => {
    const parsed = parseGithubInstallationIndexPayload({
      installationId: "inst_mixed",
      payload: {
        repositories_added: [
          {
            id: 222,
            full_name: "AgentWorkforce/Cloud",
            owner: { login: "AgentWorkforce" },
            name: "Cloud",
          },
        ],
      },
    });

    expect(parsed?.repositories).toEqual([
      {
        installationId: "inst_mixed",
        repoOwner: "agentworkforce",
        repoName: "cloud",
        repoId: "222",
        accessState: "active",
      },
    ]);
  });
});

describe("ensureOrganizationInstallationOwnership", () => {
  let pg: PGlite | null = null;
  const ORG_ID = "10000000-0000-0000-0000-000000000001";
  const APP_WORKSPACE_ID = "20000000-0000-0000-0000-000000000001"; // uuid (app)
  const RELAY_WORKSPACE_ID = "rw_7ccfea89"; // relay-format (same logical workspace)
  const NO_ORG_WORKSPACE_ID = "20000000-0000-0000-0000-0000000000ff";
  const ADMIN_ID = "00000000-0000-0000-0000-000000000002";
  const TS = new Date("2026-06-14T00:00:00.000Z");

  // Mirror the read resolver: both the app-uuid and the relay-format id map to
  // the same org; an unrecognized workspace maps to no org.
  function mockIdentity() {
    connectionMocks.resolveGithubConnectionWorkspaceIdentity.mockImplementation(
      async (workspaceId: string) => ({
        organizationId:
          workspaceId === APP_WORKSPACE_ID || workspaceId === RELAY_WORKSPACE_ID ? ORG_ID : null,
        candidateWorkspaceIds: [workspaceId],
      }),
    );
  }

  beforeEach(async () => {
    pg = new PGlite();
    setDbForTesting(drizzle(pg) as never);
    vi.clearAllMocks();
    mockIdentity();
    await pg.exec(`
      CREATE TABLE organization_github_installations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        installation_id text NOT NULL,
        is_primary boolean NOT NULL DEFAULT true,
        linked_by_user_id uuid,
        created_at timestamp with time zone NOT NULL DEFAULT now(),
        updated_at timestamp with time zone NOT NULL DEFAULT now(),
        UNIQUE (organization_id, installation_id)
      );
    `);
  });

  afterEach(async () => {
    setDbForTesting(null);
    await pg?.close();
    pg = null;
  });

  async function ownerRows(): Promise<Array<{ installation_id: string; is_primary: boolean }>> {
    const r = (await pg!.query(
      `SELECT installation_id, is_primary FROM organization_github_installations WHERE organization_id = $1 ORDER BY created_at`,
      [ORG_ID],
    )) as { rows: Array<{ installation_id: string; is_primary: boolean }> };
    return r.rows;
  }

  it("establishes org ownership (primary) for an app-uuid workspace", async () => {
    await ensureOrganizationInstallationOwnership(drizzle(pg!) as never, {
      workspaceId: APP_WORKSPACE_ID,
      installationId: "900",
      linkedByUserId: ADMIN_ID,
      timestamp: TS,
    });
    expect(await ownerRows()).toEqual([{ installation_id: "900", is_primary: true }]);
  });

  it("establishes via the binding for a relay-format workspace id (no uuid throw)", async () => {
    await ensureOrganizationInstallationOwnership(drizzle(pg!) as never, {
      workspaceId: RELAY_WORKSPACE_ID,
      installationId: "900",
      linkedByUserId: ADMIN_ID,
      timestamp: TS,
    });
    expect(await ownerRows()).toEqual([{ installation_id: "900", is_primary: true }]);
  });

  it("is idempotent — re-indexing the same installation does not duplicate", async () => {
    const args = { workspaceId: APP_WORKSPACE_ID, installationId: "900", linkedByUserId: ADMIN_ID, timestamp: TS };
    await ensureOrganizationInstallationOwnership(drizzle(pg!) as never, args);
    await ensureOrganizationInstallationOwnership(drizzle(pg!) as never, args);
    expect(await ownerRows()).toHaveLength(1);
  });

  it("marks a second distinct installation non-primary", async () => {
    await ensureOrganizationInstallationOwnership(drizzle(pg!) as never, {
      workspaceId: APP_WORKSPACE_ID, installationId: "900", linkedByUserId: ADMIN_ID, timestamp: TS,
    });
    await ensureOrganizationInstallationOwnership(drizzle(pg!) as never, {
      workspaceId: APP_WORKSPACE_ID, installationId: "901", linkedByUserId: ADMIN_ID, timestamp: TS,
    });
    expect(await ownerRows()).toEqual([
      { installation_id: "900", is_primary: true },
      { installation_id: "901", is_primary: false },
    ]);
  });

  it("skips when the workspace does not map to a cloud org", async () => {
    await ensureOrganizationInstallationOwnership(drizzle(pg!) as never, {
      workspaceId: NO_ORG_WORKSPACE_ID,
      installationId: "900",
      linkedByUserId: ADMIN_ID,
      timestamp: TS,
    });
    expect(await ownerRows()).toHaveLength(0);
  });
});
