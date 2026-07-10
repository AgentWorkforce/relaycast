import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  hasWorkspaceReadAccess: vi.fn(),
  resolveWorkspaceIntegrationIdentity: vi.fn(),
  hasWorkspaceIntegrationReadAccess: vi.fn(),
  listWorkspaceIntegrationsByProviderAlias: vi.fn(),
  getNangoSecretKey: vi.fn(),
  getNangoClient: vi.fn(),
  getProviderConfigKey: vi.fn(),
  triggerAction: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
}));

vi.mock("@/lib/integrations/integration-route-handler", () => ({
  hasWorkspaceReadAccess: mocks.hasWorkspaceReadAccess,
  hasWorkspaceAccess: vi.fn(),
}));

vi.mock("@/lib/workspaces/workspace-integration-identity", () => ({
  resolveWorkspaceIntegrationIdentity: mocks.resolveWorkspaceIntegrationIdentity,
  hasWorkspaceIntegrationReadAccess: mocks.hasWorkspaceIntegrationReadAccess,
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  listWorkspaceIntegrationsByProviderAlias: mocks.listWorkspaceIntegrationsByProviderAlias,
}));

vi.mock("@/lib/integrations/nango-service", () => ({
  getNangoClient: mocks.getNangoClient,
  getNangoSecretKey: mocks.getNangoSecretKey,
  getProviderConfigKey: mocks.getProviderConfigKey,
}));

import { GET } from "./route";

const auth = {
  userId: "user_123",
  workspaceId: "ws_123",
  organizationId: "org_123",
  source: "session",
  context: {
    user: { id: "user_123", email: "dev@example.test" },
    currentWorkspace: { id: "ws_123" },
    currentOrganization: { id: "org_123" },
    workspaces: [{ id: "ws_123" }],
  },
};

function request(
  provider = "slack",
  resource = "users",
  searchParams = "",
): NextRequest {
  const query = searchParams ? `?${searchParams}` : "";
  return new NextRequest(
    new URL(`https://agentrelay.test/api/v1/workspaces/ws_123/integrations/${provider}/options/${resource}${query}`),
  );
}

function requestWithCursor(cursor: string): NextRequest {
  return request("github", "users", `cursor=${encodeURIComponent(cursor)}`);
}

function lastActionInput(): Record<string, unknown> {
  const lastCall = mocks.triggerAction.mock.calls.at(-1);
  return lastCall?.[3] as Record<string, unknown>;
}

function context(provider: string, resource: string) {
  return {
    params: Promise.resolve({ workspaceId: "ws_123", provider, resource }),
  };
}

function contextForWorkspace(workspaceId: string, provider: string, resource: string) {
  return {
    params: Promise.resolve({ workspaceId, provider, resource }),
  };
}

function integrationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "integration_slack",
    workspaceId: "ws_123",
    provider: "slack",
    connectionId: "conn_slack",
    providerConfigKey: "slack-relay",
    installationId: null,
    metadata: {},
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    updatedAt: new Date("2026-05-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("GET /api/v1/workspaces/:workspaceId/integrations/:provider/options/:resource", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue(auth);
    mocks.hasWorkspaceReadAccess.mockReturnValue(true);
    mocks.resolveWorkspaceIntegrationIdentity.mockImplementation(
      async (workspaceId: string) => ({
        requestedWorkspaceId: workspaceId,
        appWorkspaceId: workspaceId,
        relayWorkspaceId: workspaceId,
        organizationId: "org_123",
        candidateWorkspaceIds: [workspaceId],
      }),
    );
    mocks.hasWorkspaceIntegrationReadAccess.mockReturnValue(true);
    mocks.getNangoSecretKey.mockReturnValue("test-secret");
    mocks.getNangoClient.mockReturnValue({ triggerAction: mocks.triggerAction });
  });

  it("maps slack users to picker options via list-users action", async () => {
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([integrationRow()]);
    mocks.triggerAction.mockResolvedValue({
      users: [
        { id: "U1", name: "ben", real_name: "Benjamin", email: "ben@watchdog.no" },
        { id: "U2", name: "amy", real_name: "", display_name: "Amy" },
      ],
    });

    const res = await GET(request(), context("slack", "users"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      options: [
        { value: "U1", label: "Benjamin", hint: "ben@watchdog.no" },
        { value: "U2", label: "Amy" },
      ],
    });
    expect(mocks.triggerAction).toHaveBeenCalledWith("slack-relay", "conn_slack", "list-users", {
      limit: 50,
    });
  });

  it("forwards query, cursor, and limit input to slack picker actions", async () => {
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([integrationRow()]);
    mocks.triggerAction.mockResolvedValue({ users: [] });

    const res = await GET(
      request("slack", "users", "query=%20Ben%20&cursor=slack-cursor&limit=25"),
      context("slack", "users"),
    );
    expect(res.status).toBe(200);
    expect(mocks.triggerAction).toHaveBeenCalledWith("slack-relay", "conn_slack", "list-users", {
      query: "Ben",
      cursor: "slack-cursor",
      limit: 25,
    });
  });

  it("prefixes slack channel labels with # and flags private channels", async () => {
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([integrationRow()]);
    mocks.triggerAction.mockResolvedValue({
      channels: [
        { id: "C1", name: "general", is_private: false },
        { id: "C2", name: "exec", is_private: true },
      ],
    });

    const res = await GET(request(), context("slack", "channels"));
    const body = await res.json();
    expect(body.options).toEqual([
      { value: "C1", label: "#general" },
      { value: "C2", label: "#exec", hint: "private" },
    ]);
    expect(mocks.triggerAction).toHaveBeenCalledWith("slack-relay", "conn_slack", "list-channels", {
      limit: 50,
    });
  });

  it("looks up options from the bound Relayfile workspace for app UUID requests", async () => {
    mocks.resolveWorkspaceIntegrationIdentity.mockResolvedValue({
      requestedWorkspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
      appWorkspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
      relayWorkspaceId: "rw_7ccfea89",
      organizationId: "org_123",
      candidateWorkspaceIds: [
        "50587328-441d-4acb-b8f3-dbe1b3c5de99",
        "rw_7ccfea89",
      ],
    });
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([integrationRow({
      workspaceId: "rw_7ccfea89",
    })]);
    mocks.triggerAction.mockResolvedValue({
      channels: [{ id: "C1", name: "general" }],
    });

    const res = await GET(
      request(),
      contextForWorkspace("50587328-441d-4acb-b8f3-dbe1b3c5de99", "slack", "channels"),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.options).toEqual([{ value: "C1", label: "#general" }]);
    expect(mocks.listWorkspaceIntegrationsByProviderAlias).toHaveBeenCalledWith("rw_7ccfea89", "slack");
    expect(mocks.triggerAction).toHaveBeenCalledWith("slack-relay", "conn_slack", "list-channels", {
      limit: 50,
    });
  });

  it("falls back to the app workspace integration row when the Relay workspace has none", async () => {
    mocks.resolveWorkspaceIntegrationIdentity.mockResolvedValue({
      requestedWorkspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
      appWorkspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
      relayWorkspaceId: "rw_7ccfea89",
      organizationId: "org_123",
      candidateWorkspaceIds: [
        "50587328-441d-4acb-b8f3-dbe1b3c5de99",
        "rw_7ccfea89",
      ],
    });
    mocks.listWorkspaceIntegrationsByProviderAlias
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([integrationRow({
        workspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
        provider: "slack-nightcto",
        providerConfigKey: "slack-relay",
      })]);
    mocks.triggerAction.mockResolvedValue({
      channels: [{ id: "C1", name: "general" }],
    });

    const res = await GET(
      request(),
      contextForWorkspace("50587328-441d-4acb-b8f3-dbe1b3c5de99", "slack", "channels"),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.options).toEqual([{ value: "C1", label: "#general" }]);
    expect(mocks.listWorkspaceIntegrationsByProviderAlias).toHaveBeenNthCalledWith(1, "rw_7ccfea89", "slack");
    expect(mocks.listWorkspaceIntegrationsByProviderAlias).toHaveBeenNthCalledWith(
      2,
      "50587328-441d-4acb-b8f3-dbe1b3c5de99",
      "slack",
    );
    expect(mocks.triggerAction).toHaveBeenCalledWith("slack-relay", "conn_slack", "list-channels", {
      limit: 50,
    });
  });

  it("maps linear teams with key as hint", async () => {
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([
      integrationRow({ provider: "linear", connectionId: "conn_linear", providerConfigKey: "linear-relay" }),
    ]);
    mocks.triggerAction.mockResolvedValue({
      teams: [{ id: "team-1", name: "Engineering", key: "ENG" }],
    });

    const res = await GET(request(), context("linear", "teams"));
    const body = await res.json();
    expect(body.options).toEqual([{ value: "team-1", label: "Engineering", hint: "ENG" }]);
    expect(mocks.triggerAction).toHaveBeenCalledWith("linear-relay", "conn_linear", "list-teams", {
      limit: 50,
    });
  });

  it("maps linear projects with state as hint", async () => {
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([
      integrationRow({ provider: "linear", connectionId: "conn_linear", providerConfigKey: "linear-relay" }),
    ]);
    mocks.triggerAction.mockResolvedValue({
      projects: [{ id: "project-1", name: "Roadmap", state: "started", description: "Q3 roadmap" }],
    });

    const res = await GET(request(), context("linear", "projects"));
    const body = await res.json();
    expect(body.options).toEqual([{ value: "project-1", label: "Roadmap", hint: "started" }]);
    expect(mocks.triggerAction).toHaveBeenCalledWith("linear-relay", "conn_linear", "list-projects", {
      limit: 50,
    });
  });

  it("maps linear labels with color as hint", async () => {
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([
      integrationRow({ provider: "linear", connectionId: "conn_linear", providerConfigKey: "linear-relay" }),
    ]);
    mocks.triggerAction.mockResolvedValue({
      labels: [{ id: "label-1", name: "Bug", color: "#d73a4a" }],
    });

    const res = await GET(request(), context("linear", "labels"));
    const body = await res.json();
    expect(body.options).toEqual([{ value: "label-1", label: "Bug", hint: "#d73a4a" }]);
    expect(mocks.triggerAction).toHaveBeenCalledWith("linear-relay", "conn_linear", "list-labels", {
      limit: 50,
    });
  });

  it("maps linear assignees with email as hint", async () => {
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([
      integrationRow({ provider: "linear", connectionId: "conn_linear", providerConfigKey: "linear-relay" }),
    ]);
    mocks.triggerAction.mockResolvedValue({
      assignees: [{ id: "user-1", name: "Ben", displayName: "Benjamin", email: "ben@example.test" }],
    });

    const res = await GET(request(), context("linear", "assignees"));
    const body = await res.json();
    expect(body.options).toEqual([{ value: "user-1", label: "Benjamin", hint: "ben@example.test" }]);
    expect(mocks.triggerAction).toHaveBeenCalledWith("linear-relay", "conn_linear", "list-assignees", {
      limit: 50,
    });
  });

  it("maps Daytona organizations to picker options via list-organizations action", async () => {
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([
      integrationRow({
        provider: "daytona",
        connectionId: "conn_daytona",
        providerConfigKey: "daytona-relay",
      }),
    ]);
    mocks.triggerAction.mockResolvedValue({
      organizations: [
        { id: "org-1", name: "Primary Org", personal: false },
        { id: "org-2", name: "Sandbox Org", personal: true },
      ],
    });

    const res = await GET(request(), context("daytona", "organizations"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.options).toEqual([
      { value: "org-1", label: "Primary Org" },
      { value: "org-2", label: "Sandbox Org" },
    ]);
    expect(mocks.triggerAction).toHaveBeenCalledWith(
      "daytona-relay",
      "conn_daytona",
      "list-organizations",
      { limit: 50 },
    );
  });

  it("maps github users to login picker options and forwards cursor pagination", async () => {
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([
      integrationRow({ provider: "github", connectionId: "conn_github", providerConfigKey: "github-relay" }),
    ]);
    mocks.triggerAction.mockResolvedValue({
      users: [
        { id: 1, login: "octocat", type: "User" },
        { id: 2, login: "hubot", type: "Bot" },
      ],
      nextCursor: "2",
    });

    const res = await GET(requestWithCursor("1"), context("github", "users"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      options: [
        { value: "octocat", label: "octocat" },
        { value: "hubot", label: "hubot" },
      ],
      nextCursor: "2",
    });
    expect(mocks.triggerAction).toHaveBeenCalledWith("github-relay", "conn_github", "list-users", {
      cursor: "1",
      limit: 50,
    });
  });

  it("forwards opaque github cursor input to the list-users action", async () => {
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([
      integrationRow({ provider: "github", connectionId: "conn_github", providerConfigKey: "github-relay" }),
    ]);
    mocks.triggerAction.mockResolvedValue({ users: [] });

    const res = await GET(requestWithCursor("not-a-user-id"), context("github", "users"));
    expect(res.status).toBe(200);
    expect(mocks.triggerAction).toHaveBeenCalledWith("github-relay", "conn_github", "list-users", {
      cursor: "not-a-user-id",
      limit: 50,
    });
  });

  it("forwards query, cursor, and limit input to github picker actions", async () => {
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([
      integrationRow({ provider: "github", connectionId: "conn_github", providerConfigKey: "github-relay" }),
    ]);
    mocks.triggerAction.mockResolvedValue({ users: [] });

    const res = await GET(
      request("github", "users", "query=%20octo%20&cursor=3&limit=75"),
      context("github", "users"),
    );

    expect(res.status).toBe(200);
    expect(mocks.triggerAction).toHaveBeenCalledWith("github-relay", "conn_github", "list-users", {
      query: "octo",
      cursor: "3",
      limit: 75,
    });
  });

  it.each([
    ["9999", 200],
    ["0", 50],
    ["-1", 50],
    ["abc", 50],
  ])("clamps picker action limit=%s to %i", async (limitParam, expectedLimit) => {
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([integrationRow()]);
    mocks.triggerAction.mockResolvedValue({ users: [] });

    const res = await GET(
      request("slack", "users", `limit=${encodeURIComponent(limitParam)}`),
      context("slack", "users"),
    );

    expect(res.status).toBe(200);
    expect(lastActionInput()).toEqual({ limit: expectedLimit });
  });

  it("surfaces nextCursor when the picker action returns it", async () => {
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([integrationRow()]);
    mocks.triggerAction.mockResolvedValue({
      channels: [{ id: "C1", name: "general" }],
      nextCursor: "next-page",
    });

    const res = await GET(request("slack", "channels"), context("slack", "channels"));
    const body = await res.json();

    expect(body).toEqual({
      ok: true,
      options: [{ value: "C1", label: "#general" }],
      nextCursor: "next-page",
    });
  });

  it("keeps no-param requests backward compatible with a default bounded first page", async () => {
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([integrationRow()]);
    mocks.triggerAction.mockResolvedValue({
      channels: [{ id: "C1", name: "general" }],
    });

    const res = await GET(request("slack", "channels"), context("slack", "channels"));
    const body = await res.json();

    expect(body).toEqual({
      ok: true,
      options: [{ value: "C1", label: "#general" }],
    });
    expect(lastActionInput()).toEqual({ limit: 50 });
    expect(body).not.toHaveProperty("nextCursor");
  });

  it("rejects an unsupported (provider, resource) combo with 400", async () => {
    const res = await GET(request(), context("linear", "channels"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, code: "unsupported_resource" });
    expect(mocks.listWorkspaceIntegrationsByProviderAlias).not.toHaveBeenCalled();
  });

  it("returns 404 when the integration is not connected", async () => {
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([]);
    const res = await GET(request(), context("slack", "users"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, code: "integration_not_found" });
  });

  it("falls back to getProviderConfigKey when the row has none", async () => {
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([integrationRow({ providerConfigKey: null })]);
    mocks.getProviderConfigKey.mockReturnValue("slack-relay");
    mocks.triggerAction.mockResolvedValue({ users: [] });

    const res = await GET(request(), context("slack", "users"));
    expect(res.status).toBe(200);
    expect(mocks.getProviderConfigKey).toHaveBeenCalledWith("slack");
    expect(mocks.triggerAction).toHaveBeenCalledWith("slack-relay", "conn_slack", "list-users", {
      limit: 50,
    });
  });

  it("uses the matched row provider for providerConfigKey fallback", async () => {
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([
      integrationRow({
        provider: "slack-nightcto",
        providerConfigKey: null,
      }),
    ]);
    mocks.getProviderConfigKey.mockReturnValue("slack-nightcto");
    mocks.triggerAction.mockResolvedValue({ channels: [] });

    const res = await GET(request(), context("slack", "channels"));

    expect(res.status).toBe(200);
    expect(mocks.getProviderConfigKey).toHaveBeenCalledWith("slack-nightcto");
    expect(mocks.triggerAction).toHaveBeenCalledWith(
      "slack-nightcto",
      "conn_slack",
      "list-channels",
      { limit: 50 },
    );
  });
});
