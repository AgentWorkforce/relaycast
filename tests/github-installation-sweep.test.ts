// Unit tests for the Nango → github_installations index sweep (org-reconcile
// PR1): detection completeness backfill for installs predating the #1538
// webhook population.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listConnections: vi.fn(),
  proxy: vi.fn(),
  getNangoConnectionDetails: vi.fn(),
  upsertGithubInstallationIndex: vi.fn(),
  dbSelectRows: [] as Array<{ workspaceId: string }>,
}));

vi.mock("../packages/web/lib/integrations/nango-service", () => ({
  getNangoClient: () => ({
    listConnections: mocks.listConnections,
    proxy: mocks.proxy,
  }),
  getNangoConnectionDetails: mocks.getNangoConnectionDetails,
}));

vi.mock("../packages/web/lib/integrations/github-installation-index", () => ({
  upsertGithubInstallationIndex: mocks.upsertGithubInstallationIndex,
}));

vi.mock("../packages/web/lib/db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: async () => mocks.dbSelectRows,
      }),
    }),
  }),
}));

vi.mock("../packages/web/lib/logger", () => ({
  logger: {
    debug: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
  },
}));

import { sweepGithubInstallationsFromNango } from "../packages/web/lib/integrations/github-installation-sweep";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dbSelectRows = [];
  mocks.listConnections.mockResolvedValue({ connections: [] });
  mocks.getNangoConnectionDetails.mockResolvedValue(null);
  mocks.upsertGithubInstallationIndex.mockResolvedValue({
    installationIndexed: true,
    repositoriesIndexed: 0,
  });
  mocks.proxy.mockResolvedValue({ data: { repositories: [] } });
});

describe("sweepGithubInstallationsFromNango", () => {
  it("indexes github-relay connections through the canonical upsert with account info", async () => {
    mocks.listConnections.mockResolvedValue({
      connections: [
        { connection_id: "conn-1", provider_config_key: "github-relay" },
        // Ignored: not a github config key.
        { connection_id: "conn-slack", provider_config_key: "slack-relay" },
      ],
    });
    mocks.getNangoConnectionDetails.mockResolvedValue({
      installationId: "9001",
      payload: {},
    });
    mocks.dbSelectRows = [{ workspaceId: "ws-a" }];
    mocks.proxy.mockResolvedValue({
      data: { repositories: [{ owner: { login: "AcmeOrg", type: "Organization" } }] },
    });

    const result = await sweepGithubInstallationsFromNango();

    expect(result).toMatchObject({ scanned: 1, indexed: 1, failed: 0 });
    expect(mocks.upsertGithubInstallationIndex).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-a",
        installationId: "9001",
        connectionId: "conn-1",
        providerConfigKey: "github-relay",
        payload: {
          installation: {
            id: "9001",
            account: { login: "AcmeOrg", type: "Organization" },
          },
        },
      }),
    );
  });

  it("skips connections without an installation id and counts orphans without writing", async () => {
    mocks.listConnections.mockResolvedValue({
      connections: [
        { connection_id: "conn-no-install", provider_config_key: "github-relay" },
        { connection_id: "conn-orphan", provider_config_key: "github-relay" },
      ],
    });
    mocks.getNangoConnectionDetails
      .mockResolvedValueOnce({ installationId: null, payload: {} })
      .mockResolvedValueOnce({ installationId: "9002", payload: {} });
    mocks.dbSelectRows = []; // orphan: no workspace row anywhere

    const result = await sweepGithubInstallationsFromNango();

    expect(result).toMatchObject({
      scanned: 2,
      indexed: 0,
      skippedNoInstallation: 1,
      skippedOrphan: 1,
      failed: 0,
    });
    expect(mocks.upsertGithubInstallationIndex).not.toHaveBeenCalled();
  });

  it("dry-run scans without writing", async () => {
    mocks.listConnections.mockResolvedValue({
      connections: [{ connection_id: "conn-1", provider_config_key: "github-relay" }],
    });
    mocks.getNangoConnectionDetails.mockResolvedValue({ installationId: "9001", payload: {} });
    mocks.dbSelectRows = [{ workspaceId: "ws-a" }];

    const result = await sweepGithubInstallationsFromNango({ dryRun: true });

    expect(result.indexed).toBe(1);
    expect(mocks.upsertGithubInstallationIndex).not.toHaveBeenCalled();
  });

  it("a failing connection is counted and does not abort the sweep", async () => {
    mocks.listConnections.mockResolvedValue({
      connections: [
        { connection_id: "conn-bad", provider_config_key: "github-relay" },
        { connection_id: "conn-good", provider_config_key: "github-relay" },
      ],
    });
    mocks.getNangoConnectionDetails
      .mockRejectedValueOnce(new Error("nango 500"))
      .mockResolvedValueOnce({ installationId: "9003", payload: {} });
    mocks.dbSelectRows = [{ workspaceId: "ws-a" }];

    const result = await sweepGithubInstallationsFromNango();

    expect(result).toMatchObject({ scanned: 2, indexed: 1, failed: 1 });
  });
});
