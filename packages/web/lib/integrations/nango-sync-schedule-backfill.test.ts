import { describe, expect, it, vi } from "vitest";
import {
  backfillNangoSyncSchedules,
  type NangoSyncScheduleBackfillCandidate,
} from "./nango-sync-schedule-backfill";

const baseCandidate: NangoSyncScheduleBackfillCandidate = {
  id: "00000000-0000-0000-0000-000000000001",
  workspaceId: "rw_7ca2b192",
  provider: "slack",
  connectionId: "conn-slack-1",
  providerConfigKey: "slack-relay",
};

function candidate(
  overrides: Partial<NangoSyncScheduleBackfillCandidate> = {},
): NangoSyncScheduleBackfillCandidate {
  return { ...baseCandidate, ...overrides };
}

describe("backfillNangoSyncSchedules", () => {
  it("dry-run is strictly read-only: reports would_start without calling /sync/start", async () => {
    const startSchedules = vi.fn();
    const getScheduleStatuses = vi.fn().mockResolvedValue({
      ok: true,
      syncs: [
        { name: "slack-messages", status: "PAUSED", frequency: null, nextScheduledSyncAt: null, finishedAt: null },
      ],
    });

    const summary = await backfillNangoSyncSchedules(
      {},
      {
        listCandidates: async () => [candidate()],
        enabledSyncNames: () => ["slack-messages"],
        getScheduleStatuses,
        startSchedules,
      },
    );

    expect(summary.dryRun).toBe(true);
    expect(summary.results).toEqual([
      expect.objectContaining({
        provider: "slack",
        status: "would_start",
        syncs: ["slack-messages"],
        scheduleStatuses: [{ name: "slack-messages", status: "PAUSED" }],
      }),
    ]);
    expect(startSchedules).not.toHaveBeenCalled();
  });

  it("apply mode starts schedules through the same args as the auth-webhook path", async () => {
    const startSchedules = vi.fn().mockResolvedValue({ ok: true, syncs: ["slack-messages"] });

    const summary = await backfillNangoSyncSchedules(
      { dryRun: false },
      {
        listCandidates: async () => [candidate()],
        enabledSyncNames: () => ["slack-messages"],
        getScheduleStatuses: vi.fn().mockResolvedValue({ ok: true, syncs: [] }),
        startSchedules,
      },
    );

    expect(startSchedules).toHaveBeenCalledTimes(1);
    expect(startSchedules).toHaveBeenCalledWith({
      providerConfigKey: "slack-relay",
      connectionId: "conn-slack-1",
      syncs: ["slack-messages"],
    });
    expect(summary.results[0]).toMatchObject({ status: "started" });
    expect(summary.started).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it("skips providers without generated syncs and rows without a config key", async () => {
    const startSchedules = vi.fn();

    const summary = await backfillNangoSyncSchedules(
      { dryRun: false },
      {
        listCandidates: async () => [
          candidate({ id: "row-x", provider: "x", providerConfigKey: "x-relay" }),
          candidate({ id: "row-nokey", provider: "notion", providerConfigKey: null }),
        ],
        enabledSyncNames: () => [],
        getScheduleStatuses: vi.fn(),
        startSchedules,
      },
    );

    expect(summary.results.map((entry) => entry.status)).toEqual([
      "skipped_no_syncs",
      "skipped_no_config_key",
    ]);
    expect(summary.skipped).toBe(2);
    expect(startSchedules).not.toHaveBeenCalled();
  });

  it("records per-row failures without stopping the batch", async () => {
    const startSchedules = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 502, syncs: ["notion-pages"] })
      .mockResolvedValueOnce({ ok: true, syncs: ["linear-issues"] });

    const summary = await backfillNangoSyncSchedules(
      { dryRun: false },
      {
        listCandidates: async () => [
          candidate({ id: "row-notion", provider: "notion", providerConfigKey: "notion-relay" }),
          candidate({ id: "row-linear", provider: "linear", providerConfigKey: "linear-relay" }),
        ],
        enabledSyncNames: (key) => (key === "notion-relay" ? ["notion-pages"] : ["linear-issues"]),
        getScheduleStatuses: vi.fn().mockResolvedValue({ ok: true, syncs: [] }),
        startSchedules,
      },
    );

    expect(summary.results.map((entry) => entry.status)).toEqual(["failed", "started"]);
    expect(summary.failed).toBe(1);
    expect(summary.started).toBe(1);
    expect(summary.results[0]?.error).toContain("502");
  });

  it("status-snapshot failures are non-fatal in apply mode", async () => {
    const startSchedules = vi.fn().mockResolvedValue({ ok: true, syncs: ["slack-messages"] });

    const summary = await backfillNangoSyncSchedules(
      { dryRun: false },
      {
        listCandidates: async () => [candidate()],
        enabledSyncNames: () => ["slack-messages"],
        getScheduleStatuses: vi.fn().mockRejectedValue(new Error("nango unreachable")),
        startSchedules,
      },
    );

    expect(summary.results[0]).toMatchObject({ status: "started", scheduleStatuses: [] });
  });
});
