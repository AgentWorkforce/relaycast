import { beforeEach, describe, expect, it, vi } from "vitest";

// This unit test covers resolveWorkspace() in isolation — no route, no
// schema, no audit. Every integration-lookup helper is mocked so the
// only thing being tested is the resolver's decision tree: which
// identifier wins, which lookup fires, and what result shape comes out.

const {
  getWorkspaceIntegrationMock,
  findSlackIntegrationByTeamIdMock,
  findWorkspaceIntegrationByInstallationMock,
} = vi.hoisted(() => ({
  getWorkspaceIntegrationMock: vi.fn(),
  findSlackIntegrationByTeamIdMock: vi.fn(),
  findWorkspaceIntegrationByInstallationMock: vi.fn(),
}));

vi.mock("../packages/web/lib/integrations/workspace-integrations.ts", () => {
  // Use the real `looksLikeSlackTeamId` regex so malformed Slack team ids
  // fail the invalid_identifier branch for the right reason.
  const SLACK_TEAM_ID_PATTERN = /^[TE][A-Z0-9]{6,}$/;
  return {
    getWorkspaceIntegration: getWorkspaceIntegrationMock,
    findSlackIntegrationByTeamId: findSlackIntegrationByTeamIdMock,
    findWorkspaceIntegrationByInstallation: findWorkspaceIntegrationByInstallationMock,
    looksLikeSlackTeamId: (value: string) => SLACK_TEAM_ID_PATTERN.test(value.trim()),
  };
});

type ResolverModule = typeof import(
  "../packages/web/lib/integrations/workspace-identity-resolver"
);

async function loadResolver(): Promise<ResolverModule> {
  return import(
    new URL(
      "../packages/web/lib/integrations/workspace-identity-resolver.ts",
      import.meta.url,
    ).href,
  ) as Promise<ResolverModule>;
}

const WORKSPACE_UUID = "11111111-1111-4111-8111-111111111111";
const ANOTHER_UUID = "22222222-2222-4222-8222-222222222222";
const SLACK_TEAM_ID = "T024BE91L";
const SLACK_ENTERPRISE_ID = "E024BE91L";
const GITHUB_INSTALLATION_ID = "987654321";
const CONNECTION_ID = "conn_slack_sage_123";
const PROVIDER_CONFIG_KEY = "slack-relay";

const BASE_INTEGRATION = {
  workspaceId: WORKSPACE_UUID,
  provider: "slack" as const,
  connectionId: CONNECTION_ID,
  providerConfigKey: PROVIDER_CONFIG_KEY,
  installationId: null,
  metadata: {
    slackTeamId: SLACK_TEAM_ID,
  },
  createdAt: new Date("2026-04-14T00:00:00.000Z"),
  updatedAt: new Date("2026-04-14T00:00:00.000Z"),
};

beforeEach(() => {
  getWorkspaceIntegrationMock.mockReset();
  findSlackIntegrationByTeamIdMock.mockReset();
  findWorkspaceIntegrationByInstallationMock.mockReset();
});

describe("resolveWorkspace — UUID fast path", () => {
  it("resolves by workspaceId and returns resolvedVia='uuid'", async () => {
    getWorkspaceIntegrationMock.mockResolvedValue(BASE_INTEGRATION);

    const { resolveWorkspace } = await loadResolver();
    const result = await resolveWorkspace(
      { workspaceId: WORKSPACE_UUID },
      { provider: "slack" },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workspaceId).toBe(WORKSPACE_UUID);
      expect(result.resolvedVia).toBe("uuid");
      expect(result.integration.connectionId).toBe(CONNECTION_ID);
    }

    expect(getWorkspaceIntegrationMock).toHaveBeenCalledWith(
      WORKSPACE_UUID,
      "slack",
    );
    expect(findSlackIntegrationByTeamIdMock).not.toHaveBeenCalled();
  });

  it("returns not_found when UUID is valid but no integration row exists for the provider", async () => {
    // Hard constraint: if the caller explicitly named a workspace, we do
    // NOT fall through to a slackTeamId lookup. Returning a different
    // workspace via provider-scoped fallback would be a silent
    // cross-tenant data leak.
    getWorkspaceIntegrationMock.mockResolvedValue(null);

    const { resolveWorkspace } = await loadResolver();
    const result = await resolveWorkspace(
      {
        workspaceId: WORKSPACE_UUID,
        slackTeamId: SLACK_TEAM_ID,
      },
      { provider: "slack" },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("not_found");
    }
    expect(findSlackIntegrationByTeamIdMock).not.toHaveBeenCalled();
  });

  it("returns invalid_identifier when workspaceId is neither a UUID nor an rw_ id", async () => {
    const { resolveWorkspace } = await loadResolver();
    const result = await resolveWorkspace(
      { workspaceId: "not-a-uuid" },
      { provider: "slack" },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("invalid_identifier");
      expect(result.reason).toContain("UUID");
    }
    expect(getWorkspaceIntegrationMock).not.toHaveBeenCalled();
  });

  it("accepts a productized rw_<8hex> workspace id on the fast path", async () => {
    // The cloud-mount registry mints `rw_<8hex>` workspace ids and stores
    // them in `workspace_integrations.workspace_id` (column is `text`,
    // not `uuid`, for exactly this reason). The resolver must accept
    // them as valid input identifiers, otherwise sage's second proxy
    // call (after caching the rw_ id from auth.test) gets rejected here.
    const RELAY_WORKSPACE_ID = "rw_517d60b6";
    getWorkspaceIntegrationMock.mockResolvedValue({
      ...BASE_INTEGRATION,
      workspaceId: RELAY_WORKSPACE_ID,
    });

    const { resolveWorkspace } = await loadResolver();
    const result = await resolveWorkspace(
      { workspaceId: RELAY_WORKSPACE_ID },
      { provider: "slack" },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workspaceId).toBe(RELAY_WORKSPACE_ID);
      expect(result.resolvedVia).toBe("uuid");
    }
    expect(getWorkspaceIntegrationMock).toHaveBeenCalledWith(
      RELAY_WORKSPACE_ID,
      "slack",
    );
  });

  it("prefers UUID over slackTeamId even when both look valid", async () => {
    getWorkspaceIntegrationMock.mockResolvedValue({
      ...BASE_INTEGRATION,
      workspaceId: WORKSPACE_UUID,
    });

    const { resolveWorkspace } = await loadResolver();
    const result = await resolveWorkspace(
      { workspaceId: WORKSPACE_UUID, slackTeamId: SLACK_TEAM_ID },
      { provider: "slack" },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedVia).toBe("uuid");
    }
    expect(findSlackIntegrationByTeamIdMock).not.toHaveBeenCalled();
  });
});

describe("resolveWorkspace — slackTeamId fallback", () => {
  it("resolves via slackTeamId and returns the canonical workspaceId", async () => {
    findSlackIntegrationByTeamIdMock.mockResolvedValue({
      ...BASE_INTEGRATION,
      workspaceId: WORKSPACE_UUID,
    });

    const { resolveWorkspace } = await loadResolver();
    const result = await resolveWorkspace(
      { slackTeamId: SLACK_TEAM_ID },
      { provider: "slack" },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workspaceId).toBe(WORKSPACE_UUID);
      expect(result.resolvedVia).toBe("slack-team-id");
    }

    expect(findSlackIntegrationByTeamIdMock).toHaveBeenCalledWith(SLACK_TEAM_ID);
    expect(getWorkspaceIntegrationMock).not.toHaveBeenCalled();
  });

  it("accepts enterprise-grid team ids (E-prefixed)", async () => {
    findSlackIntegrationByTeamIdMock.mockResolvedValue({
      ...BASE_INTEGRATION,
      workspaceId: ANOTHER_UUID,
      metadata: { slackEnterpriseId: SLACK_ENTERPRISE_ID },
    });

    const { resolveWorkspace } = await loadResolver();
    const result = await resolveWorkspace(
      { slackTeamId: SLACK_ENTERPRISE_ID },
      { provider: "slack" },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workspaceId).toBe(ANOTHER_UUID);
      expect(result.resolvedVia).toBe("slack-team-id");
    }
  });

  it("returns invalid_identifier for malformed slackTeamId shapes", async () => {
    const { resolveWorkspace } = await loadResolver();
    const result = await resolveWorkspace(
      { slackTeamId: "T-E2E" }, // The test fixture bug that kicked off this whole refactor
      { provider: "slack" },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("invalid_identifier");
    }
    expect(findSlackIntegrationByTeamIdMock).not.toHaveBeenCalled();
  });

  it("returns not_found when slackTeamId is valid shape but no matching row", async () => {
    findSlackIntegrationByTeamIdMock.mockResolvedValue(null);

    const { resolveWorkspace } = await loadResolver();
    const result = await resolveWorkspace(
      { slackTeamId: "TUNKNOWNXX" },
      { provider: "slack" },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("not_found");
      expect(result.reason).toContain("TUNKNOWNXX");
    }
  });
});

describe("resolveWorkspace — githubInstallationId", () => {
  it("resolves via githubInstallationId through the github provider finder", async () => {
    findWorkspaceIntegrationByInstallationMock.mockResolvedValue({
      workspaceId: WORKSPACE_UUID,
      provider: "github",
      connectionId: "github-conn-123",
      providerConfigKey: "github-sage",
      installationId: GITHUB_INSTALLATION_ID,
      metadata: {},
      createdAt: new Date("2026-04-14T00:00:00.000Z"),
      updatedAt: new Date("2026-04-14T00:00:00.000Z"),
    });

    const { resolveWorkspace } = await loadResolver();
    const result = await resolveWorkspace(
      { githubInstallationId: GITHUB_INSTALLATION_ID },
      { provider: "github" },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workspaceId).toBe(WORKSPACE_UUID);
      expect(result.resolvedVia).toBe("github-installation-id");
    }

    expect(findWorkspaceIntegrationByInstallationMock).toHaveBeenCalledWith(
      "github",
      GITHUB_INSTALLATION_ID,
    );
    expect(findSlackIntegrationByTeamIdMock).not.toHaveBeenCalled();
    expect(getWorkspaceIntegrationMock).not.toHaveBeenCalled();
  });
});

describe("resolveWorkspace — missing_identifier", () => {
  it("returns missing_identifier when no fields are provided", async () => {
    const { resolveWorkspace } = await loadResolver();
    const result = await resolveWorkspace(
      {},
      { provider: "slack" },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("missing_identifier");
    }
    expect(getWorkspaceIntegrationMock).not.toHaveBeenCalled();
    expect(findSlackIntegrationByTeamIdMock).not.toHaveBeenCalled();
    expect(findWorkspaceIntegrationByInstallationMock).not.toHaveBeenCalled();
  });

  it("returns missing_identifier when all fields are empty strings", async () => {
    const { resolveWorkspace } = await loadResolver();
    const result = await resolveWorkspace(
      {
        workspaceId: "   ",
        slackTeamId: "",
        githubInstallationId: null,
      },
      { provider: "slack" },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("missing_identifier");
    }
  });

  it("ignores null/undefined fields without throwing", async () => {
    // Defensive: callers pass `body.workspaceId ?? null` so every field
    // can legitimately be null. The resolver must handle that without
    // tripping a TypeError.
    const { resolveWorkspace } = await loadResolver();
    const result = await resolveWorkspace(
      {
        workspaceId: null,
        slackTeamId: undefined,
        githubInstallationId: null,
      },
      { provider: "slack" },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("missing_identifier");
    }
  });
});

describe("resolveWorkspace — provider scoping", () => {
  it("does NOT scan across providers when multiple identifiers are absent", async () => {
    // If the caller sends slackTeamId only, we should never touch the
    // github installation finder, and vice versa. The resolver is never
    // a "fuzzy match" — it runs at most one DB query.
    findSlackIntegrationByTeamIdMock.mockResolvedValue({
      ...BASE_INTEGRATION,
      workspaceId: WORKSPACE_UUID,
    });

    const { resolveWorkspace } = await loadResolver();
    await resolveWorkspace(
      { slackTeamId: SLACK_TEAM_ID },
      { provider: "slack" },
    );

    expect(findSlackIntegrationByTeamIdMock).toHaveBeenCalledTimes(1);
    expect(findWorkspaceIntegrationByInstallationMock).not.toHaveBeenCalled();
  });
});
