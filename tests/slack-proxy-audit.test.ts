import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectConsoleOutput } from "./helpers/console-spy";

const TEST_TOKEN = "cloud-api-token";

type SlackProxyAuditModule = {
  recordSlackProxyCall: (entry: Record<string, unknown>) => void | Promise<void>;
};

type SlackProxyRouteModule = {
  POST: (request: Request) => Promise<Response>;
};

async function loadAuditModule(): Promise<SlackProxyAuditModule> {
  return import(
    new URL("../packages/web/lib/integrations/slack-proxy-audit.ts", import.meta.url).href
  ) as Promise<SlackProxyAuditModule>;
}

async function loadRouteModule(): Promise<SlackProxyRouteModule> {
  return import(
    new URL("../packages/web/app/api/v1/proxy/slack/route.ts", import.meta.url).href
  ) as Promise<SlackProxyRouteModule>;
}

function buildUnauthorizedRequest(): Request {
  return new Request("http://localhost/api/v1/proxy/slack", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      endpoint: "/chat.postMessage",
      method: "POST",
      data: {
        channel: "C024BE91L",
        text: "top secret",
      },
    }),
  });
}

beforeEach(() => {
  process.env.CLOUD_API_TOKEN = TEST_TOKEN;
});

afterEach(() => {
  delete process.env.CLOUD_API_TOKEN;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.resetModules();
});

describe("slack proxy audit", () => {
  it("records successful calls with reason ok", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { recordSlackProxyCall } = await loadAuditModule();

    await Promise.resolve(
      recordSlackProxyCall({
        workspaceId: "11111111-1111-4111-8111-111111111111",
        endpoint: "/chat.postMessage",
        method: "POST",
        channel: "C024BE91L",
        httpStatus: 200,
        slackOk: true,
        latencyMs: 12,
        reason: "ok",
      }),
    );

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls[0]?.[0]).toBe("Slack proxy request completed");
    expect(logSpy.mock.calls[0]?.[1]).toMatchObject({
      area: "slack-proxy",
      route: "/api/v1/proxy/slack",
      reason: "ok",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      endpoint: "/chat.postMessage",
      method: "POST",
      channel: "C024BE91L",
      httpStatus: 200,
      slackOk: true,
      latencyMs: 12,
    });
  });

  it.each([
    "unauthorized",
    "forbidden",
    "rate_limited",
    "not_found",
    "slack_error",
    "upstream_error",
    "bad_request",
  ] as const)("records failure reason %s", async (reason) => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { recordSlackProxyCall } = await loadAuditModule();

    await Promise.resolve(
      recordSlackProxyCall({
        workspaceId: "11111111-1111-4111-8111-111111111111",
        endpoint: "/chat.postMessage",
        method: "POST",
        channel: "C024BE91L",
        httpStatus: reason === "rate_limited" ? 429 : 400,
        errorCode: reason,
        latencyMs: 9,
        reason,
      }),
    );

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toBe("Slack proxy request failed");
    expect(warnSpy.mock.calls[0]?.[1]).toMatchObject({
      reason,
      errorCode: reason,
      area: "slack-proxy",
      route: "/api/v1/proxy/slack",
    });
  });

  it("does not include data.text in logged output", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { recordSlackProxyCall } = await loadAuditModule();

    await Promise.resolve(
      recordSlackProxyCall({
        workspaceId: "11111111-1111-4111-8111-111111111111",
        endpoint: "/chat.postMessage",
        method: "POST",
        channel: "C024BE91L",
        httpStatus: 200,
        slackOk: true,
        latencyMs: 4,
        reason: "ok",
        data: {
          text: "secret-message",
        },
      }),
    );

    expect(collectConsoleOutput(logSpy, warnSpy, errorSpy)).not.toContain("secret-message");
  });

  it("does not include params in logged output", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { recordSlackProxyCall } = await loadAuditModule();

    await Promise.resolve(
      recordSlackProxyCall({
        workspaceId: "11111111-1111-4111-8111-111111111111",
        endpoint: "/conversations.history",
        method: "GET",
        channel: "C024BE91L",
        httpStatus: 400,
        errorCode: "bad_request",
        latencyMs: 4,
        reason: "bad_request",
        params: {
          cursor: "secret-cursor",
        },
      }),
    );

    const output = collectConsoleOutput(logSpy, warnSpy, errorSpy);
    expect(output).not.toContain("secret-cursor");
    expect(output).not.toContain("\"params\"");
  });

  it("records workspaceId '(unknown)' for auth failures", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { POST } = await loadRouteModule();

    const response = await POST(buildUnauthorizedRequest());

    expect(response.status).toBe(401);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toBe("Slack proxy request failed");
    expect(warnSpy.mock.calls[0]?.[1]).toMatchObject({
      workspaceId: "(unknown)",
      endpoint: "(unknown)",
      reason: "unauthorized",
      httpStatus: 401,
      errorCode: "unauthorized",
    });
  });
});
