import { describe, expect, it, vi } from "vitest";

vi.mock("@cloud/core/provider-readiness.js", async () => {
  return import("../../../core/src/provider-readiness.ts");
});

vi.mock("@cloud/core/sync/nango-provider-parity.js", async () => {
  return import("../../../core/src/sync/nango-provider-parity.ts");
});

import { buildPendingProviderMetadata } from "@cloud/core/provider-readiness.js";
import {
  recoverStalePendingNangoSyncSubscription,
} from "./nango-sync-subscription-recovery";
import type { WorkspaceIntegrationRecord } from "./workspace-integrations";

function integration(
  overrides: Partial<WorkspaceIntegrationRecord> = {},
): WorkspaceIntegrationRecord {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    workspaceId: "rw_7ccfea89",
    provider: "slack",
    connectionId: "conn-slack-1",
    providerConfigKey: "slack-relay",
    installationId: null,
    metadata: buildPendingProviderMetadata({
      connectionId: "conn-slack-1",
      providerConfigKey: "slack-relay",
      at: "2026-06-06T12:05:00.000Z",
    }),
    writebackDispatchVia: "bridge",
    createdAt: new Date("2026-06-06T12:00:00.000Z"),
    updatedAt: new Date("2026-06-06T12:05:00.000Z"),
    ...overrides,
  };
}

describe("recoverStalePendingNangoSyncSubscription", () => {
  it("re-registers schedules for an active OAuth connection stuck pending past the threshold", async () => {
    const getConnection = vi.fn().mockResolvedValue({
      backend: "nango",
      connectionId: "conn-slack-1",
      status: "active",
    });
    const getScheduleStatuses = vi.fn().mockResolvedValue({
      ok: true,
      syncs: [
        {
          name: "fetch-channel-history",
          status: "PAUSED",
          frequency: null,
          nextScheduledSyncAt: null,
          finishedAt: null,
        },
      ],
    });
    const pauseSchedules = vi.fn().mockResolvedValue({
      ok: true,
      syncs: ["fetch-channel-history", "fetch-users", "fetch-channels"],
    });
    const startSchedules = vi.fn().mockResolvedValue({
      ok: true,
      syncs: ["fetch-channel-history", "fetch-users", "fetch-channels"],
    });
    const triggerSyncs = vi.fn().mockResolvedValue({ ok: true });

    const result = await recoverStalePendingNangoSyncSubscription(
      integration(),
      {
        now: () => Date.parse("2026-06-14T12:05:00.000Z"),
        fetchProviderSyncStatus: vi.fn().mockResolvedValue(null),
        getConnection,
        getScheduleStatuses,
        pauseSchedules,
        startSchedules,
        triggerSyncs,
      },
    );

    expect(result).toMatchObject({
      status: "re_registered",
      provider: "slack",
      connectionId: "conn-slack-1",
      providerConfigKey: "slack-relay",
      lastEventAt: "2026-06-06T12:05:00.000Z",
      staleForMs: 691_200_000,
      syncs: ["fetch-channel-history", "fetch-users", "fetch-channels"],
      scheduleStatuses: [{ name: "fetch-channel-history", status: "PAUSED" }],
      slackDiscoveryTriggered: true,
    });
    expect(getConnection).toHaveBeenCalledWith("conn-slack-1", "slack-relay", {
      provider: "slack",
    });
    expect(pauseSchedules).toHaveBeenCalledWith({
      providerConfigKey: "slack-relay",
      connectionId: "conn-slack-1",
      syncs: ["fetch-channel-history", "fetch-users", "fetch-channels"],
    });
    expect(startSchedules).toHaveBeenCalledWith({
      providerConfigKey: "slack-relay",
      connectionId: "conn-slack-1",
      syncs: ["fetch-channel-history", "fetch-users", "fetch-channels"],
    });
    expect(triggerSyncs).toHaveBeenCalledWith({
      providerConfigKey: "slack-relay",
      connectionId: "conn-slack-1",
      syncs: ["fetch-users", "fetch-channels"],
      syncMode: "full_refresh",
    });
  });

  it("does not touch Nango when the pending connection is still fresh", async () => {
    const getConnection = vi.fn();
    const pauseSchedules = vi.fn();
    const startSchedules = vi.fn();

    const result = await recoverStalePendingNangoSyncSubscription(
      integration({
        metadata: buildPendingProviderMetadata({
          connectionId: "conn-slack-1",
          providerConfigKey: "slack-relay",
          at: "2026-06-14T11:30:00.000Z",
        }),
      }),
      {
        now: () => Date.parse("2026-06-14T12:05:00.000Z"),
        fetchProviderSyncStatus: vi.fn().mockResolvedValue(null),
        getConnection,
        pauseSchedules,
        startSchedules,
      },
    );

    expect(result).toMatchObject({
      status: "not_stale_pending",
      pendingState: "pending",
      staleForMs: 2_100_000,
    });
    expect(getConnection).not.toHaveBeenCalled();
    expect(pauseSchedules).not.toHaveBeenCalled();
    expect(startSchedules).not.toHaveBeenCalled();
  });

  it("skips re-registration when the upstream OAuth connection is inactive", async () => {
    const pauseSchedules = vi.fn();
    const startSchedules = vi.fn();

    const result = await recoverStalePendingNangoSyncSubscription(
      integration(),
      {
        now: () => Date.parse("2026-06-14T12:05:00.000Z"),
        fetchProviderSyncStatus: vi.fn().mockResolvedValue(null),
        getConnection: vi.fn().mockResolvedValue({
          backend: "nango",
          connectionId: "conn-slack-1",
          status: "inactive",
        }),
        pauseSchedules,
        startSchedules,
      },
    );

    expect(result).toMatchObject({
      status: "skipped_inactive_oauth",
      error: "Nango connection is inactive",
    });
    expect(pauseSchedules).not.toHaveBeenCalled();
    expect(startSchedules).not.toHaveBeenCalled();
  });
});
