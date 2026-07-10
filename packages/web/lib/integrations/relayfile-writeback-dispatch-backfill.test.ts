import { describe, expect, it, vi } from "vitest";
import {
  backfillRelayfileWritebackCf,
  type RelayfileWritebackCfBackfillCandidate,
} from "./relayfile-writeback-dispatch-backfill";

function candidate(
  overrides: Partial<RelayfileWritebackCfBackfillCandidate> = {},
): RelayfileWritebackCfBackfillCandidate {
  return {
    id: "integration-1",
    workspaceId: "rw_12345678",
    provider: "notion",
    connectionId: "conn_123",
    providerConfigKey: "notion-relay",
    installationId: null,
    metadata: { notionApiVersion: "2022-06-28" },
    writebackDispatchVia: "bridge",
    createdAt: new Date("2026-05-14T00:00:00.000Z"),
    updatedAt: new Date("2026-05-14T00:00:00.000Z"),
    ...overrides,
  };
}

describe("backfillRelayfileWritebackCf", () => {
  it("pushes the cf credential copy before flipping Postgres", async () => {
    const row = candidate();
    const pushCredential = vi.fn(async () => ({
      ok: true as const,
      provider: "notion" as const,
      status: 200,
    }));
    const activateCandidate = vi.fn(async () => true);
    const now = new Date("2026-05-14T12:00:00.000Z");

    const summary = await backfillRelayfileWritebackCf(
      { now: () => now },
      {
        listCandidates: async () => [row],
        pushCredential,
        activateCandidate,
      },
    );

    expect(pushCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: row.workspaceId,
        provider: "notion",
        connectionId: row.connectionId,
        writebackDispatchVia: "cf",
        updatedAt: now,
      }),
      { timeoutMs: undefined },
    );
    expect(activateCandidate).toHaveBeenCalledWith(row, now);
    expect(summary).toMatchObject({
      scanned: 1,
      activated: 1,
      resynced: 0,
      failed: 0,
    });
  });

  it("does not flip Postgres when RelayFile credential push fails", async () => {
    const activateCandidate = vi.fn(async () => true);

    const summary = await backfillRelayfileWritebackCf(
      {},
      {
        listCandidates: async () => [candidate()],
        pushCredential: async () => ({
          ok: false,
          provider: "notion",
          status: 500,
          error: "relayfile credential push returned 500",
          responseSnippet: "upstream unavailable",
        }),
        activateCandidate,
      },
    );

    expect(activateCandidate).not.toHaveBeenCalled();
    expect(summary.failed).toBe(1);
    expect(summary.results[0]).toMatchObject({
      status: "failed",
      error: "relayfile credential push returned 500: upstream unavailable",
    });
  });

  it("dry-runs without pushing or updating", async () => {
    const pushCredential = vi.fn();
    const activateCandidate = vi.fn();

    const summary = await backfillRelayfileWritebackCf(
      { dryRun: true },
      {
        listCandidates: async () => [candidate()],
        pushCredential,
        activateCandidate,
      },
    );

    expect(pushCredential).not.toHaveBeenCalled();
    expect(activateCandidate).not.toHaveBeenCalled();
    expect(summary.results).toEqual([
      {
        status: "would_activate",
        workspaceId: "rw_12345678",
        provider: "notion",
        connectionId: "conn_123",
      },
    ]);
  });

  it("resyncs rows that are already marked cf without updating them again", async () => {
    const pushCredential = vi.fn(async () => ({
      ok: true as const,
      provider: "slack" as const,
      status: 200,
    }));
    const activateCandidate = vi.fn(async () => true);

    const summary = await backfillRelayfileWritebackCf(
      {},
      {
        listCandidates: async () => [
          candidate({ provider: "slack", writebackDispatchVia: "cf" }),
        ],
        pushCredential,
        activateCandidate,
      },
    );

    expect(pushCredential).toHaveBeenCalledTimes(1);
    expect(activateCandidate).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      scanned: 1,
      activated: 0,
      resynced: 1,
      failed: 0,
    });
  });

  it("treats Google Mail as a Cloudflare writeback provider", async () => {
    const pushCredential = vi.fn(async () => ({
      ok: true as const,
      provider: "google-mail" as const,
      status: 200,
    }));
    const activateCandidate = vi.fn(async () => true);

    const summary = await backfillRelayfileWritebackCf(
      {},
      {
        listCandidates: async () => [
          candidate({
            provider: "google-mail-relay",
            providerConfigKey: "google-mail-relay",
          }),
        ],
        pushCredential,
        activateCandidate,
      },
    );

    expect(pushCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "google-mail",
        writebackDispatchVia: "cf",
      }),
      { timeoutMs: undefined },
    );
    expect(summary).toMatchObject({
      scanned: 1,
      activated: 1,
      failed: 0,
    });
  });

  it("skips providers that do not have Cloudflare writeback dispatch", async () => {
    const pushCredential = vi.fn();

    const summary = await backfillRelayfileWritebackCf(
      {},
      {
        listCandidates: async () => [candidate({ provider: "dropbox" })],
        pushCredential,
      },
    );

    expect(pushCredential).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ scanned: 1, skipped: 1 });
    expect(summary.results[0]).toMatchObject({
      status: "skipped_unsupported_provider",
      provider: "dropbox",
    });
  });
});
