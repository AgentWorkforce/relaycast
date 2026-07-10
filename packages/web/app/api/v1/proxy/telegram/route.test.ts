import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  getWorkspaceIntegration: vi.fn(),
  telegramProxyRequest: vi.fn(),
  getProviderConfigKey: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  getWorkspaceIntegration: mocks.getWorkspaceIntegration,
}));

vi.mock("@/lib/integrations/nango-telegram", () => ({
  telegramProxyRequest: mocks.telegramProxyRequest,
}));

vi.mock("@/lib/integrations/nango-service", () => ({
  getProviderConfigKey: mocks.getProviderConfigKey,
}));

import { POST } from "./route";

const goodAuth = {
  userId: "user_test",
  workspaceId: "ws_test",
  organizationId: "org_test",
  source: "token" as const,
};

const goodIntegration = {
  workspaceId: "ws_test",
  provider: "telegram",
  connectionId: "telegram-conn-1",
  providerConfigKey: "telegram-relay",
  installationId: null,
  metadata: {},
  createdAt: new Date(),
  updatedAt: new Date(),
};

function createRequest(body: unknown): Request {
  return new Request("http://localhost/api/v1/proxy/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/v1/proxy/telegram", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.getProviderConfigKey.mockReturnValue("telegram-relay");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when auth cannot be resolved", async () => {
    mocks.resolveRequestAuth.mockResolvedValue(null);

    const response = await POST(
      createRequest({
        endpoint: "sendMessage",
        method: "POST",
        data: { chat_id: "123", text: "hi" },
      }) as never,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "unauthorized",
    });
  });

  it("returns 400 for non-allowlisted Bot API methods", async () => {
    mocks.resolveRequestAuth.mockResolvedValue(goodAuth);

    const response = await POST(
      createRequest({
        endpoint: "deleteEverything",
        method: "POST",
      }) as never,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "bad_request",
      error: "Telegram endpoint /deleteEverything is not allowlisted",
    });
    expect(mocks.getWorkspaceIntegration).not.toHaveBeenCalled();
  });

  it("returns 404 when the workspace has no Telegram integration", async () => {
    mocks.resolveRequestAuth.mockResolvedValue(goodAuth);
    mocks.getWorkspaceIntegration.mockResolvedValue(null);

    const response = await POST(
      createRequest({
        endpoint: "sendMessage",
        method: "POST",
        data: { chat_id: "123", text: "hi" },
      }) as never,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "not_connected",
    });
  });

  it("routes rich Telegram methods through the workspace Nango connection", async () => {
    mocks.resolveRequestAuth.mockResolvedValue(goodAuth);
    mocks.getWorkspaceIntegration.mockResolvedValue(goodIntegration);
    mocks.telegramProxyRequest.mockResolvedValue({
      ok: true,
      result: true,
    });

    const response = await POST(
      createRequest({
        endpoint: "setMyCommands",
        method: "POST",
        data: {
          commands: [
            { command: "review", description: "Start a review" },
            { command: "status", description: "Show status" },
          ],
        },
      }) as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: { ok: true, result: true },
      workspaceId: "ws_test",
    });
    expect(mocks.telegramProxyRequest).toHaveBeenCalledWith({
      method: "POST",
      endpoint: "/setMyCommands",
      providerConfigKey: "telegram-relay",
      connectionId: "telegram-conn-1",
      data: {
        commands: [
          { command: "review", description: "Start a review" },
          { command: "status", description: "Show status" },
        ],
      },
    });
  });

  it("supports inline query and reaction endpoints", async () => {
    mocks.resolveRequestAuth.mockResolvedValue(goodAuth);
    mocks.getWorkspaceIntegration.mockResolvedValue(goodIntegration);
    mocks.telegramProxyRequest.mockResolvedValue({ ok: true, result: true });

    const inlineResponse = await POST(
      createRequest({
        endpoint: "answerInlineQuery",
        method: "POST",
        data: {
          inline_query_id: "iq_1",
          results: [{ type: "article", id: "1", title: "Run", input_message_content: { message_text: "Run" } }],
        },
      }) as never,
    );
    expect(inlineResponse.status).toBe(200);

    const reactionResponse = await POST(
      createRequest({
        endpoint: "setMessageReaction",
        method: "POST",
        data: {
          chat_id: "123",
          message_id: 42,
          reaction: [{ type: "emoji", emoji: "\u{1F44D}" }],
        },
      }) as never,
    );
    expect(reactionResponse.status).toBe(200);
  });

  it("surfaces Telegram ok:false responses as telegram_error", async () => {
    mocks.resolveRequestAuth.mockResolvedValue(goodAuth);
    mocks.getWorkspaceIntegration.mockResolvedValue(goodIntegration);
    mocks.telegramProxyRequest.mockResolvedValue({
      ok: false,
      description: "Bad Request: chat not found",
      error_code: 400,
    });

    const response = await POST(
      createRequest({
        endpoint: "sendMessage",
        method: "POST",
        data: { chat_id: "missing", text: "hi" },
      }) as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "telegram_error",
      error: "Bad Request: chat not found",
    });
  });

  it("returns 502 when Nango proxying throws", async () => {
    mocks.resolveRequestAuth.mockResolvedValue(goodAuth);
    mocks.getWorkspaceIntegration.mockResolvedValue(goodIntegration);
    mocks.telegramProxyRequest.mockRejectedValue(new Error("Nango failed"));

    const response = await POST(
      createRequest({
        endpoint: "sendMessage",
        method: "POST",
        data: { chat_id: "123", text: "hi" },
      }) as never,
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "upstream_error",
    });
  });
});
