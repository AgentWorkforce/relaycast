import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NangoSyncJob } from "@cloud/core/sync/nango-sync-job.js";

const mocks = vi.hoisted(() => ({
  resolveRelayWorkspace: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/integrations/relayfile-integration-push", () => ({
  resolveRelayfileCredentialWorkspaceId: mocks.resolveRelayWorkspace,
}));

const cfSymbol = Symbol.for("__cloudflare-context__");

const job: NangoSyncJob = {
  type: "nango_sync",
  provider: "github",
  connectionId: "conn-github-1",
  providerConfigKey: "github-relay",
  syncName: "fetch-open-prs",
  model: "PullRequest",
  modifiedAfter: "2026-05-18T19:52:17.576Z",
  cursor: null,
  workspaceId: "55555555-5555-4555-8555-555555555555",
};

function setWorkerEnv(env: Record<string, unknown>): void {
  (globalThis as Record<symbol, unknown>)[cfSymbol] = { env };
}

function clearWorkerEnv(): void {
  delete (globalThis as Record<symbol, unknown>)[cfSymbol];
}

beforeEach(() => {
  vi.resetAllMocks();
  clearWorkerEnv();
  mocks.resolveRelayWorkspace.mockResolvedValue("rw_test1234");
});

afterEach(() => {
  clearWorkerEnv();
});

describe("enqueueNangoSyncJob", () => {
  it("calls workflow.create with resolved relay workspace params", async () => {
    const createFn = vi.fn().mockResolvedValue(undefined);
    setWorkerEnv({ NANGO_SYNC_WORKFLOW: { create: createFn } });
    const { enqueueNangoSyncJob } = await import("./nango-sync-queue");

    await enqueueNangoSyncJob(job);

    expect(createFn).toHaveBeenCalledOnce();
    expect(createFn).toHaveBeenCalledWith({
      params: { ...job, relayWorkspaceId: "rw_test1234" },
    });
  });

  it("leaves the job untranslated when the helper returns the same id", async () => {
    const createFn = vi.fn().mockResolvedValue(undefined);
    mocks.resolveRelayWorkspace.mockResolvedValue(job.workspaceId);
    setWorkerEnv({ NANGO_SYNC_WORKFLOW: { create: createFn } });
    const { enqueueNangoSyncJob } = await import("./nango-sync-queue");

    await enqueueNangoSyncJob(job);

    expect(createFn).toHaveBeenCalledWith({ params: job });
  });

  it("does not recompute when the producer already set relayWorkspaceId", async () => {
    const createFn = vi.fn().mockResolvedValue(undefined);
    setWorkerEnv({ NANGO_SYNC_WORKFLOW: { create: createFn } });
    const { enqueueNangoSyncJob } = await import("./nango-sync-queue");

    await enqueueNangoSyncJob({ ...job, relayWorkspaceId: "rw_preset999" });

    expect(mocks.resolveRelayWorkspace).not.toHaveBeenCalled();
    expect(createFn).toHaveBeenCalledWith({
      params: { ...job, relayWorkspaceId: "rw_preset999" },
    });
  });

  it("enqueues untranslated with a warn when translation fails", async () => {
    const createFn = vi.fn().mockResolvedValue(undefined);
    mocks.resolveRelayWorkspace.mockRejectedValue(new Error("db unavailable"));
    setWorkerEnv({ NANGO_SYNC_WORKFLOW: { create: createFn } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { enqueueNangoSyncJob } = await import("./nango-sync-queue");

      await enqueueNangoSyncJob(job);

      expect(createFn).toHaveBeenCalledWith({ params: job });
      expect(warn).toHaveBeenCalledWith(
        "[nango-sync-queue] relay workspace translation failed; enqueueing untranslated",
        expect.objectContaining({ workspaceId: job.workspaceId }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("fails loudly outside the Worker runtime because the SQS fallback is removed", async () => {
    const { enqueueNangoSyncJob } = await import("./nango-sync-queue");

    await expect(enqueueNangoSyncJob(job)).rejects.toThrow(
      "NANGO_SYNC_WORKFLOW binding is not available",
    );
  });

  it("fails loudly when the Worker env lacks the workflow binding", async () => {
    setWorkerEnv({});
    const { enqueueNangoSyncJob } = await import("./nango-sync-queue");

    await expect(enqueueNangoSyncJob(job)).rejects.toThrow(
      "NANGO_SYNC_WORKFLOW binding is not available",
    );
  });
});
