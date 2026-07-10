import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectConsoleOutput } from "./helpers/console-spy";

const TEST_TOKEN = "cloud-api-token";
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const CHANNEL_ID = "C024BE91L";
const PROVIDER_CONFIG_KEY = "slack-sage";
const CONNECTION_ID = "conn_slack_sage_123";

const { proxyRequestMock, getSlackConnectionIdentityMock } = vi.hoisted(() => ({
  proxyRequestMock: vi.fn(),
  getSlackConnectionIdentityMock: vi.fn(),
}));

vi.mock("sst", () => ({
  Resource: {
    SageCloudApiToken: { value: TEST_TOKEN },
  },
}));

vi.mock("../packages/web/lib/integrations/nango-slack.ts", () => {
  return {
    proxyRequest: proxyRequestMock,
    getSlackConnectionIdentity: getSlackConnectionIdentityMock,
  };
});

type SlackProxyRouteModule = {
  POST: (request: Request) => Promise<Response>;
};

type SlackProxyAuditModule = {
  recordSlackProxyCall: (entry: Record<string, unknown>) => void | Promise<void>;
};

async function loadRouteModule(): Promise<SlackProxyRouteModule> {
  return import(
    new URL("../packages/web/app/api/v1/proxy/slack/route.ts", import.meta.url).href
  ) as Promise<SlackProxyRouteModule>;
}

async function loadAuditModule(): Promise<SlackProxyAuditModule> {
  return import(
    new URL("../packages/web/lib/integrations/slack-proxy-audit.ts", import.meta.url).href
  ) as Promise<SlackProxyAuditModule>;
}

async function loadDbModule(): Promise<{
  setDbForTesting: (db: unknown | null) => void;
}> {
  return import(new URL("../packages/web/lib/db/index.ts", import.meta.url).href);
}

async function installTestDb() {
  const [{ createTestWorkspaceDb }, { setDbForTesting }] = await Promise.all([
    import(new URL("./helpers/slack-proxy-db.ts", import.meta.url).href),
    loadDbModule(),
  ]);

  const db = createTestWorkspaceDb();
  db.seedWorkspace({ id: WORKSPACE_ID });
  db.seedSlackIntegration({
    workspaceId: WORKSPACE_ID,
    connectionId: CONNECTION_ID,
    providerConfigKey: PROVIDER_CONFIG_KEY,
    metadataJson: JSON.stringify({
      slackTeamId: "T_SLACK_TEST",
      slackBotUserId: "U_SLACK_BOT",
      workspaceName: "Slack Proxy Test",
    }),
  });

  setDbForTesting(db as never);
  return db;
}

async function installEmptyTestDb() {
  const [{ createTestWorkspaceDb }, { setDbForTesting }] = await Promise.all([
    import(new URL("./helpers/slack-proxy-db.ts", import.meta.url).href),
    loadDbModule(),
  ]);

  const db = createTestWorkspaceDb();
  setDbForTesting(db as never);
  return db;
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
    // The module does not exist until the implementation lands.
  }

  const { setDbForTesting } = await loadDbModule();
  setDbForTesting(null);

  delete process.env.CLOUD_API_TOKEN;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.resetModules();
});

describe("slack proxy contract", () => {
  it("happy path: postMessage returns ok true with wire shape", async () => {
    await installTestDb();
    proxyRequestMock.mockResolvedValue({
      ok: true,
      channel: CHANNEL_ID,
      ts: "1713220000.000100",
    });

    const { POST } = await loadRouteModule();
    const response = await POST(
      buildRequest({
        workspaceId: WORKSPACE_ID,
        endpoint: "/chat.postMessage",
        method: "POST",
        data: {
          channel: CHANNEL_ID,
          text: "hello from the proxy contract",
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(readBody(response)).resolves.toEqual({
      ok: true,
      data: {
        ok: true,
        channel: CHANNEL_ID,
        ts: "1713220000.000100",
      },
      workspaceId: WORKSPACE_ID,
    });
    expect(proxyRequestMock).toHaveBeenCalledTimes(1);
    expect(proxyRequestMock).toHaveBeenCalledWith({
      method: "POST",
      endpoint: "/chat.postMessage",
      providerConfigKey: PROVIDER_CONFIG_KEY,
      connectionId: CONNECTION_ID,
      data: {
        channel: CHANNEL_ID,
        text: "hello from the proxy contract",
      },
    });
  });

  it("missing Authorization header returns 401 unauthorized", async () => {
    await installTestDb();

    const { POST } = await loadRouteModule();
    const response = await POST(
      buildRequest(
        {
          workspaceId: WORKSPACE_ID,
          endpoint: "/chat.postMessage",
          method: "POST",
          data: {
            channel: CHANNEL_ID,
            text: "no auth",
          },
        },
        null,
      ),
    );

    expect(response.status).toBe(401);
    await expect(readBody(response)).resolves.toMatchObject({
      ok: false,
      code: "unauthorized",
    });
  });

  it("wrong bearer token returns 403 unauthorized", async () => {
    await installTestDb();

    const { POST } = await loadRouteModule();
    const response = await POST(
      buildRequest({
        workspaceId: WORKSPACE_ID,
        endpoint: "/chat.postMessage",
        method: "POST",
        data: {
          channel: CHANNEL_ID,
          text: "wrong token",
        },
      }, "definitely-wrong"),
    );

    expect(response.status).toBe(403);
    await expect(readBody(response)).resolves.toMatchObject({
      ok: false,
      code: "unauthorized",
    });
  });

  it("disallowed endpoint users.list returns 403 forbidden", async () => {
    await installTestDb();

    const { POST } = await loadRouteModule();
    const response = await POST(
      buildRequest({
        workspaceId: WORKSPACE_ID,
        endpoint: "/users.list",
        method: "GET",
      }),
    );

    expect(response.status).toBe(403);
    await expect(readBody(response)).resolves.toMatchObject({
      ok: false,
      code: "forbidden",
    });
  });

  it("allows users.conversations GET for dynamic Sage channel access discovery", async () => {
    await installTestDb();
    proxyRequestMock.mockResolvedValue({
      ok: true,
      channels: [{ id: CHANNEL_ID, name: "pilot" }],
    });

    const { POST } = await loadRouteModule();
    const response = await POST(
      buildRequest({
        workspaceId: WORKSPACE_ID,
        endpoint: "/users.conversations",
        method: "GET",
        params: {
          user: "U_SLACK_BOT",
          types: "public_channel,private_channel",
          exclude_archived: "true",
          limit: "200",
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(readBody(response)).resolves.toEqual({
      ok: true,
      data: {
        ok: true,
        channels: [{ id: CHANNEL_ID, name: "pilot" }],
      },
      workspaceId: WORKSPACE_ID,
    });
    expect(proxyRequestMock).toHaveBeenCalledWith({
      method: "GET",
      endpoint: "/users.conversations",
      providerConfigKey: PROVIDER_CONFIG_KEY,
      connectionId: CONNECTION_ID,
      params: {
        user: "U_SLACK_BOT",
        types: "public_channel,private_channel",
        exclude_archived: "true",
        limit: "200",
      },
    });
  });

  it("unknown workspace returns 404 not_found", async () => {
    await installEmptyTestDb();

    const { POST } = await loadRouteModule();
    const response = await POST(
      buildRequest({
        workspaceId: "22222222-2222-4222-8222-222222222222",
        endpoint: "/chat.postMessage",
        method: "POST",
        data: {
          channel: CHANNEL_ID,
          text: "missing workspace",
        },
      }),
    );

    expect(response.status).toBe(404);
    await expect(readBody(response)).resolves.toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("rate limited returns 429 rate_limited with retryAfterMs", async () => {
    await installTestDb();
    proxyRequestMock.mockResolvedValue({
      ok: true,
      channel: CHANNEL_ID,
      ts: "1713220000.000200",
    });

    const { POST } = await loadRouteModule();
    const requestBody = {
      workspaceId: WORKSPACE_ID,
      endpoint: "/chat.postMessage",
      method: "POST",
      data: {
        channel: CHANNEL_ID,
        text: "same-channel burst",
      },
    };

    const first = await POST(buildRequest(requestBody));
    const second = await POST(buildRequest(requestBody));

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    const secondBody = await readBody(second);
    expect(secondBody).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
    expect(secondBody.retryAfterMs).toEqual(expect.any(Number));
    expect(Number(secondBody.retryAfterMs)).toBeGreaterThan(0);
    expect(proxyRequestMock).toHaveBeenCalledTimes(1);
  });

  it("slack ok false is passed through as slack_error", async () => {
    await installTestDb();
    proxyRequestMock.mockResolvedValue({
      ok: false,
      error: "channel_not_found",
    });

    const { POST } = await loadRouteModule();
    const response = await POST(
      buildRequest({
        workspaceId: WORKSPACE_ID,
        endpoint: "/chat.postMessage",
        method: "POST",
        data: {
          channel: CHANNEL_ID,
          text: "slack-level failure",
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(readBody(response)).resolves.toMatchObject({
      ok: false,
      code: "slack_error",
      error: "channel_not_found",
    });
  });

  it("nango throw maps to 502 upstream_error", async () => {
    await installTestDb();
    proxyRequestMock.mockRejectedValue(new Error("Nango exploded"));

    const { POST } = await loadRouteModule();
    const response = await POST(
      buildRequest({
        workspaceId: WORKSPACE_ID,
        endpoint: "/chat.postMessage",
        method: "POST",
        data: {
          channel: CHANNEL_ID,
          text: "upstream failure",
        },
      }),
    );

    expect(response.status).toBe(502);
    await expect(readBody(response)).resolves.toMatchObject({
      ok: false,
      code: "upstream_error",
    });
  });

  it("audit entry never contains data.text", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { recordSlackProxyCall } = await loadAuditModule();
    await Promise.resolve(
      recordSlackProxyCall({
        workspaceId: WORKSPACE_ID,
        endpoint: "/chat.postMessage",
        method: "POST",
        channel: CHANNEL_ID,
        httpStatus: 200,
        slackOk: true,
        latencyMs: 12,
        reason: "ok",
        data: {
          text: "secret",
        },
      }),
    );

    expect(collectConsoleOutput(logSpy, warnSpy, errorSpy)).not.toContain("secret");
  });

  it("route source uses timingSafeEqual not plain equality", () => {
    const authSource = readFileSync(
      new URL("../packages/web/lib/integrations/slack-proxy-auth.ts", import.meta.url),
      "utf8",
    );

    expect(authSource).toContain("timingSafeEqual");
    expect(authSource).not.toContain("=== process.env.CLOUD_API_TOKEN");
    expect(authSource).not.toContain("token === ");
  });
});
