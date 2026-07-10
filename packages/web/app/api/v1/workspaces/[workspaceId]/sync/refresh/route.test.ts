import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The real record-writer backfill. Tests (1)-(3) override the mock's
// implementation to control auth/per-provider behavior; test (4) lets the
// mock delegate to this real function so it exercises the genuine
// monotonic-merge + canonicalize + writeManagedFile dedup path and asserts
// the EXACT LAYOUT-advertised discovery paths + byte-stability.
const realRecordWriter =
  await vi.importActual<typeof import("@cloud/core/sync/record-writer.js")>(
    "@cloud/core/sync/record-writer.js",
  );

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  hasWorkspaceAccess: vi.fn(),
  resolveWorkspaceUuid: vi.fn(),
  listWorkspaceIntegrations: vi.fn(),
  isWorkspaceIntegrationProvider: vi.fn(),
  createGitHubRelayfileClient: vi.fn(),
  ensureProviderDiscoveryContractReport: vi.fn(),
  recoverStalePendingNangoSyncSubscription: vi.fn(),
  enqueueNangoSyncJob: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/request-auth")>()),
  resolveRequestAuth: mocks.resolveRequestAuth,
}));

vi.mock("@/lib/integrations/integration-route-handler", () => ({
  hasWorkspaceAccess: mocks.hasWorkspaceAccess,
  resolveWorkspaceUuid: mocks.resolveWorkspaceUuid,
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  listWorkspaceIntegrations: mocks.listWorkspaceIntegrations,
}));

vi.mock("@/lib/integrations/providers", () => ({
  getProviderConfigKey: vi.fn((provider: string) => `${provider}-relay`),
  isWorkspaceIntegrationProvider: mocks.isWorkspaceIntegrationProvider,
}));

vi.mock("@/lib/integrations/github-relayfile", () => ({
    enrichGitHubWatchPayload: vi.fn((data: Record<string, unknown>) => data),
  createGitHubRelayfileClient: mocks.createGitHubRelayfileClient,
}));

vi.mock("@cloud/core/sync/record-writer.js", () => ({
  ensureProviderDiscoveryContractReport:
    mocks.ensureProviderDiscoveryContractReport,
}));

vi.mock("@cloud/core/sync/nango-provider-parity.js", () => ({
  enabledGeneratedNangoProviderModelsForProviderConfigKey: (
    providerConfigKey: string,
  ) =>
    providerConfigKey === "neon-relay"
      ? [
          ["fetch-topology", "NeonOrganization"],
          ["fetch-topology", "NeonProject"],
          ["fetch-topology", "NeonBranch"],
          ["fetch-topology", "NeonEndpoint"],
          ["fetch-topology", "NeonSpendingLimit"],
          ["fetch-operations", "NeonOperation"],
          ["fetch-consumption", "NeonProjectConsumption"],
          ["fetch-consumption", "NeonBranchConsumption"],
          ["fetch-advisor-issues", "NeonAdvisorIssue"],
        ].map(([sync, model]) => ({
          provider: "neon-relay",
          sync,
          model,
          key: `neon-relay:${sync}:${model}`,
          enabled: true,
          classification: "enabled",
          reason: "test",
        }))
      : [],
}));

vi.mock("@/lib/integrations/nango-sync-subscription-recovery", () => ({
  recoverStalePendingNangoSyncSubscription:
    mocks.recoverStalePendingNangoSyncSubscription,
}));

vi.mock("@/lib/integrations/nango-sync-queue", () => ({
  enqueueNangoSyncJob: mocks.enqueueNangoSyncJob,
}));

import {
  POST,
  SYNC_REFRESH_PROVIDER_TIMEOUT_MS,
  SYNC_REFRESH_REQUEST_TIMEOUT_MS,
} from "./route";

const WORKSPACE_ID = "rw_fc7b534b";

type RecordedWrite = { path: string; content: string };

function makeInMemoryClient() {
  const files = new Map<string, string>();
  const writes: RecordedWrite[] = [];
  const deletes: string[] = [];
  return {
    files,
    writes,
    deletes,
    async writeFile(input: { path: string; content: string }) {
      writes.push({ path: input.path, content: input.content });
      files.set(input.path, input.content);
    },
    async deleteFile(input: { path: string }) {
      deletes.push(input.path);
      files.delete(input.path);
    },
    async readFile(_workspaceId: string, path: string) {
      if (files.has(path)) {
        return { content: files.get(path), revision: `rev:${path}` };
      }
      const err = new Error("not found") as Error & { status: number };
      err.status = 404;
      throw err;
    },
  };
}

function request(): NextRequest {
  return new NextRequest(
    `https://cloud.test/api/v1/workspaces/${WORKSPACE_ID}/sync/refresh`,
    { method: "POST", headers: { authorization: "Bearer access-token" } },
  );
}

function params() {
  return { params: Promise.resolve({ workspaceId: WORKSPACE_ID }) };
}

const memberAuth = {
  userId: "user-1",
  workspaceId: WORKSPACE_ID,
  organizationId: "org-1",
  source: "token" as const,
  scopes: ["cli:auth"],
};

describe("POST /api/v1/workspaces/[workspaceId]/sync/refresh", () => {
  let client: ReturnType<typeof makeInMemoryClient>;

  beforeEach(() => {
    vi.resetAllMocks();
    client = makeInMemoryClient();
    mocks.resolveRequestAuth.mockResolvedValue(memberAuth);
    mocks.hasWorkspaceAccess.mockReturnValue(true);
    mocks.resolveWorkspaceUuid.mockImplementation(async (raw: string) => raw);
    mocks.isWorkspaceIntegrationProvider.mockReturnValue(true);
    mocks.createGitHubRelayfileClient.mockReturnValue(client);
    mocks.listWorkspaceIntegrations.mockResolvedValue([]);
    // Default: delegate to the REAL backfill so materialization tests are
    // non-vacuous. Auth/per-provider tests override below.
    mocks.ensureProviderDiscoveryContractReport.mockImplementation(
      (c: never, provider: string, workspaceId: string) =>
        realRecordWriter.ensureProviderDiscoveryContractReport(
          c,
          provider,
          workspaceId,
        ),
    );
    mocks.recoverStalePendingNangoSyncSubscription.mockImplementation(
      async (integration: { provider: string }) => ({
        provider: integration.provider,
        status: "skipped_not_nango",
        syncs: [],
        scheduleStatuses: [],
      }),
    );
    mocks.enqueueNangoSyncJob.mockResolvedValue(undefined);
  });

  it("(1) unauthenticated -> 401 and NO side effect before auth", async () => {
    mocks.resolveRequestAuth.mockResolvedValue(null);

    const res = await POST(request(), params());

    expect(res.status).toBe(401);
    expect(mocks.listWorkspaceIntegrations).not.toHaveBeenCalled();
    expect(mocks.ensureProviderDiscoveryContractReport).not.toHaveBeenCalled();
  });

  it("(2) cross-tenant / non-member -> 403 and NO side effect", async () => {
    mocks.resolveRequestAuth.mockResolvedValue({
      ...memberAuth,
      userId: "intruder",
      workspaceId: "rw_othertenant",
    });
    mocks.hasWorkspaceAccess.mockReturnValue(false);

    const res = await POST(request(), params());

    expect(res.status).toBe(403);
    expect(mocks.listWorkspaceIntegrations).not.toHaveBeenCalled();
    expect(mocks.ensureProviderDiscoveryContractReport).not.toHaveBeenCalled();
  });

  it("(3) one provider throws -> 200 with per-provider continue (NOT 500)", async () => {
    mocks.listWorkspaceIntegrations.mockResolvedValue([
      { workspaceId: WORKSPACE_ID, provider: "linear" },
      { workspaceId: WORKSPACE_ID, provider: "notion" },
    ]);
    mocks.ensureProviderDiscoveryContractReport.mockImplementation(
      async (_c: never, provider: string) => {
        if (provider === "notion") {
          throw new Error("notion backfill blew up");
        }
        return {
          errors: [],
          status: "complete",
          samplingWarnings: [],
          indexedResources: 1,
          sampledResources: 1,
        };
      },
    );

    const res = await POST(request(), params());

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspaceId: string;
      refreshed: Array<{
        provider: string;
        discoveryBackfilled: boolean;
        discoveryBackfillStatus: string;
        errors: number;
        samplingWarnings: unknown[];
      }>;
    };
    expect(body.workspaceId).toBe(WORKSPACE_ID);
    expect(body.refreshed).toEqual([
      {
        provider: "linear",
        discoveryBackfilled: true,
        discoveryBackfillStatus: "complete",
        errors: 0,
        durationMs: expect.any(Number),
        samplingWarnings: [],
      },
      {
        provider: "notion",
        discoveryBackfilled: false,
        discoveryBackfillStatus: "failed",
        errors: 1,
        durationMs: expect.any(Number),
        samplingWarnings: [],
      },
    ]);
  });

  it("(4) returns non-fatal sampling warnings when indexed rows cannot be sampled", async () => {
    mocks.listWorkspaceIntegrations.mockResolvedValue([
      { workspaceId: WORKSPACE_ID, provider: "jira" },
    ]);
    mocks.ensureProviderDiscoveryContractReport.mockResolvedValue({
      errors: [],
      status: "degraded",
      indexedResources: 1,
      sampledResources: 0,
      samplingWarnings: [
        {
          provider: "jira",
          resourceName: "issues",
          resourcePath: "/jira/issues",
          indexPath: "/jira/issues/_index.json",
          indexRows: 1,
          sampledIds: 1,
          sampledRecords: 0,
          reason: "skipped-no-alias-match",
        },
      ],
    });

    const res = await POST(request(), params());

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      refreshed: Array<{
        provider: string;
        discoveryBackfilled: boolean;
        discoveryBackfillStatus: string;
        errors: number;
        samplingWarnings: unknown[];
      }>;
    };
    expect(body.refreshed).toEqual([
      {
        provider: "jira",
        discoveryBackfilled: true,
        discoveryBackfillStatus: "degraded",
        errors: 0,
        durationMs: expect.any(Number),
        samplingWarnings: [
          {
            resourceName: "issues",
            resourcePath: "/jira/issues",
            indexPath: "/jira/issues/_index.json",
            indexRows: 1,
            sampledIds: 1,
            sampledRecords: 0,
            reason: "skipped-no-alias-match",
          },
        ],
      },
    ]);
  });

  it("(5) materializes EXACT LAYOUT-advertised paths and a 2nd POST is byte-stable (zero further writes)", async () => {
    mocks.listWorkspaceIntegrations.mockResolvedValue([
      { workspaceId: WORKSPACE_ID, provider: "linear" },
    ]);

    const res1 = await POST(request(), params());
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as {
      refreshed: Array<{
        provider: string;
        discoveryBackfilled: boolean;
        discoveryBackfillStatus: string;
        errors: number;
        samplingWarnings: unknown[];
      }>;
    };
    expect(body1.refreshed).toEqual([
      {
        provider: "linear",
        discoveryBackfilled: true,
        discoveryBackfillStatus: "skipped-no-records",
        errors: 0,
        durationMs: expect.any(Number),
        samplingWarnings: [],
      },
    ]);

    // EXACT LAYOUT-advertised discovery paths for the linear adapter.
    expect(client.files.has("/discovery/linear/issues/.schema.json")).toBe(
      true,
    );
    expect(
      client.files.has("/discovery/linear/issues/.create.example.json"),
    ).toBe(true);
    expect(client.files.has("/linear/LAYOUT.md")).toBe(true);

    const writesAfterFirst = client.writes.length;
    expect(writesAfterFirst).toBeGreaterThan(0);
    const snapshot = new Map(client.files);

    // Immediate second POST: idempotent / byte-stable -> ZERO new writes.
    const res2 = await POST(request(), params());
    expect(res2.status).toBe(200);
    expect(client.writes.length).toBe(writesAfterFirst);
    expect(client.deletes.length).toBe(0);
    for (const [path, content] of snapshot) {
      expect(client.files.get(path)).toBe(content);
    }
  });

  it("(6) re-registers a stale pending Nango sync subscription during manual refresh", async () => {
    mocks.listWorkspaceIntegrations.mockResolvedValue([
      {
        id: "row-slack",
        workspaceId: WORKSPACE_ID,
        provider: "slack",
        connectionId: "conn-slack-1",
        providerConfigKey: "slack-relay",
        metadata: {},
      },
    ]);
    mocks.ensureProviderDiscoveryContractReport.mockResolvedValue({
      errors: [],
      status: "complete",
      samplingWarnings: [],
      indexedResources: 1,
      sampledResources: 1,
    });
    mocks.recoverStalePendingNangoSyncSubscription.mockResolvedValue({
      provider: "slack",
      status: "re_registered",
      connectionId: "conn-slack-1",
      providerConfigKey: "slack-relay",
      syncs: ["fetch-channel-history", "fetch-users", "fetch-channels"],
      pendingState: "pending",
      lastEventAt: "2026-06-06T12:05:00.000Z",
      staleForMs: 691_200_000,
      scheduleStatuses: [
        { name: "fetch-channel-history", status: "PAUSED" },
      ],
    });

    const res = await POST(request(), params());

    expect(res.status).toBe(200);
    expect(mocks.recoverStalePendingNangoSyncSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        provider: "slack",
        connectionId: "conn-slack-1",
        providerConfigKey: "slack-relay",
      }),
    );
    const body = (await res.json()) as {
      refreshed: Array<{
        provider: string;
        syncSubscriptionRecovery?: {
          status: string;
          syncs: string[];
          lastEventAt: string;
        };
      }>;
    };
    expect(body.refreshed[0]).toMatchObject({
      provider: "slack",
      discoveryBackfillStatus: "complete",
      errors: 0,
      syncSubscriptionRecovery: {
        status: "re_registered",
        syncs: ["fetch-channel-history", "fetch-users", "fetch-channels"],
        lastEventAt: "2026-06-06T12:05:00.000Z",
      },
    });
  });

  it("(7) queues INITIAL materialization backfill jobs for enabled provider models", async () => {
    mocks.listWorkspaceIntegrations.mockResolvedValue([
      {
        id: "row-neon",
        workspaceId: WORKSPACE_ID,
        provider: "neon",
        connectionId: "14165418-cd8b-4c38-a360-26feddcb6040",
        providerConfigKey: "neon-relay",
        metadata: {},
      },
    ]);
    mocks.ensureProviderDiscoveryContractReport.mockResolvedValue({
      errors: [],
      status: "skipped-no-records",
      samplingWarnings: [],
      indexedResources: 0,
      sampledResources: 0,
    });

    const res = await POST(request(), params());

    expect(res.status).toBe(200);
    expect(mocks.enqueueNangoSyncJob).toHaveBeenCalledTimes(9);
    expect(mocks.enqueueNangoSyncJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "nango_sync",
        provider: "neon",
        connectionId: "14165418-cd8b-4c38-a360-26feddcb6040",
        providerConfigKey: "neon-relay",
        syncName: "fetch-operations",
        model: "NeonOperation",
        modifiedAfter: null,
        syncType: "INITIAL",
        checkpoints: { from: null, to: null },
        cursor: null,
        workspaceId: WORKSPACE_ID,
      }),
    );
    const body = (await res.json()) as {
      refreshed: Array<{
        provider: string;
        materializationBackfill?: { status: string; jobsQueued: number };
      }>;
    };
    expect(body.refreshed[0]).toMatchObject({
      provider: "neon",
      materializationBackfill: {
        status: "queued",
        jobsQueued: 9,
      },
    });
  });

  it("(8) skips materialization backfill for non-Nango connection ids", async () => {
    mocks.listWorkspaceIntegrations.mockResolvedValue([
      {
        id: "row-neon",
        workspaceId: WORKSPACE_ID,
        provider: "neon",
        connectionId: "ca_5YtkH6snwxJW",
        providerConfigKey: "neon-relay",
        metadata: {},
      },
    ]);
    mocks.ensureProviderDiscoveryContractReport.mockResolvedValue({
      errors: [],
      status: "skipped-no-records",
      samplingWarnings: [],
      indexedResources: 0,
      sampledResources: 0,
    });

    const res = await POST(request(), params());

    expect(res.status).toBe(200);
    expect(mocks.enqueueNangoSyncJob).not.toHaveBeenCalled();
    const body = (await res.json()) as {
      refreshed: Array<{ materializationBackfill?: unknown }>;
    };
    expect(body.refreshed[0]).not.toHaveProperty("materializationBackfill");
  });

  it("(9) bounds a hung provider and still returns completed providers", async () => {
    vi.useFakeTimers();
    try {
      mocks.listWorkspaceIntegrations.mockResolvedValue([
        { workspaceId: WORKSPACE_ID, provider: "linear" },
        { workspaceId: WORKSPACE_ID, provider: "notion" },
      ]);
      mocks.ensureProviderDiscoveryContractReport.mockImplementation(
        async (_c: never, provider: string) => {
          if (provider === "linear") {
            await new Promise(() => undefined);
          }
          return {
            errors: [],
            status: "complete",
            samplingWarnings: [],
            indexedResources: 1,
            sampledResources: 1,
          };
        },
      );

      const pending = POST(request(), params());
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.ensureProviderDiscoveryContractReport).toHaveBeenCalledTimes(
        2,
      );
      await vi.advanceTimersByTimeAsync(SYNC_REFRESH_PROVIDER_TIMEOUT_MS);
      const res = await pending;

      expect(res.status).toBe(504);
      const body = (await res.json()) as {
        timedOut: boolean;
        errors: Array<{ provider?: string; reason: string }>;
        refreshed: Array<{
          provider: string;
          discoveryBackfilled: boolean;
          discoveryBackfillStatus: string;
          errors: number;
          durationMs: number;
          timedOut?: boolean;
          samplingWarnings: unknown[];
        }>;
      };
      expect(body.timedOut).toBe(true);
      expect(body.errors).toEqual([
        {
          provider: "linear",
          reason: "provider_timeout",
          message: `Discovery backfill timed out after ${SYNC_REFRESH_PROVIDER_TIMEOUT_MS}ms`,
          durationMs: SYNC_REFRESH_PROVIDER_TIMEOUT_MS,
        },
      ]);
      expect(body.refreshed).toEqual([
        {
          provider: "linear",
          discoveryBackfilled: false,
          discoveryBackfillStatus: "timeout",
          errors: 1,
          durationMs: SYNC_REFRESH_PROVIDER_TIMEOUT_MS,
          timedOut: true,
          samplingWarnings: [],
        },
        {
          provider: "notion",
          discoveryBackfilled: true,
          discoveryBackfillStatus: "complete",
          errors: 0,
          durationMs: expect.any(Number),
          samplingWarnings: [],
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("(10) bounds a hung integration listing with a structured request timeout", async () => {
    vi.useFakeTimers();
    try {
      mocks.listWorkspaceIntegrations.mockImplementation(
        async () => new Promise(() => undefined),
      );

      const pending = POST(request(), params());
      await vi.advanceTimersByTimeAsync(SYNC_REFRESH_REQUEST_TIMEOUT_MS);
      const res = await pending;

      expect(res.status).toBe(504);
      const body = (await res.json()) as {
        timedOut: boolean;
        durationMs: number;
        errors: Array<{ provider?: string; reason: string }>;
        refreshed: unknown[];
      };
      expect(body).toEqual({
        workspaceId: WORKSPACE_ID,
        refreshed: [],
        timedOut: true,
        durationMs: SYNC_REFRESH_REQUEST_TIMEOUT_MS,
        errors: [
          {
            reason: "request_timeout",
            message: `Sync refresh request timed out before integrations could be listed after ${SYNC_REFRESH_REQUEST_TIMEOUT_MS}ms`,
            durationMs: SYNC_REFRESH_REQUEST_TIMEOUT_MS,
          },
        ],
      });
      expect(mocks.ensureProviderDiscoveryContractReport).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
