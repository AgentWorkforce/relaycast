import assert from "node:assert/strict";
import { test, vi } from "vitest";

import { WorkspaceGatewayDO } from "../src/durable-object.js";
import {
  createLinkedSockets,
  FakeDurableObjectState,
} from "./support/fake-cloudflare.js";

test("relaycast RPC refreshes an expiring agent token before sending", async () => {
  const state = new FakeDurableObjectState();
  const gateway = new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    RELAYAUTH_URL: "https://relayauth.test",
    RELAYCAST_URL: "https://relaycast.test",
    AGENT_GATEWAY_BASE_URL: "http://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
  } as never);

  await gateway["persistAuthenticatedSession"]({
    workspace: "support",
    agentId: "agent-a",
    agentName: "agent-a",
    accessToken: "token-old",
    refreshToken: "refresh-old",
    accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; authorization: string | null; body: string }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      authorization: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "",
    });

    if (url === "https://relayauth.test/v1/tokens/refresh") {
      return Response.json({
        accessToken: "token-new",
        refreshToken: "refresh-new",
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        refreshTokenExpiresAt: new Date(Date.now() + 172_800_000).toISOString(),
        tokenType: "Bearer",
      });
    }

    if (url === "https://relaycast.test/v1/channels/ops/messages") {
      return Response.json({ id: "msg-1" });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const result = await gateway["postRelaycastChannelMessage"]("agent-a", "ops", "hello");
    assert.deepEqual(result, { id: "msg-1" });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.url, "https://relayauth.test/v1/tokens/refresh");
  assert.equal(calls[1]?.url, "https://relaycast.test/v1/channels/ops/messages");
  assert.equal(calls[1]?.authorization, "Bearer token-new");
  assert.equal(JSON.parse(calls[1]?.body ?? "{}").text, "hello");

  const persisted = await state.storage.get<{
    agents: Record<string, { accessToken?: string; refreshToken?: string }>;
  }>("workspace-state");
  assert.equal(persisted?.agents["agent-a"]?.accessToken, "token-new");
  assert.equal(persisted?.agents["agent-a"]?.refreshToken, "refresh-new");
});

test("structured logs are written to the canonical /_logs workspace path", async () => {
  const state = new FakeDurableObjectState();
  const gateway = new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    RELAYAUTH_URL: "https://relayauth.test",
    RELAYFILE_URL: "https://relayfile.test",
    AGENT_GATEWAY_BASE_URL: "http://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
  } as never);

  await gateway["persistAuthenticatedSession"]({
    workspace: "support",
    agentId: "agent-a",
    agentName: "agent-a",
    accessToken: "relayfile-token",
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });

  const originalFetch = globalThis.fetch;
  const writes: Array<{ url: string; method: string; authorization: string | null; body: string }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET") {
      return Response.json(
        {
          error: {
            code: "not_found",
            message: "file not found",
          },
        },
        { status: 404 },
      );
    }

    writes.push({
      url,
      method,
      authorization: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "",
    });
    return Response.json({
      opId: "op_logs_1",
      status: "queued",
    });
  };

  try {
    await gateway["handleStructuredLog"]("agent-a", {
      ts: "2026-05-12T09:00:00.000Z",
      level: "info",
      workspace: "support",
      agentId: "agent-a",
      msg: "handled event",
      traceId: "trace-1",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(writes.length, 1);
  assert.equal(
    writes[0]?.url,
    "https://relayfile.test/v1/workspaces/support/fs/file?path=%2F_logs%2Fsupport%2F2026-05-12.jsonl",
  );
  assert.equal(writes[0]?.method, "PUT");
  assert.equal(writes[0]?.authorization, "Bearer relayfile-token");
  const payload = JSON.parse(writes[0]?.body ?? "{}") as { content: string };
  const logEntry = JSON.parse(payload.content.trim()) as Record<string, unknown>;
  assert.equal(logEntry.msg, "handled event");
  assert.equal(logEntry.traceId, "trace-1");
});

test("an expired token that cannot refresh clears the session and closes the socket", async () => {
  const state = new FakeDurableObjectState();
  const gateway = new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    RELAYAUTH_URL: "https://relayauth.test",
    RELAYCAST_URL: "https://relaycast.test",
    AGENT_GATEWAY_BASE_URL: "http://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
  } as never);

  await gateway["persistAuthenticatedSession"]({
    workspace: "support",
    agentId: "agent-a",
    agentName: "agent-a",
    accessToken: "token-expired",
    refreshToken: "refresh-expired",
    accessTokenExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    refreshTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  const sockets = createLinkedSockets();
  let closeReason = "";
  sockets.client.onclose = (event) => {
    closeReason = event.reason;
  };
  sockets.server.serializeAttachment({
    workspace: "support",
    agentId: "agent-a",
    agentName: "agent-a",
    authenticated: true,
    legacyProtocol: false,
  });
  state.acceptWebSocket(sockets.server);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === "https://relayauth.test/v1/tokens/refresh") {
      return Response.json(
        {
          error: {
            code: "revoked",
            message: "refresh token revoked",
          },
        },
        { status: 401 },
      );
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    await assert.rejects(
      gateway["postRelaycastChannelMessage"]("agent-a", "ops", "hello"),
      /relayauth request failed \(401\) \/v1\/tokens\/refresh/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(closeReason, "agent token refresh failed");
  const persisted = await state.storage.get<{
    agents: Record<string, { accessToken?: string }>;
  }>("workspace-state");
  assert.equal(persisted?.agents["agent-a"]?.accessToken, undefined);
});

test("revoked agent token closes the socket on the 5 second maintenance cadence", async () => {
  vi.useFakeTimers();

  const state = new FakeDurableObjectState();
  const gateway = new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    RELAYAUTH_URL: "https://relayauth.test",
    RELAYCAST_URL: "https://relaycast.test",
    AGENT_GATEWAY_BASE_URL: "http://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
  } as never);

  const agentToken = createJwt({
    sub: "agent-a",
    org: "org_support",
    wks: "support",
    jti: "relay_ag_jti_1",
    sponsorId: "workspace-token",
    sponsorChain: ["workspace-token"],
    scopes: ["relayauth:token:read:*", "relaycast:channel:send:*"],
  });

  await gateway["persistAuthenticatedSession"]({
    workspace: "support",
    agentId: "agent-a",
    agentName: "agent-a",
    accessToken: agentToken,
    refreshToken: "refresh-alive",
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });

  const sockets = createLinkedSockets();
  let closeReason = "";
  sockets.client.onclose = (event) => {
    closeReason = event.reason;
  };
  sockets.server.serializeAttachment({
    workspace: "support",
    agentId: "agent-a",
    agentName: "agent-a",
    authenticated: true,
    legacyProtocol: false,
  });
  state.acceptWebSocket(sockets.server);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/tokens/introspect") {
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        `Bearer ${agentToken}`,
      );
      return Response.json({
        active: false,
        revoked: true,
        reason: "workspace_token_revoked",
        claims: {
          sub: "agent-a",
          org: "org_support",
          wks: "support",
          jti: "relay_ag_jti_1",
          sponsorId: "workspace-token",
          sponsorChain: ["workspace-token"],
          scopes: ["relayauth:token:read:*", "relaycast:channel:send:*"],
        },
      });
    }

    throw new Error(`Unexpected fetch: ${String(input)}`);
  };

  try {
    const persisted = await state.storage.get("workspace-state");
    await gateway["scheduleNextAlarm"](persisted as never);
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.resolve();
  } finally {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  }

  assert.equal(closeReason, "agent token revoked");
  const persisted = await state.storage.get<{
    agents: Record<string, { accessToken?: string }>;
  }>("workspace-state");
  assert.equal(persisted?.agents["agent-a"]?.accessToken, undefined);
});

function createJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" }), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify(payload), "utf8").toString("base64url"),
    "signature",
  ].join(".");
}
