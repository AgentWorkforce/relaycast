import { describe, expect, it, vi } from "vitest";

vi.mock("@cloud/core/provider-readiness.js", async () => {
  return import("../../../core/src/provider-readiness.ts");
});

vi.mock("@cloud/core/sync/nango-provider-parity.js", async () => {
  return import("../../../core/src/sync/nango-provider-parity.ts");
});

import {
  deriveProviderState,
  liveNangoInitialSyncSucceeded,
  summarizeProviderInitialSync,
  type WritebackHealth,
} from "./provider-status";
import type { ProviderReadiness } from "@cloud/core/provider-readiness.js";

const queuedInitialSync = {
  state: "queued" as const,
  enqueuedAt: "2026-05-27T12:00:00.000Z",
  startedAt: null,
  completedAt: null,
  failedAt: null,
  lastError: null,
  syncName: null,
  model: null,
  modifiedAfter: null,
  byModel: {},
};

function writeback(overrides: Partial<WritebackHealth> = {}): WritebackHealth {
  return {
    state: "healthy",
    lagSeconds: null,
    watermarkTs: null,
    lastError: null,
    deadLetteredEnvelopes: 0,
    deadLetteredOps: 0,
    failureCodes: {},
    webhookHealthy: null,
    webhookHealth: {
      healthy: false,
      lastEventAt: null,
      lastError: null,
    },
    ...overrides,
  };
}

describe("deriveProviderState", () => {
  it("promotes a stale queued placeholder when Relayfile reports runtime-visible sync state", () => {
    expect(
      deriveProviderState({
        initialSync: queuedInitialSync,
        writeback: writeback({ lagSeconds: 0 }),
      }),
    ).toBe("ready");
  });

  it("keeps a pre-OAuth placeholder pending when Relayfile has no provider status", () => {
    expect(
      deriveProviderState({
        initialSync: queuedInitialSync,
        writeback: writeback({ state: "unknown" }),
      }),
    ).toBe("pending");
  });
});

describe("summarizeProviderInitialSync", () => {
  it("uses generated enabled Nango model keys to aggregate multi-model provider readiness", () => {
    const readiness: ProviderReadiness = {
      oauthConnectedAt: "2026-05-27T11:59:00.000Z",
      lastAuthAt: "2026-05-27T11:59:00.000Z",
      connectionId: "conn_slack",
      providerConfigKey: "slack-relay",
      updatedAt: "2026-05-27T12:05:00.000Z",
      initialSync: {
        ...queuedInitialSync,
        byModel: {
          "slack-relay:fetch-channel-history:SlackMessage": {
            state: "complete" as const,
            providerConfigKey: "slack-relay",
            enqueuedAt: null,
            startedAt: "2026-05-27T12:01:00.000Z",
            completedAt: "2026-05-27T12:02:00.000Z",
            failedAt: null,
            lastError: null,
            syncName: "fetch-channel-history",
            model: "SlackMessage",
            modifiedAfter: null,
          },
          "slack-relay:fetch-users:SlackUser": {
            state: "complete" as const,
            providerConfigKey: "slack-relay",
            enqueuedAt: null,
            startedAt: "2026-05-27T12:02:00.000Z",
            completedAt: "2026-05-27T12:03:00.000Z",
            failedAt: null,
            lastError: null,
            syncName: "fetch-users",
            model: "SlackUser",
            modifiedAfter: null,
          },
          "slack-relay:fetch-channels:SlackChannel": {
            state: "running" as const,
            providerConfigKey: "slack-relay",
            enqueuedAt: null,
            startedAt: "2026-05-27T12:04:00.000Z",
            completedAt: null,
            failedAt: null,
            lastError: null,
            syncName: "fetch-channels",
            model: "SlackChannel",
            modifiedAfter: null,
          },
        },
      },
    };

    expect(
      summarizeProviderInitialSync({
        readiness,
        providerConfigKey: "slack-relay",
      }).state,
    ).toBe("running");

    readiness.initialSync.byModel[
      "slack-relay:fetch-channels:SlackChannel"
    ].completedAt = "2026-05-27T12:05:00.000Z";
    expect(
      summarizeProviderInitialSync({
        readiness,
        providerConfigKey: "slack-relay",
      }),
    ).toMatchObject({
      state: "complete",
      completedAt: "2026-05-27T12:05:00.000Z",
    });

    readiness.initialSync.byModel["slack-relay:fetch-users:SlackUser"].state =
      "running";
    readiness.initialSync.byModel[
      "slack-relay:fetch-users:SlackUser"
    ].startedAt = "2026-05-27T12:06:00.000Z";
    expect(
      summarizeProviderInitialSync({
        readiness,
        providerConfigKey: "slack-relay",
      }),
    ).toMatchObject({
      state: "complete",
      completedAt: "2026-05-27T12:05:00.000Z",
    });

    readiness.initialSync.byModel["slack-relay:fetch-users:SlackUser"].state =
      "failed";
    readiness.initialSync.byModel[
      "slack-relay:fetch-users:SlackUser"
    ].failedAt = "2026-05-27T12:07:00.000Z";
    readiness.initialSync.byModel[
      "slack-relay:fetch-users:SlackUser"
    ].lastError = "incremental users failed";
    expect(
      summarizeProviderInitialSync({
        readiness,
        providerConfigKey: "slack-relay",
      }),
    ).toMatchObject({
      state: "complete",
      completedAt: "2026-05-27T12:05:00.000Z",
      failedAt: null,
      lastError: null,
    });
  });
});

describe("liveNangoInitialSyncSucceeded", () => {
  it("returns true when every live Nango sync reports SUCCESS", () => {
    expect(
      liveNangoInitialSyncSucceeded({
        ok: true,
        syncs: [
          { status: "SUCCESS" },
          { status: "SUCCESS" },
          { status: "SUCCESS" },
        ],
      }),
    ).toBe(true);
  });

  it("returns false when any sync is not SUCCESS", () => {
    expect(
      liveNangoInitialSyncSucceeded({
        ok: true,
        syncs: [{ status: "SUCCESS" }, { status: "RUNNING" }],
      }),
    ).toBe(false);
    expect(
      liveNangoInitialSyncSucceeded({
        ok: true,
        syncs: [{ status: "SUCCESS" }, { status: null }],
      }),
    ).toBe(false);
  });

  it("returns false for an empty, failed, or absent schedule (no positive evidence)", () => {
    expect(liveNangoInitialSyncSucceeded({ ok: true, syncs: [] })).toBe(false);
    expect(
      liveNangoInitialSyncSucceeded({ ok: false, syncs: [{ status: "SUCCESS" }] }),
    ).toBe(false);
    expect(liveNangoInitialSyncSucceeded(null)).toBe(false);
  });

  it("promotes a stale queued blob to ready via deriveProviderState when live syncs succeeded", () => {
    // Simulates the status-route reconciliation: persisted blob stuck at
    // `queued` (sync-completion pipeline degraded) but live Nango says SUCCESS.
    const schedules = {
      ok: true,
      syncs: [{ status: "SUCCESS" }, { status: "SUCCESS" }],
    };
    const queuedInitialSync: ProviderReadiness["initialSync"] = {
      state: "queued",
      enqueuedAt: null,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      lastError: null,
      syncName: null,
      model: null,
      modifiedAfter: null,
      byModel: {},
    };
    // Mirror the real prod case: writeback is `lagging` (lag 0s), so the
    // existing healthy-writeback shortcut in deriveProviderState does NOT fire
    // and a queued blob derives to `pending`. This is exactly where the live
    // Nango reconciliation is the only thing that can promote to ready.
    const wb = writeback({
      state: "lagging",
      lagSeconds: 0,
      watermarkTs: "2026-06-13T10:00:00.000Z",
    });

    const stale = liveNangoInitialSyncSucceeded(schedules) &&
      queuedInitialSync.state !== "complete";
    expect(stale).toBe(true);

    const promotedState = stale
      ? deriveProviderState({
          initialSync: { ...queuedInitialSync, state: "complete" },
          writeback: wb,
        })
      : deriveProviderState({ initialSync: queuedInitialSync, writeback: wb });
    expect(promotedState).toBe("ready");

    // Without the promotion the same blob derives to pending.
    expect(
      deriveProviderState({ initialSync: queuedInitialSync, writeback: wb }),
    ).toBe("pending");
  });
});
