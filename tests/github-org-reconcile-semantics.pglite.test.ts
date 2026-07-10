// Gate-bar tests for org-reconcile PR1 under the guided-authorize design
// (reviewer-1's locked bar, items 1–3 + 5; lead decision 2026-06-04):
//
// 1. Constraint pin: UNIQUE (provider, connection_id) on
//    workspace_integrations — connection sharing across workspaces cannot
//    silently (re)appear. This constraint (migration 0010) is what killed
//    the original row-copy linking spec.
// 2. 0041-shape pin: installation-uniqueness was deliberately DROPPED in
//    migration 0041 — the same installation in two workspaces, each with
//    its OWN connection, is legal. That is the guided-authorize shape.
// 3. Per-connection routing positive assertion: the unique-match lookup that
//    IS webhook routing resolves connA→A and connB→B — fan-out is the
//    natural per-connection behavior, no shared-connection limitation.
// 5. Tombstone scoping: a workspace's disconnect tombstone is keyed
//    (workspaceId, provider, connectionId) and never suppresses another
//    workspace's self-heal.
//
// All assertions run against PGlite with the real drizzle migrations — no
// query mocking — so the proofs hold at the SQL level.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
  },
}));

// github-oauth-identity imports nango-service for the (unused-here) org
// fetch; stub it so the import never touches SST resources in tests.
vi.mock("@/lib/integrations/nango-service", () => ({
  getNangoClient: vi.fn(),
  getNangoConnectionDetails: vi.fn(),
}));

// insertWorkspaceIntegrationIfAbsent fire-and-forgets a relayfile credential
// push; keep it inert against PGlite.
vi.mock("@/lib/integrations/relayfile-integration-credentials", () => ({
  pushRelayfileIntegrationCredentialBestEffort: vi.fn().mockResolvedValue(undefined),
}));

import { createPgliteDb } from "../packages/web/test/helpers/pglite-db";
import { setDbForTesting } from "../packages/web/lib/db";
import { findGithubInstallationsByAccountLogins } from "../packages/web/lib/integrations/github-oauth-identity";
import {
  findWorkspaceIntegrationByConnection,
  getRecentWorkspaceIntegrationDisconnect,
  getWorkspaceIntegration,
  insertWorkspaceIntegrationIfAbsent,
  recordWorkspaceIntegrationDisconnect,
} from "../packages/web/lib/integrations/workspace-integrations";

const WORKSPACE_A = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_B = "22222222-2222-4222-8222-222222222222";
const CONNECTION_A = "conn-org-install-workspace-a";
const CONNECTION_B = "conn-org-install-workspace-b";
const SHARED_INSTALLATION = "9001";

let pglite: Awaited<ReturnType<typeof createPgliteDb>>;

beforeAll(async () => {
  pglite = await createPgliteDb();
  setDbForTesting(pglite.db as never);
});

afterAll(async () => {
  setDbForTesting(null);
  await pglite.cleanup();
});

beforeEach(async () => {
  await pglite.exec(
    "DELETE FROM workspace_integrations; DELETE FROM workspace_integration_disconnects; DELETE FROM github_installations;",
  );
});

describe("constraint pin — connection sharing cannot silently reappear (bar item 1)", () => {
  it("rejects a second workspace row with the same (provider, connection_id)", async () => {
    await insertWorkspaceIntegrationIfAbsent({
      workspaceId: WORKSPACE_A,
      provider: "github",
      connectionId: CONNECTION_A,
      providerConfigKey: "github-relay",
      installationId: SHARED_INSTALLATION,
    });

    // The original spec's row-copy linking — workspace B reusing A's
    // connection — must stay structurally impossible.
    let violation: unknown = null;
    try {
      await insertWorkspaceIntegrationIfAbsent({
        workspaceId: WORKSPACE_B,
        provider: "github",
        connectionId: CONNECTION_A,
        providerConfigKey: "github-relay",
        installationId: SHARED_INSTALLATION,
      });
    } catch (error) {
      violation = error;
    }
    expect(violation).not.toBeNull();
    const text = [
      (violation as { message?: string })?.message,
      (violation as { code?: string })?.code,
      ((violation as { cause?: { message?: string; code?: string } })?.cause?.message ?? ""),
      ((violation as { cause?: { code?: string } })?.cause?.code ?? ""),
    ].join(" ");
    expect(text).toMatch(/23505|workspace_integrations_provider_connection_unique|duplicate key/);
  });
});

describe("0041-shape pin — same installation, own connections, two workspaces (bar item 2)", () => {
  it("allows the same installation_id in two workspaces when each owns its connection", async () => {
    const first = await insertWorkspaceIntegrationIfAbsent({
      workspaceId: WORKSPACE_A,
      provider: "github",
      connectionId: CONNECTION_A,
      providerConfigKey: "github-relay",
      installationId: SHARED_INSTALLATION,
    });
    const second = await insertWorkspaceIntegrationIfAbsent({
      workspaceId: WORKSPACE_B,
      provider: "github",
      connectionId: CONNECTION_B,
      providerConfigKey: "github-relay",
      installationId: SHARED_INSTALLATION,
    });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(true);

    const rowA = await getWorkspaceIntegration(WORKSPACE_A, "github");
    const rowB = await getWorkspaceIntegration(WORKSPACE_B, "github");
    expect(rowA?.installationId).toBe(SHARED_INSTALLATION);
    expect(rowB?.installationId).toBe(SHARED_INSTALLATION);
    expect(rowA?.connectionId).not.toBe(rowB?.connectionId);
  });
});

describe("per-connection routing (bar item 3)", () => {
  it("the unique-match lookup that IS webhook routing resolves each connection to its own workspace", async () => {
    await insertWorkspaceIntegrationIfAbsent({
      workspaceId: WORKSPACE_A,
      provider: "github",
      connectionId: CONNECTION_A,
      providerConfigKey: "github-relay",
      installationId: SHARED_INSTALLATION,
    });
    await insertWorkspaceIntegrationIfAbsent({
      workspaceId: WORKSPACE_B,
      provider: "github",
      connectionId: CONNECTION_B,
      providerConfigKey: "github-relay",
      installationId: SHARED_INSTALLATION,
    });

    const resolvedA = await findWorkspaceIntegrationByConnection("github", CONNECTION_A);
    const resolvedB = await findWorkspaceIntegrationByConnection("github", CONNECTION_B);

    // Fan-out is natural under guided authorize: each workspace's webhooks
    // (sync + forward route through this lookup) land in that workspace.
    expect(resolvedA?.workspaceId).toBe(WORKSPACE_A);
    expect(resolvedB?.workspaceId).toBe(WORKSPACE_B);
  });
});

describe("tombstone scoping (bar item 5)", () => {
  it("B's disconnect tombstone does not suppress A's late-webhook self-heal lookup", async () => {
    await recordWorkspaceIntegrationDisconnect({
      workspaceId: WORKSPACE_B,
      provider: "github",
      connectionId: CONNECTION_B,
    });

    // The self-heal path (nango-webhook-router) checks the tombstone for the
    // RECOVERED workspace id before recreating a row; A must see none —
    // under either key dimension (its own connection or B's).
    expect(
      await getRecentWorkspaceIntegrationDisconnect({
        workspaceId: WORKSPACE_A,
        provider: "github",
        connectionId: CONNECTION_A,
      }),
    ).toBeNull();
    expect(
      await getRecentWorkspaceIntegrationDisconnect({
        workspaceId: WORKSPACE_A,
        provider: "github",
        connectionId: CONNECTION_B,
      }),
    ).toBeNull();
    expect(
      await getRecentWorkspaceIntegrationDisconnect({
        workspaceId: WORKSPACE_B,
        provider: "github",
        connectionId: CONNECTION_B,
      }),
    ).not.toBeNull();
  });
});

describe("reconcile detection lookups (bar item 6 support)", () => {
  beforeEach(async () => {
    await pglite.exec(`
      INSERT INTO github_installations (installation_id, account_type, account_login, suspended)
      VALUES
        ('9001', 'Organization', 'AcmeOrg', false),
        ('9002', 'Organization', 'SuspendedOrg', true),
        ('9003', 'User', 'solo-dev', false);
    `);
  });

  it("matches account logins case-insensitively and surfaces suspension", async () => {
    const matches = await findGithubInstallationsByAccountLogins([
      "acmeorg",
      "suspendedorg",
      "solo-dev",
      "unknownorg",
    ]);
    const byLogin = new Map(matches.map((match) => [match.accountLogin, match]));

    expect(byLogin.size).toBe(3);
    expect(byLogin.get("AcmeOrg")).toMatchObject({
      installationId: "9001",
      accountType: "Organization",
      suspended: false,
    });
    expect(byLogin.get("SuspendedOrg")).toMatchObject({ suspended: true });
    expect(byLogin.get("solo-dev")).toMatchObject({ accountType: "User" });
  });

  it("returns no matches for an empty candidate list", async () => {
    expect(await findGithubInstallationsByAccountLogins([])).toEqual([]);
  });
});
