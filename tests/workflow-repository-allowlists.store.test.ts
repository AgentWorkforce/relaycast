import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test as nodeTest } from "node:test";
import { fileURLToPath } from "node:url";

const isVitestRuntime =
  process.env.VITEST_WORKER_ID !== undefined ||
  process.env.VITEST_POOL_ID !== undefined ||
  process.argv.some((arg) => arg.includes("vitest"));

if (!isVitestRuntime) {
  nodeTest("workflow repository allowlist store", () => {
    const result = spawnSync(
      process.execPath,
      ["./node_modules/vitest/vitest.mjs", "run", fileURLToPath(import.meta.url)],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, FORCE_COLOR: "0" },
      },
    );

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
} else {
const { afterEach, beforeEach, describe, expect, it } = await import("vitest");
const { createRelayfileWritebackPgliteDb } = await import("./helpers/relayfile-writeback-pglite-db.ts");
const {
  deleteAllowedRepo,
  getAllowedRepo,
  isRepoAllowlistEnforced,
  listAllowedRepos,
  resolveRepoAllowlistOrRelaxed,
  updateAllowedRepoPushAllowed,
  upsertAllowedRepo,
} = await import("../packages/web/lib/integrations/workflow-repository-allowlists.ts");

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_USER_ID = "33333333-3333-4333-8333-333333333333";

let cleanupDb: (() => Promise<void>) | undefined;
let installGithubIntegration: (
  installationId: string,
  provider?: string,
) => Promise<void>;

beforeEach(async () => {
  const testDb = await createRelayfileWritebackPgliteDb();
  cleanupDb = testDb.cleanup;
  testDb.installAsAppDb();
  await testDb.insertWorkspace({ id: WORKSPACE_ID });
  installGithubIntegration = (installationId, provider = "github") =>
    testDb.insertWorkspaceIntegration({
      workspaceId: WORKSPACE_ID,
      provider,
      connectionId: `nango_${provider}_${installationId}`,
      // Pin providerConfigKey explicitly so nangoProxyJson doesn't
      // fall through to getProviderConfigKey() and throw "Unknown
      // workspace integration provider" for forward-looking provider
      // names like `github-ricky` that aren't yet registered in
      // WORKSPACE_INTEGRATION_PROVIDERS. Pre-#439 this throw was
      // silently caught inside installationCanAccessRepo, which is
      // exactly the class of bug this PR fixes.
      providerConfigKey: provider === "github" ? "github-sage" : provider,
      installationId,
    });
  delete process.env.CLOUD_REPO_ALLOWLIST_ENFORCED;
  process.env.NANGO_SECRET_KEY = "test-nango-secret";
});

afterEach(async () => {
  if (cleanupDb) {
    await cleanupDb();
    cleanupDb = undefined;
  }
});

describe("workflow repository allowlist store", () => {
  it("inserts, lists, reads, toggles, and deletes allowlist rows", async () => {
    const created = await upsertAllowedRepo({
      workspaceId: WORKSPACE_ID,
      repoOwner: "agentrelay",
      repoName: "cloud",
      installationId: "install_1",
      allowedBy: USER_ID,
    });

    expect(created).toMatchObject({
      workspaceId: WORKSPACE_ID,
      repoOwner: "agentrelay",
      repoName: "cloud",
      installationId: "install_1",
      pushAllowed: false,
      allowedBy: USER_ID,
    });
    expect(created.allowedAt).toBeInstanceOf(Date);

    await upsertAllowedRepo({
      workspaceId: WORKSPACE_ID,
      repoOwner: "agentrelay",
      repoName: "sdk",
      installationId: "install_1",
      pushAllowed: true,
      allowedBy: USER_ID,
    });

    await expect(listAllowedRepos(WORKSPACE_ID)).resolves.toMatchObject([
      { repoOwner: "agentrelay", repoName: "cloud", pushAllowed: false },
      { repoOwner: "agentrelay", repoName: "sdk", pushAllowed: true },
    ]);

    await expect(getAllowedRepo(WORKSPACE_ID, "agentrelay", "cloud")).resolves.toMatchObject({
      repoOwner: "agentrelay",
      repoName: "cloud",
      pushAllowed: false,
    });

    await expect(
      updateAllowedRepoPushAllowed(WORKSPACE_ID, "agentrelay", "cloud", true),
    ).resolves.toMatchObject({
      repoOwner: "agentrelay",
      repoName: "cloud",
      pushAllowed: true,
    });

    await expect(deleteAllowedRepo(WORKSPACE_ID, "agentrelay", "cloud")).resolves.toBe(true);
    await expect(getAllowedRepo(WORKSPACE_ID, "agentrelay", "cloud")).resolves.toBeNull();
    await expect(deleteAllowedRepo(WORKSPACE_ID, "agentrelay", "cloud")).resolves.toBe(false);
  });

  it("upserts one row per workspace/repo and refreshes audit fields", async () => {
    const first = await upsertAllowedRepo({
      workspaceId: WORKSPACE_ID,
      repoOwner: "agentrelay",
      repoName: "cloud",
      installationId: "install_before",
      allowedBy: USER_ID,
    });

    const second = await upsertAllowedRepo({
      workspaceId: WORKSPACE_ID,
      repoOwner: "agentrelay",
      repoName: "cloud",
      installationId: "install_after",
      pushAllowed: true,
      allowedBy: OTHER_USER_ID,
    });

    expect(second.allowedAt.getTime()).toBeGreaterThanOrEqual(first.allowedAt.getTime());
    await expect(listAllowedRepos(WORKSPACE_ID)).resolves.toMatchObject([
      {
        repoOwner: "agentrelay",
        repoName: "cloud",
        installationId: "install_after",
        pushAllowed: true,
        allowedBy: OTHER_USER_ID,
      },
    ]);
  });

  it("returns null when toggling push for a repo that is not allowlisted", async () => {
    await expect(
      updateAllowedRepoPushAllowed(WORKSPACE_ID, "missing", "repo", true),
    ).resolves.toBeNull();
  });

  it("normalizes repo coordinates to lowercase on insert and looks them up case-insensitively", async () => {
    // Upsert with mixed-case input.
    const created = await upsertAllowedRepo({
      workspaceId: WORKSPACE_ID,
      repoOwner: "AgentRelay",
      repoName: "Cloud",
      installationId: "install_1",
      allowedBy: USER_ID,
    });
    // Stored row is canonical lowercase.
    expect(created.repoOwner).toBe("agentrelay");
    expect(created.repoName).toBe("cloud");

    // Lookup with arbitrary casing hits the lowercase row.
    await expect(getAllowedRepo(WORKSPACE_ID, "AGENTRELAY", "CLOUD")).resolves.toMatchObject({
      repoOwner: "agentrelay",
      repoName: "cloud",
    });
    await expect(getAllowedRepo(WORKSPACE_ID, "agentrelay", "Cloud")).resolves.toMatchObject({
      repoOwner: "agentrelay",
      repoName: "cloud",
    });
  });
});

describe("resolveRepoAllowlistOrRelaxed", () => {
  // Sentinel fetch — used in every relaxed-mode test below to assert
  // the resolver is fully no-network and no-DB-beyond-allowlist-table.
  // The relaxed path does NOT query workspace_integrations or hit
  // GitHub; that's push-back's job, not the resolver's.
  const failOnFetch = (async () => {
    throw new Error("relaxed-mode resolver must not perform any HTTP call");
  }) as typeof fetch;

  it("returns the explicit row when one exists, even with pushAllowed=false (no network, no install lookup)", async () => {
    // Strict-mode contract preserved: an explicit row carries the
    // operator's authoritative installationId, and the resolver
    // returns that row verbatim. Push-back uses the row's
    // installationId directly — no fanout — because strict means
    // strict. Without an explicit row this same call would just
    // return the synthetic relaxed sentinel.
    await installGithubIntegration("install_explicit");
    await upsertAllowedRepo({
      workspaceId: WORKSPACE_ID,
      repoOwner: "agentrelay",
      repoName: "cloud",
      installationId: "install_explicit",
      pushAllowed: false,
      allowedBy: USER_ID,
    });

    const resolved = await resolveRepoAllowlistOrRelaxed(WORKSPACE_ID, "agentrelay", "cloud", {
      fetchImpl: failOnFetch,
    });
    expect(resolved).toMatchObject({
      installationId: "install_explicit",
      pushAllowed: false,
      allowedBy: USER_ID,
    });
  });

  it("returns a synthetic record with empty installationId in relaxed mode (push-back handles routing)", async () => {
    // The resolver is now structurally split from routing. In relaxed
    // mode it always says "yes" with no installation hint; the empty
    // `installationId` sentinel tells push-back to discover the
    // workspace's github-* installs itself and try each one. This
    // means: no install-lookup query at all, no fanout in the resolver,
    // and the resolver doesn't even need to know whether the workspace
    // has any installs (push-back will report "integration_not_found"
    // in pushedTo if there are none).
    const resolved = await resolveRepoAllowlistOrRelaxed(
      WORKSPACE_ID,
      "AgentWorkforce",
      "scratch",
      { fetchImpl: failOnFetch },
    );
    expect(isRepoAllowlistEnforced()).toBe(false);
    expect(resolved).toMatchObject({
      workspaceId: WORKSPACE_ID,
      repoOwner: "agentworkforce",
      repoName: "scratch",
      installationId: "",
      pushAllowed: true,
      allowedBy: "system:relaxed",
    });
  });

  it("synthesizes the same shape regardless of whether an install exists in the DB", async () => {
    // Critically: presence/absence of a github integration row does
    // not change the resolver's output in relaxed mode. The resolver
    // never reads workspace_integrations. This is the structural
    // separation: routing decisions belong in push-back. Run the
    // same call with and without an integration installed; both must
    // return the empty-installationId sentinel.
    const before = await resolveRepoAllowlistOrRelaxed(
      WORKSPACE_ID,
      "AgentWorkforce",
      "scratch",
      { fetchImpl: failOnFetch },
    );
    await installGithubIntegration("install_x");
    const after = await resolveRepoAllowlistOrRelaxed(
      WORKSPACE_ID,
      "AgentWorkforce",
      "scratch",
      { fetchImpl: failOnFetch },
    );
    expect(before).toEqual(after);
    expect(before?.installationId).toBe("");
  });

  it("returns null in strict mode when no row exists, regardless of github install", async () => {
    process.env.CLOUD_REPO_ALLOWLIST_ENFORCED = "true";
    await installGithubIntegration("install_strict");

    const resolved = await resolveRepoAllowlistOrRelaxed(WORKSPACE_ID, "AgentWorkforce", "scratch");
    expect(isRepoAllowlistEnforced()).toBe(true);
    expect(resolved).toBeNull();
  });
});
}
