import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import type { AppDb } from "@/lib/db";
import { cloudAgentBoxWarmJobs } from "@/lib/db/schema";
import { createPgliteDb } from "@/test/helpers/pglite-db";

import { CloudAgentBoxError, type CloudAgentBoxDeps } from "./box-manager";
import {
  createCloudAgentBoxWarmJob,
  getLatestCloudAgentBoxWarmJob,
  markCloudAgentBoxWarmJobFailed,
  markCloudAgentBoxWarmJobReady,
} from "./warm-job-store";
import {
  resetCloudAgentBoxWarmTransportForTesting,
  setCloudAgentBoxWarmTransport,
} from "./warm-queue";
import {
  isCloudAgentWarmViaQueueEnabled,
  readCloudAgentBoxViaQueue,
  startCloudAgentBoxWarmViaQueue,
} from "./warm-route";

const auth = {
  userId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  organizationId: "00000000-0000-0000-0000-000000000003",
};
const cloudAgentId = "00000000-0000-0000-0000-000000000004";
const testNow = new Date("2026-05-29T12:00:00.000Z");

function makeDeps(): CloudAgentBoxDeps {
  return {
    findCredential: vi.fn(async () => ({
      id: cloudAgentId, organizationId: auth.organizationId, workspaceId: auth.workspaceId,
      userId: auth.userId, harness: "claude", modelProvider: "anthropic", authType: "provider_oauth",
      displayName: "Claude", defaultModel: "claude-sonnet-4-5", status: "connected",
      credentialExpiresAt: null, refreshExhausted: false, lastError: null,
    })),
    findStickySandbox: vi.fn(async () => null),
    getCredentialSecret: vi.fn(async () => JSON.stringify({ oauth: true })),
    mintPathScopedRelayfileToken: vi.fn(async (i: { paths: string[] }) => `relay_pa_${i.paths.join("_")}`),
    mintRelayAuthWorkspaceToken: vi.fn(async (i: { workspaceId: string }) => `relay_ws_${i.workspaceId}`),
    evictRelayAuthWorkspaceTokenCache: vi.fn(),
    resolveRelayAuthConfig: vi.fn(() => ({ relayAuthUrl: "https://api.relayauth.test", relayAuthApiKey: "k" })),
    resolveRelayfileConfig: vi.fn(() => ({ relayfileUrl: "https://relayfile.test", relayAuthUrl: "https://api.relayauth.test", relayAuthApiKey: "k" })),
    now: vi.fn(() => testNow),
  } as unknown as CloudAgentBoxDeps;
}

type Pglite = Awaited<ReturnType<typeof createPgliteDb>>;

describe("warm route flag gating (slice 3b)", () => {
  afterEach(() => {
    delete process.env.CLOUD_AGENT_WARM_VIA_QUEUE;
    resetCloudAgentBoxWarmTransportForTesting();
  });
  it("defaults OFF (legacy scheduleBackgroundTask path)", () => {
    delete process.env.CLOUD_AGENT_WARM_VIA_QUEUE;
    expect(isCloudAgentWarmViaQueueEnabled()).toBe(false);
  });
  it("reads true/1/yes", () => {
    for (const v of ["true", "1", "yes", "TRUE"]) {
      process.env.CLOUD_AGENT_WARM_VIA_QUEUE = v;
      expect(isCloudAgentWarmViaQueueEnabled()).toBe(true);
    }
    process.env.CLOUD_AGENT_WARM_VIA_QUEUE = "0";
    expect(isCloudAgentWarmViaQueueEnabled()).toBe(false);
  });
});

describe("warm route producer/observer (slice 3b, PGlite)", () => {
  let pg: Pglite; let db: AppDb;
  beforeEach(async () => {
    pg = await createPgliteDb();
    db = pg.db as unknown as AppDb;
    const { setDbForTesting } = await import("@/lib/db");
    setDbForTesting(db);
    setCloudAgentBoxWarmTransport(vi.fn(async () => undefined));
  });
  afterEach(async () => {
    const { setDbForTesting } = await import("@/lib/db");
    setDbForTesting(null);
    resetCloudAgentBoxWarmTransportForTesting();
    await pg.cleanup();
  });

  it("startViaQueue creates a job (with request), enqueues ensure-sandbox, returns 202 warming", async () => {
    const enqueue = vi.fn(async () => undefined);
    setCloudAgentBoxWarmTransport(enqueue);
    const result = await startCloudAgentBoxWarmViaQueue(makeDeps(), {
      auth, cloudAgentId, workspaceToken: null, mountPaths: ["/workspace"],
    });
    expect(result.status).toBe(202);
    expect(result.response).toMatchObject({
      status: "warming",
      relayfileToken: "relay_pa_/workspace",
      phase: "queued",
      etaMs: 300_000,
    });
    expect(enqueue).toHaveBeenCalledWith({ jobId: result.response.sandboxId, expectedStep: "ensure-sandbox" }, undefined);
    const latest = await getLatestCloudAgentBoxWarmJob(db, auth.workspaceId, cloudAgentId);
    expect(latest?.id).toBe(result.response.sandboxId);
    expect(latest?.request?.mountPaths).toEqual(["/workspace"]);
  });

  it("persists broker identity in the warm-job request so it survives the queue hop (#125)", async () => {
    setCloudAgentBoxWarmTransport(vi.fn(async () => undefined));
    const result = await startCloudAgentBoxWarmViaQueue(makeDeps(), {
      auth, cloudAgentId, workspaceToken: null, mountPaths: ["/workspace"],
      workspaceKey: "wsk_explicit-workspace",
      brokerName: "cloud-00000000",
    });
    expect(result.status).toBe(202);
    const latest = await getLatestCloudAgentBoxWarmJob(db, auth.workspaceId, cloudAgentId);
    expect(latest?.request?.workspaceKey).toBe("wsk_explicit-workspace");
    expect(latest?.request?.brokerName).toBe("cloud-00000000");

    // And omitted identity stays absent — no empty-string pollution.
    const plain = await startCloudAgentBoxWarmViaQueue(makeDeps(), {
      auth, cloudAgentId, workspaceToken: null, mountPaths: ["/workspace"],
    });
    expect(plain.status).toBe(202);
    const plainJob = await getLatestCloudAgentBoxWarmJob(db, auth.workspaceId, cloudAgentId);
    expect(plainJob?.request).not.toHaveProperty("workspaceKey");
    expect(plainJob?.request).not.toHaveProperty("brokerName");
  });

  it("readViaQueue reports warming while a job is pending", async () => {
    setCloudAgentBoxWarmTransport(vi.fn(async () => undefined));
    const deps = makeDeps();
    await startCloudAgentBoxWarmViaQueue(deps, { auth, cloudAgentId, workspaceToken: null, mountPaths: ["/workspace"] });
    const latest = await getLatestCloudAgentBoxWarmJob(db, auth.workspaceId, cloudAgentId);
    expect(latest?.id).toBeTruthy();
    await db
      .update(cloudAgentBoxWarmJobs)
      .set({ createdAt: testNow })
      .where(eq(cloudAgentBoxWarmJobs.id, latest!.id));
    const response = await readCloudAgentBoxViaQueue(deps, { auth, cloudAgentId, workspaceToken: null, mountPaths: ["/workspace"] });
    expect(response.status).toBe("warming");
    expect(response.phase).toBe("queued");
    expect(response.etaMs).toBe(300_000);
  });

  it("readViaQueue maps warm checkpoints to public phase values", async () => {
    const job = await createCloudAgentBoxWarmJob(db, {
      workspaceId: auth.workspaceId,
      cloudAgentId,
      userId: auth.userId,
      organizationId: auth.organizationId,
      sandboxId: "sbx_phase",
      request: { mountPaths: ["/workspace"] },
    });
    await db
      .update(cloudAgentBoxWarmJobs)
      .set({ status: "running", currentStep: "flush-relayfile", createdAt: testNow })
      .where(eq(cloudAgentBoxWarmJobs.id, job.id));

    const response = await readCloudAgentBoxViaQueue(makeDeps(), {
      auth,
      cloudAgentId,
      workspaceToken: null,
      mountPaths: ["/workspace"],
    });

    expect(response).toMatchObject({
      sandboxId: "sbx_phase",
      status: "warming",
      currentStep: "flush-relayfile",
      phase: "cloning",
      etaMs: 300_000,
    });
  });

  it("readViaQueue defers to readCloudAgentBox when no job pending (box_not_found)", async () => {
    await expect(
      readCloudAgentBoxViaQueue(makeDeps(), { auth, cloudAgentId, workspaceToken: null }),
    ).rejects.toBeInstanceOf(CloudAgentBoxError);
  });

  it("readViaQueue suppresses the warm-deadline: no pending job + an expired warming row stays warming, not timed-out", async () => {
    // #1384: the queue GET must NOT apply the legacy 300s ASYNC_WARM_DEADLINE
    // heuristic — job state + DLQ own failure detection. A long-but-progressing
    // warm (expired-by-the-old-deadline) must keep reporting `warming`.
    const updateSandbox = vi.fn(async () => undefined);
    const deps = {
      ...makeDeps(),
      // Placeholder id ("boxwarm_…") so readCloudAgentBox skips the in-sandbox
      // env pre-read; row is warming + expired vs deps.now() (2026-05-29T12:00).
      findStickySandbox: vi.fn(async () => ({
        id: "boxwarm_qexp",
        status: "warming",
        brokerPort: null,
        error: null,
        expectedReadyBy: new Date("2026-05-29T11:00:00.000Z"),
      })),
      updateSandbox,
    } as unknown as CloudAgentBoxDeps;

    // No job created → getLatest returns null → falls through to
    // readCloudAgentBox(enforceWarmDeadline:false).
    const response = await readCloudAgentBoxViaQueue(deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
      mountPaths: ["/workspace"],
      workspaceSource: { kind: "relayfile" },
    });

    expect(response.status).toBe("warming");
    expect(updateSandbox).not.toHaveBeenCalled(); // NOT flipped to failed/timed-out
  });

  it("readViaQueue reconciles a terminal ready job over a stale warming row", async () => {
    const job = await createCloudAgentBoxWarmJob(db, {
      workspaceId: auth.workspaceId,
      cloudAgentId,
      userId: auth.userId,
      organizationId: auth.organizationId,
      sandboxId: "sbx_done",
    });
    await markCloudAgentBoxWarmJobReady(db, job.id, "sbx_done");

    const updateSandbox = vi.fn(async () => undefined);
    const deps = {
      ...makeDeps(),
      findStickySandbox: vi.fn(async () => ({
        id: "sbx_done",
        status: "warming",
        brokerPort: null,
        error: null,
        expectedReadyBy: new Date("2026-05-29T11:00:00.000Z"),
      })),
      updateSandbox,
    } as unknown as CloudAgentBoxDeps;

    const response = await readCloudAgentBoxViaQueue(deps, {
      auth,
      cloudAgentId,
      workspaceToken: null,
      mountPaths: ["/workspace"],
      workspaceSource: { kind: "relayfile" },
    });

    expect(response).toMatchObject({ sandboxId: "sbx_done", status: "ready", phase: "ready", etaMs: 0 });
    expect(updateSandbox).not.toHaveBeenCalled();
  });

  it("readViaQueue reports a failed terminal job when no sandbox row was materialized", async () => {
    const job = await createCloudAgentBoxWarmJob(db, {
      workspaceId: auth.workspaceId,
      cloudAgentId,
      userId: auth.userId,
      organizationId: auth.organizationId,
    });
    await markCloudAgentBoxWarmJobFailed(db, job.id, "provision failed");

    const response = await readCloudAgentBoxViaQueue(makeDeps(), {
      auth, cloudAgentId, workspaceToken: null, mountPaths: ["/workspace"],
    });

    expect(response).toMatchObject({
      sandboxId: job.id,
      status: "failed",
      error: "provision failed",
    });
  });
});
