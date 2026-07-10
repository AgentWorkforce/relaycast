import { describe, expect, it, vi } from "vitest";
import {
  auditWorkspaceIntegrationRows,
} from "./workspace-integration-row-audit";

const row = (overrides: Record<string, unknown>) => ({
  id: "row-1",
  workspace_id: "rw_7ccfea89",
  provider: "notion",
  adapter: "nango",
  connection_id: "conn-1",
  provider_config_key: "notion-relay",
  created_at: "2026-05-01T00:00:00.000Z",
  ...overrides,
});

describe("auditWorkspaceIntegrationRows", () => {
  it("classifies relay-shaped rows as identity (no mismatch, no binding lookup)", async () => {
    const readBoundRelayWorkspace = vi.fn();
    const summary = await auditWorkspaceIntegrationRows(
      {},
      {
        listRows: async () => [row({})],
        readBoundRelayWorkspace,
      },
    );

    expect(summary).toMatchObject({
      scanned: 1,
      relayShaped: 1,
      appUuidShaped: 0,
      mismatched: 0,
      unbound: 0,
    });
    expect(summary.entries[0]).toMatchObject({
      idShape: "relay",
      boundRelayWorkspaceId: "rw_7ccfea89",
      syncTargetMismatch: false,
    });
    expect(readBoundRelayWorkspace).not.toHaveBeenCalled();
  });

  it("flags app-UUID rows whose binding differs (the stranded-records class)", async () => {
    const readBoundRelayWorkspace = vi.fn().mockResolvedValue("rw_7ccfea89");
    const summary = await auditWorkspaceIntegrationRows(
      {},
      {
        listRows: async () => [
          row({
            id: "row-github",
            provider: "github",
            workspace_id: "34690534-24ab-4487-937c-10928921f104",
          }),
        ],
        readBoundRelayWorkspace,
      },
    );

    expect(summary.mismatched).toBe(1);
    expect(summary.entries[0]).toMatchObject({
      idShape: "app_uuid",
      workspaceId: "34690534-24ab-4487-937c-10928921f104",
      boundRelayWorkspaceId: "rw_7ccfea89",
      syncTargetMismatch: true,
    });
  });

  it("reports unbound app-UUID rows and caches binding lookups per workspace", async () => {
    const readBoundRelayWorkspace = vi.fn().mockResolvedValue(null);
    const uuid = "50587328-441d-4acb-b8f3-dbe1b3c5de99";
    const summary = await auditWorkspaceIntegrationRows(
      {},
      {
        listRows: async () => [
          row({ id: "row-a", provider: "slack", workspace_id: uuid }),
          row({ id: "row-b", provider: "linear", workspace_id: uuid }),
        ],
        readBoundRelayWorkspace,
      },
    );

    expect(summary.unbound).toBe(2);
    expect(summary.mismatched).toBe(0);
    expect(readBoundRelayWorkspace).toHaveBeenCalledTimes(1);
  });

  it("treats binding lookup failures as unbound instead of aborting (read-only resilience)", async () => {
    const readBoundRelayWorkspace = vi.fn().mockRejectedValue(new Error("db down"));
    const summary = await auditWorkspaceIntegrationRows(
      {},
      {
        listRows: async () => [
          row({ workspace_id: "34690534-24ab-4487-937c-10928921f104" }),
        ],
        readBoundRelayWorkspace,
      },
    );

    expect(summary.unbound).toBe(1);
    expect(summary.entries[0]).toMatchObject({
      boundRelayWorkspaceId: null,
      syncTargetMismatch: false,
    });
  });

  it("classifies non-uuid non-relay ids as other", async () => {
    const summary = await auditWorkspaceIntegrationRows(
      {},
      {
        listRows: async () => [row({ workspace_id: "weird-id-shape" })],
        readBoundRelayWorkspace: vi.fn(),
      },
    );
    expect(summary.otherShaped).toBe(1);
    expect(summary.entries[0]).toMatchObject({ idShape: "other", boundRelayWorkspaceId: null });
  });
});
