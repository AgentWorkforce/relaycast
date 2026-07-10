import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_TOKEN = "cloud-api-token";
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const CHANNEL_ID = "C024BE91L";
const PROVIDER_CONFIG_KEY = "slack-sage";
const CONNECTION_ID = "conn_slack_sage_123";

const { proxyRequestMock, getSlackConnectionIdentityMock } = vi.hoisted(() => ({
  proxyRequestMock: vi.fn(),
  getSlackConnectionIdentityMock: vi.fn(),
}));
const resolveRequestAuthMock = vi.hoisted(() => vi.fn());
const {
  getWorkspaceIntegrationMock,
  upsertWorkspaceIntegrationMock,
  findSlackIntegrationByTeamIdMock,
  findWorkspaceIntegrationByInstallationMock,
} = vi.hoisted(() => ({
  getWorkspaceIntegrationMock: vi.fn(),
  upsertWorkspaceIntegrationMock: vi.fn(),
  findSlackIntegrationByTeamIdMock: vi.fn(),
  findWorkspaceIntegrationByInstallationMock: vi.fn(),
}));

vi.mock("sst", () => ({
  Resource: {
    SageCloudApiToken: { value: TEST_TOKEN },
  },
}));

vi.mock("../packages/web/lib/auth/request-auth.ts", () => ({
  resolveRequestAuth: (...args: unknown[]) => resolveRequestAuthMock(...args),
}));

vi.mock("../packages/web/lib/integrations/nango-slack.ts", () => {
  return {
    proxyRequest: proxyRequestMock,
    getSlackConnectionIdentity: getSlackConnectionIdentityMock,
  };
});

vi.mock("../packages/web/lib/integrations/workspace-integrations.ts", () => {
  // `looksLikeSlackTeamId` is a pure helper — no DB access — so we re-export
  // the real implementation. Everything else is a mock controlled per-test.
  const SLACK_TEAM_ID_PATTERN = /^[TE][A-Z0-9]{6,}$/;
  return {
    getWorkspaceIntegration: getWorkspaceIntegrationMock,
    upsertWorkspaceIntegration: upsertWorkspaceIntegrationMock,
    findSlackIntegrationByTeamId: findSlackIntegrationByTeamIdMock,
    findWorkspaceIntegrationByInstallation: findWorkspaceIntegrationByInstallationMock,
    looksLikeSlackTeamId: (value: string) => SLACK_TEAM_ID_PATTERN.test(value.trim()),
  };
});

type SlackProxyRouteModule = {
  POST: (request: Request) => Promise<Response>;
};

async function loadRouteModule(): Promise<SlackProxyRouteModule> {
  return import(
    new URL("../packages/web/app/api/v1/proxy/slack/route.ts", import.meta.url).href
  ) as Promise<SlackProxyRouteModule>;
}

function buildRequest(body: Record<string, unknown>, token: string | null = TEST_TOKEN): Request {
  const headers = new Headers({
    "Content-Type": "application/json",
  });

  if (token !== null) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  return new Request("http://localhost/api/v1/proxy/slack", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  process.env.CLOUD_API_TOKEN = TEST_TOKEN;
  proxyRequestMock.mockReset();
  resolveRequestAuthMock.mockReset();
  resolveRequestAuthMock.mockResolvedValue(null);
  getSlackConnectionIdentityMock.mockReset();
  getWorkspaceIntegrationMock.mockReset();
  upsertWorkspaceIntegrationMock.mockReset();
  findSlackIntegrationByTeamIdMock.mockReset();
  findWorkspaceIntegrationByInstallationMock.mockReset();
});

afterEach(async () => {
  try {
    const rateLimitModule = await import(
      new URL("../packages/web/lib/integrations/slack-proxy-ratelimit.ts", import.meta.url).href
    );
    if (typeof rateLimitModule.resetSlackProxyRateLimit === "function") {
      rateLimitModule.resetSlackProxyRateLimit();
    }
  } catch {
    // No-op if the module failed to load.
  }

  delete process.env.CLOUD_API_TOKEN;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.resetModules();
});

describe("slack proxy route", () => {
  it("returns 400 bad_request when neither workspaceId nor slackTeamId is provided", async () => {
    const { POST } = await loadRouteModule();
    const response = await POST(
      buildRequest({
        endpoint: "/chat.postMessage",
        method: "POST",
        data: {
          channel: CHANNEL_ID,
          text: "missing identifier",
        },
      }),
    );

    expect(response.status).toBe(400);
    await expect(readBody(response)).resolves.toEqual({
      ok: false,
      error:
        "Request must include at least one workspace identifier (workspaceId, slackTeamId, or githubInstallationId)",
      code: "bad_request",
    });
    expect(proxyRequestMock).not.toHaveBeenCalled();
    expect(findSlackIntegrationByTeamIdMock).not.toHaveBeenCalled();
    expect(getWorkspaceIntegrationMock).not.toHaveBeenCalled();
  });

  it("uses a workspace-scoped bearer workspaceId when the body omits identifiers", async () => {
    resolveRequestAuthMock.mockResolvedValue({
      userId: "agent_123",
      workspaceId: WORKSPACE_ID,
      organizationId: "org_123",
      source: "relayfile",
      bearerToken: "workspace-token",
      scopes: ["workflow:invoke:write"],
    });
    getWorkspaceIntegrationMock.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      provider: "slack",
      connectionId: CONNECTION_ID,
      providerConfigKey: PROVIDER_CONFIG_KEY,
      installationId: null,
      metadata: {
        slackTeamId: "T_AUTHED",
        slackBotUserId: "U_AUTHED_BOT",
      },
      createdAt: new Date("2026-04-14T00:00:00.000Z"),
      updatedAt: new Date("2026-04-14T00:00:00.000Z"),
    });
    proxyRequestMock.mockResolvedValue({
      ok: true,
      channel: CHANNEL_ID,
      ts: "1713220000.000400",
    });

    const { POST } = await loadRouteModule();
    const response = await POST(
      buildRequest(
        {
          endpoint: "/chat.postMessage",
          method: "POST",
          data: {
            channel: CHANNEL_ID,
            text: "workspace token",
          },
        },
        "workspace-token",
      ),
    );

    expect(response.status).toBe(200);
    await expect(readBody(response)).resolves.toEqual({
      ok: true,
      data: {
        ok: true,
        channel: CHANNEL_ID,
        ts: "1713220000.000400",
      },
      workspaceId: WORKSPACE_ID,
    });
    expect(resolveRequestAuthMock).toHaveBeenCalledTimes(1);
    expect(getWorkspaceIntegrationMock).toHaveBeenCalledWith(WORKSPACE_ID, "slack");
    expect(findSlackIntegrationByTeamIdMock).not.toHaveBeenCalled();
    expect(proxyRequestMock).toHaveBeenCalledTimes(1);
  });

  it("does not let workspace-scoped bearer callers override their workspace", async () => {
    const otherWorkspaceId = "22222222-2222-4222-8222-222222222222";
    resolveRequestAuthMock.mockResolvedValue({
      userId: "agent_123",
      workspaceId: WORKSPACE_ID,
      organizationId: "org_123",
      source: "relayfile",
      bearerToken: "workspace-token",
      scopes: ["workflow:invoke:write"],
    });
    getWorkspaceIntegrationMock.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      provider: "slack",
      connectionId: CONNECTION_ID,
      providerConfigKey: PROVIDER_CONFIG_KEY,
      installationId: null,
      metadata: {
        slackTeamId: "T_AUTHED",
        slackBotUserId: "U_AUTHED_BOT",
      },
      createdAt: new Date("2026-04-14T00:00:00.000Z"),
      updatedAt: new Date("2026-04-14T00:00:00.000Z"),
    });
    proxyRequestMock.mockResolvedValue({ ok: true, ts: "1713220000.000500" });

    const { POST } = await loadRouteModule();
    const response = await POST(
      buildRequest(
        {
          workspaceId: otherWorkspaceId,
          endpoint: "/chat.postMessage",
          method: "POST",
          data: {
            channel: CHANNEL_ID,
            text: "workspace token override",
          },
        },
        "workspace-token",
      ),
    );

    expect(response.status).toBe(200);
    expect(getWorkspaceIntegrationMock).toHaveBeenCalledWith(WORKSPACE_ID, "slack");
    expect(getWorkspaceIntegrationMock).not.toHaveBeenCalledWith(
      otherWorkspaceId,
      "slack",
    );
    await expect(readBody(response)).resolves.toMatchObject({
      ok: true,
      workspaceId: WORKSPACE_ID,
    });
  });

  it("returns 400 bad_request when endpoint is not a string", async () => {
    const { POST } = await loadRouteModule();
    const response = await POST(
      buildRequest({
        workspaceId: WORKSPACE_ID,
        endpoint: 42,
        method: "POST",
      } as unknown as Record<string, unknown>),
    );

    expect(response.status).toBe(400);
    await expect(readBody(response)).resolves.toEqual({
      ok: false,
      error: "Invalid request body",
      code: "bad_request",
    });
    expect(proxyRequestMock).not.toHaveBeenCalled();
  });

  it("returns 403 forbidden when an endpoint is called with the wrong method", async () => {
    const { POST } = await loadRouteModule();
    const response = await POST(
      buildRequest({
        workspaceId: WORKSPACE_ID,
        endpoint: "/chat.postMessage",
        method: "GET",
        params: {
          channel: CHANNEL_ID,
        },
      }),
    );

    expect(response.status).toBe(403);
    await expect(readBody(response)).resolves.toEqual({
      ok: false,
      error: "Endpoint /chat.postMessage does not allow GET",
      code: "forbidden",
    });
    expect(proxyRequestMock).not.toHaveBeenCalled();
  });

  it("self-heals missing Slack team metadata and proceeds with the proxy call", async () => {
    getWorkspaceIntegrationMock.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      provider: "slack",
      connectionId: CONNECTION_ID,
      providerConfigKey: PROVIDER_CONFIG_KEY,
      installationId: null,
      metadata: {
        slackBotUserId: "U_STALE_BOT",
        workspaceName: "Slack Proxy Test",
      },
      createdAt: new Date("2026-04-14T00:00:00.000Z"),
      updatedAt: new Date("2026-04-14T00:00:00.000Z"),
    });
    upsertWorkspaceIntegrationMock.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      provider: "slack",
      connectionId: CONNECTION_ID,
      providerConfigKey: PROVIDER_CONFIG_KEY,
      installationId: null,
      metadata: {
        workspaceName: "Slack Proxy Test",
        slackTeamId: "T_HEALED",
        slackBotUserId: "U_HEALED_BOT",
        slackWorkspaceName: "Slack Proxy Healed",
        slackWorkspaceUrl: "https://healed.slack.com/",
      },
      createdAt: new Date("2026-04-14T00:00:00.000Z"),
      updatedAt: new Date("2026-04-14T00:00:00.000Z"),
    });
    getSlackConnectionIdentityMock.mockResolvedValue({
      teamId: "T_HEALED",
      enterpriseId: null,
      botUserId: "U_HEALED_BOT",
      workspaceName: "Slack Proxy Healed",
      workspaceUrl: "https://healed.slack.com/",
    });
    proxyRequestMock.mockResolvedValue({
      ok: true,
      channel: CHANNEL_ID,
      ts: "1713220000.000300",
    });

    const { POST } = await loadRouteModule();
    const response = await POST(
      buildRequest({
        workspaceId: WORKSPACE_ID,
        endpoint: "/chat.postMessage",
        method: "POST",
        data: {
          channel: CHANNEL_ID,
          text: "self heal",
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(readBody(response)).resolves.toEqual({
      ok: true,
      data: {
        ok: true,
        channel: CHANNEL_ID,
        ts: "1713220000.000300",
      },
      workspaceId: WORKSPACE_ID,
    });

    expect(getSlackConnectionIdentityMock).toHaveBeenCalledTimes(1);
    expect(getSlackConnectionIdentityMock).toHaveBeenCalledWith(
      CONNECTION_ID,
      PROVIDER_CONFIG_KEY,
    );
    expect(upsertWorkspaceIntegrationMock).toHaveBeenCalledTimes(1);
    expect(upsertWorkspaceIntegrationMock).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      provider: "slack",
      connectionId: CONNECTION_ID,
      providerConfigKey: PROVIDER_CONFIG_KEY,
      installationId: null,
      metadata: {
        slackBotUserId: "U_HEALED_BOT",
        workspaceName: "Slack Proxy Test",
        slackTeamId: "T_HEALED",
        slackWorkspaceName: "Slack Proxy Healed",
        slackWorkspaceUrl: "https://healed.slack.com/",
      },
    });
    expect(proxyRequestMock).toHaveBeenCalledTimes(1);
    expect(proxyRequestMock).toHaveBeenCalledWith({
      method: "POST",
      endpoint: "/chat.postMessage",
      providerConfigKey: PROVIDER_CONFIG_KEY,
      connectionId: CONNECTION_ID,
      data: {
        channel: CHANNEL_ID,
        text: "self heal",
      },
    });
  });

  it("returns 404 not_found when self-heal cannot recover a Slack team id", async () => {
    getWorkspaceIntegrationMock.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      provider: "slack",
      connectionId: CONNECTION_ID,
      providerConfigKey: PROVIDER_CONFIG_KEY,
      installationId: null,
      metadata: {
        workspaceName: "Slack Proxy Test",
      },
      createdAt: new Date("2026-04-14T00:00:00.000Z"),
      updatedAt: new Date("2026-04-14T00:00:00.000Z"),
    });
    getSlackConnectionIdentityMock.mockResolvedValue({
      teamId: null,
      enterpriseId: null,
      botUserId: null,
      workspaceName: null,
      workspaceUrl: null,
    });

    const { POST } = await loadRouteModule();
    const response = await POST(
      buildRequest({
        workspaceId: WORKSPACE_ID,
        endpoint: "/chat.postMessage",
        method: "POST",
        data: {
          channel: CHANNEL_ID,
          text: "self heal fails",
        },
      }),
    );

    expect(response.status).toBe(404);
    await expect(readBody(response)).resolves.toEqual({
      ok: false,
      error: "Slack integration is missing team identity and auth.test failed",
      code: "not_found",
    });
    expect(getSlackConnectionIdentityMock).toHaveBeenCalledTimes(1);
    expect(upsertWorkspaceIntegrationMock).not.toHaveBeenCalled();
    expect(proxyRequestMock).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // slackTeamId-based resolution (sage webhook flow)
  // --------------------------------------------------------------------------

  const SLACK_TEAM_ID = "T024BE91L";

  it("resolves workspace by slackTeamId alone and proxies the call", async () => {
    // Sage receives a slack webhook and only has the team id from event.team —
    // it has no knowledge of cloud workspace UUIDs. This is the canonical
    // "webhook fan-out" path that v5 added.
    findSlackIntegrationByTeamIdMock.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      provider: "slack",
      connectionId: CONNECTION_ID,
      providerConfigKey: PROVIDER_CONFIG_KEY,
      installationId: null,
      metadata: {
        slackTeamId: SLACK_TEAM_ID,
        slackBotUserId: "U-BOT",
      },
      createdAt: new Date("2026-04-14T00:00:00.000Z"),
      updatedAt: new Date("2026-04-14T00:00:00.000Z"),
    });
    proxyRequestMock.mockResolvedValue({ ok: true, ts: "1700000001.000001" });

    const { POST } = await loadRouteModule();
    const response = await POST(
      buildRequest({
        slackTeamId: SLACK_TEAM_ID,
        endpoint: "/chat.postMessage",
        method: "POST",
        data: {
          channel: CHANNEL_ID,
          text: "from webhook",
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(readBody(response)).resolves.toEqual({
      ok: true,
      data: { ok: true, ts: "1700000001.000001" },
      workspaceId: WORKSPACE_ID,
    });

    expect(findSlackIntegrationByTeamIdMock).toHaveBeenCalledWith(SLACK_TEAM_ID);
    expect(getWorkspaceIntegrationMock).not.toHaveBeenCalled();
    expect(proxyRequestMock).toHaveBeenCalledTimes(1);

    // The audit row, rate-limit scope, and upstream call all use the
    // canonical UUID, not the slackTeamId the caller sent.
    const proxyCallArgs = proxyRequestMock.mock.calls[0][0];
    expect(proxyCallArgs.connectionId).toBe(CONNECTION_ID);
    expect(proxyCallArgs.providerConfigKey).toBe(PROVIDER_CONFIG_KEY);
  });

  it("prefers workspaceId UUID over slackTeamId when both are provided", async () => {
    // When a caller hits us with both, the UUID wins — zero metadata scan,
    // single-row lookup. We still assert findSlackIntegrationByTeamId is
    // NOT called so the fast-path stays fast.
    getWorkspaceIntegrationMock.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      provider: "slack",
      connectionId: CONNECTION_ID,
      providerConfigKey: PROVIDER_CONFIG_KEY,
      installationId: null,
      metadata: {
        slackTeamId: SLACK_TEAM_ID,
      },
      createdAt: new Date("2026-04-14T00:00:00.000Z"),
      updatedAt: new Date("2026-04-14T00:00:00.000Z"),
    });
    proxyRequestMock.mockResolvedValue({ ok: true, ts: "1700000002.000001" });

    const { POST } = await loadRouteModule();
    const response = await POST(
      buildRequest({
        workspaceId: WORKSPACE_ID,
        slackTeamId: SLACK_TEAM_ID,
        endpoint: "/chat.postMessage",
        method: "POST",
        data: { channel: CHANNEL_ID, text: "uuid wins" },
      }),
    );

    expect(response.status).toBe(200);
    expect(getWorkspaceIntegrationMock).toHaveBeenCalledWith(WORKSPACE_ID, "slack");
    expect(findSlackIntegrationByTeamIdMock).not.toHaveBeenCalled();
  });

  it("does not let reactions consume the same-channel message rate limit", async () => {
    getWorkspaceIntegrationMock.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      provider: "slack",
      connectionId: CONNECTION_ID,
      providerConfigKey: PROVIDER_CONFIG_KEY,
      installationId: null,
      metadata: {
        slackTeamId: SLACK_TEAM_ID,
      },
      createdAt: new Date("2026-04-14T00:00:00.000Z"),
      updatedAt: new Date("2026-04-14T00:00:00.000Z"),
    });
    proxyRequestMock.mockResolvedValue({ ok: true, ts: "1700000003.000001" });

    const { POST } = await loadRouteModule();
    const reaction = await POST(
      buildRequest({
        workspaceId: WORKSPACE_ID,
        endpoint: "/reactions.add",
        method: "POST",
        data: {
          channel: CHANNEL_ID,
          timestamp: "1700000000.000001",
          name: "eyes",
        },
      }),
    );
    const message = await POST(
      buildRequest({
        workspaceId: WORKSPACE_ID,
        endpoint: "/chat.postMessage",
        method: "POST",
        data: {
          channel: CHANNEL_ID,
          text: "reaction should not rate-limit reply",
        },
      }),
    );

    expect(reaction.status).toBe(200);
    expect(message.status).toBe(200);
    expect(proxyRequestMock).toHaveBeenCalledTimes(2);
    expect(proxyRequestMock.mock.calls[0][0].endpoint).toBe("/reactions.add");
    expect(proxyRequestMock.mock.calls[1][0].endpoint).toBe("/chat.postMessage");
  });

  it("returns 404 not_found when slackTeamId does not match any integration", async () => {
    findSlackIntegrationByTeamIdMock.mockResolvedValue(null);

    const { POST } = await loadRouteModule();
    const response = await POST(
      buildRequest({
        slackTeamId: "TUNKNOWNXX",
        endpoint: "/chat.postMessage",
        method: "POST",
        data: { channel: CHANNEL_ID, text: "no match" },
      }),
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe("not_found");
    expect(body.ok).toBe(false);
    // Reason should reference the slack team id (the identifier the caller
    // actually provided), not a UUID.
    expect(body.error).toBe("No slack integration found for team TUNKNOWNXX");
    expect(proxyRequestMock).not.toHaveBeenCalled();
  });

  it("returns 400 when slackTeamId is malformed", async () => {
    // Slack team ids have a fixed shape: "T" or "E" followed by 6+ uppercase
    // alphanumerics. "T-E2E" is NOT a valid Slack team id — the resolver
    // should reject it before touching the database so a garbage caller
    // can't force a pointless metadata scan.
    const { POST } = await loadRouteModule();
    const response = await POST(
      buildRequest({
        slackTeamId: "T-E2E",
        endpoint: "/chat.postMessage",
        method: "POST",
        data: { channel: CHANNEL_ID, text: "bad shape" },
      }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe("bad_request");
    expect(body.error).toBe("slackTeamId does not match Slack's team id format");
    expect(findSlackIntegrationByTeamIdMock).not.toHaveBeenCalled();
    expect(proxyRequestMock).not.toHaveBeenCalled();
  });

  it("returns 404 not_found when workspaceId UUID has no slack integration", async () => {
    // Caller passed a valid UUID but no row exists for that workspace and
    // provider combination. The resolver must NOT fall through to a
    // slackTeamId lookup — the caller explicitly named a workspace and
    // it doesn't exist. Returning a different workspace would be silent
    // data routing to the wrong tenant.
    getWorkspaceIntegrationMock.mockResolvedValue(null);

    const { POST } = await loadRouteModule();
    const response = await POST(
      buildRequest({
        workspaceId: WORKSPACE_ID,
        endpoint: "/chat.postMessage",
        method: "POST",
        data: { channel: CHANNEL_ID, text: "uuid missing" },
      }),
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe("not_found");
    expect(body.error).toContain(WORKSPACE_ID);
    expect(findSlackIntegrationByTeamIdMock).not.toHaveBeenCalled();
  });

  it("returns 400 when workspaceId is a valid-length string but not a UUID", async () => {
    // Schema-level enforcement. This is what sage was sending before the
    // v5 migration: event.teamId ("T-E2E") shoved into the workspaceId
    // field. Cloud now rejects it at the schema boundary with a clear
    // path-scoped message instead of silently proceeding.
    const { POST } = await loadRouteModule();
    const response = await POST(
      buildRequest({
        workspaceId: "T-E2E",
        endpoint: "/chat.postMessage",
        method: "POST",
        data: { channel: CHANNEL_ID, text: "not a uuid" },
      }),
    );

    expect(response.status).toBe(400);
    await expect(readBody(response)).resolves.toEqual({
      ok: false,
      error: "Invalid request body",
      code: "bad_request",
    });
    expect(getWorkspaceIntegrationMock).not.toHaveBeenCalled();
    expect(findSlackIntegrationByTeamIdMock).not.toHaveBeenCalled();
  });
});
