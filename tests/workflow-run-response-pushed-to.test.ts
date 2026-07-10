import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveRequestAuthMock = vi.hoisted(() => vi.fn());
const requireAuthScopeMock = vi.hoisted(() => vi.fn());
const canAccessWorkflowRunMock = vi.hoisted(() => vi.fn());
const workflowStoreGetMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: (...args: unknown[]) => resolveRequestAuthMock(...args),
  requireAuthScope: (...args: unknown[]) => requireAuthScopeMock(...args),
  canAccessWorkflowRun: (...args: unknown[]) => canAccessWorkflowRunMock(...args),
}));

vi.mock("@/lib/workflows", () => ({
  workflowStore: {
    get: (...args: unknown[]) => workflowStoreGetMock(...args),
  },
}));

const run = {
  runId: "33333333-3333-4333-8333-333333333333",
  sandboxId: "sandbox_1",
  dispatchType: "sandbox",
  userId: "22222222-2222-4222-8222-222222222222",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  workflow: "name: test",
  fileType: "yaml",
  status: "completed",
  callbackToken: "callback-token",
  createdAt: "2026-04-23T00:00:00.000Z",
  updatedAt: "2026-04-23T00:00:00.000Z",
  paths: [
    { name: "cloud", s3CodeKey: "code-cloud.tar.gz" },
    { name: "relay", s3CodeKey: "code-relay.tar.gz" },
  ],
};

async function loadRoute() {
  return import(
    new URL(
      "../packages/web/app/api/v1/workflows/runs/[runId]/route.ts",
      import.meta.url,
    ).href
  );
}

beforeEach(() => {
  resolveRequestAuthMock.mockResolvedValue({
    userId: run.userId,
    workspaceId: run.workspaceId,
    scopes: ["workflow:runs:read"],
  });
  requireAuthScopeMock.mockReturnValue(true);
  canAccessWorkflowRunMock.mockReturnValue(true);
  workflowStoreGetMock.mockResolvedValue(run);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("workflow run response pushedTo", () => {
  it("adds pushedTo and pushError fields onto the existing patches block", async () => {
    workflowStoreGetMock.mockResolvedValueOnce({
      ...run,
      pushedTo: {
        cloud: {
          status: "pushed",
          branch: "agent-relay/run-1",
          prUrl: "https://github.com/acme/cloud/pull/1",
          sha: "sha-1",
          base: { branch: "main", sha: "base-1" },
          strategy: "contents_api",
          pushedAt: "2026-04-23T00:00:00.000Z",
        },
        relay: {
          status: "failed",
          code: "base_branch_moved",
          message: "Base branch moved",
          base: { branch: "main", sha: "base-1" },
          observedBaseSha: "base-2",
          failedAt: "2026-04-23T00:00:01.000Z",
        },
      },
    });
    const { GET } = await loadRoute();

    const response = await GET(
      new Request("https://cloud.test/api/v1/workflows/runs/run-1") as never,
      { params: Promise.resolve({ runId: run.runId }) },
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.patches).toEqual({
      cloud: {
        s3Key: `${run.userId}/${run.runId}/changes-cloud.patch`,
        pushedTo: {
          branch: "agent-relay/run-1",
          prUrl: "https://github.com/acme/cloud/pull/1",
          sha: "sha-1",
          base: { branch: "main", sha: "base-1" },
          strategy: "contents_api",
        },
      },
      relay: {
        s3Key: `${run.userId}/${run.runId}/changes-relay.patch`,
        pushError: {
          code: "base_branch_moved",
          message: "Base branch moved",
          base: { branch: "main", sha: "base-1" },
          observedBaseSha: "base-2",
        },
      },
    });
  });

  it("keeps Phase B patch entries unchanged when no push result is stored", async () => {
    const { GET } = await loadRoute();

    const response = await GET(
      new Request("https://cloud.test/api/v1/workflows/runs/run-1") as never,
      { params: Promise.resolve({ runId: run.runId }) },
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.patches).toEqual({
      cloud: { s3Key: `${run.userId}/${run.runId}/changes-cloud.patch` },
      relay: { s3Key: `${run.userId}/${run.runId}/changes-relay.patch` },
    });
  });
});

describe("workflowStore.update pushedTo atomic merge (PGlite)", () => {
  // Bumped from the default 5s — this test boots a real PGlite instance,
  // runs two concurrent SQL updates, and verifies their atomic merge.
  // Under parallel load (other handler tests sharing the runner) the
  // PGlite bring-up can easily overshoot 5s; in isolation it finishes in
  // a couple of hundred ms. A 30s ceiling keeps the gate honest without
  // flaking on a loaded CI box.
  it("merges disjoint pushedTo keys when two updates fire concurrently", { timeout: 30_000 }, async () => {
    const { createRelayfileWritebackPgliteDb } = await import("./helpers/relayfile-writeback-pglite-db.ts");
    // The top-level vi.mock("@/lib/workflows") replaces the module with a
    // partial mock (no .update). Use importActual to grab the real
    // workflowStore for this PGlite-backed test.
    const actualWorkflows = await vi.importActual<typeof import("../packages/web/lib/workflows.ts")>(
      "../packages/web/lib/workflows.ts",
    );
    const { workflowStore } = actualWorkflows;

    const testDb = await createRelayfileWritebackPgliteDb();
    try {
      testDb.installAsAppDb();
      const workspaceId = "11111111-1111-4111-8111-111111111111";
      const userId = "22222222-2222-4222-8222-222222222222";
      const runId = "33333333-3333-4333-8333-333333333333";

      await testDb.insertWorkspace({ id: workspaceId });

      // Seed a workflow run with no pushedTo via the helper.
      await testDb.insertWorkflowRun({
        id: runId,
        userId,
        workspaceId,
        callbackToken: "cb",
        status: "completed",
      });

      // Fire two updates "concurrently" with disjoint keys. With the SQL
      // jsonb || merge both keys should land. With the old SELECT-merge
      // pattern one would clobber the other.
      await Promise.all([
        workflowStore.update(runId, {
          pushedTo: {
            cloud: { status: "pushed", branch: "br-cloud" },
          },
        } as never),
        workflowStore.update(runId, {
          pushedTo: {
            relay: { status: "pushed", branch: "br-relay" },
          },
        } as never),
      ]);

      const after = await workflowStore.get(runId);
      expect(after?.pushedTo).toMatchObject({
        cloud: { status: "pushed", branch: "br-cloud" },
        relay: { status: "pushed", branch: "br-relay" },
      });
    } finally {
      await testDb.cleanup();
    }
  });
});
