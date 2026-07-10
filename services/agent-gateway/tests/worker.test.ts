import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "vitest";

import worker from "../src/worker.js";

test("relayfile VFS watch ingress verifies HMAC and forwards to the workspace durable object", async () => {
  const forwarded: Request[] = [];
  const stub = {
    async fetch(request: Request): Promise<Response> {
      forwarded.push(request);
      return Response.json({ ok: true, data: { matched: 1 } });
    },
  };
  const secret = "relayfile-hmac-secret";
  const timestamp = new Date().toISOString();
  const body = JSON.stringify({
    workspaceId: "support",
    path: "/github/issues/opened/42.json",
    writeId: "write-42",
    occurredAt: "2026-05-21T12:00:00.000Z",
    provider: "github",
    eventType: "issues.opened",
  });
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}\n${body}`)
    .digest("hex");

  const response = await worker.fetch(
    new Request("https://agent-gateway.test/internal/vfs/watch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-relay-timestamp": timestamp,
        "x-relay-signature": signature,
      },
      body,
    }),
    {
      RELAYAUTH_URL: "https://relayauth.test",
      AGENT_GATEWAY_BASE_URL: "https://agent-gateway.test",
      AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
      RELAYFILE_INTERNAL_HMAC_SECRET: secret,
      WORKSPACE_GATEWAY_DO: {
        idFromName(name: string) {
          return name;
        },
        get() {
          return stub;
        },
      } as never,
    },
  );

  assert.equal(response.status, 200);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0]?.url, "https://agent-gateway.internal/internal/vfs-watch");
  assert.equal(forwarded[0]?.headers.get("x-agent-gateway-workspace"), "support");
});

test("relaycron webhook ingress builds a cron envelope and forwards it to internal enqueue", async () => {
  const forwarded: Request[] = [];
  const stub = {
    async fetch(request: Request): Promise<Response> {
      forwarded.push(request);
      return Response.json({ ok: true }, { status: 202 });
    },
  };

  const response = await worker.fetch(
    new Request("https://agent-gateway.test/internal/cron/tick", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-gateway-secret": "internal-test-secret",
        "x-agentcron-delivery": "delivery-123",
        traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
      },
      body: JSON.stringify({
        workspace: "support",
        agentId: "support-agent",
        gatewayScheduleId: "sched-123",
        schedule: "*/5 * * * *",
        scheduledFor: "2026-05-11T12:00:00.000Z",
      }),
    }),
    {
      RELAYAUTH_URL: "https://relayauth.test",
      AGENT_GATEWAY_BASE_URL: "https://agent-gateway.test",
      AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
      RELAY_OTEL_ENABLED: "1",
      RELAY_OTEL_EXPORTER: "none",
      WORKSPACE_GATEWAY_DO: {
        idFromName(name: string) {
          return name;
        },
        get() {
          return stub;
        },
      } as never,
    },
  );

  assert.equal(response.status, 202);
  assert.equal(forwarded.length, 1);

  const forwardedRequest = forwarded[0];
  assert.equal(forwardedRequest.url, "https://agent-gateway.internal/internal/enqueue");
  assert.equal(forwardedRequest.method, "POST");

  const payload = await forwardedRequest.json() as {
    agentId: string;
    event: {
      type: string;
      resource: { path: string; provider: string };
      schedule: string;
      scheduledFor: string;
      id: string;
    };
  };

  assert.equal(payload.agentId, "support-agent");
  assert.equal(payload.event.type, "cron.tick");
  assert.equal(payload.event.resource.path, "/_cron/sched-123");
  assert.equal(payload.event.resource.provider, "internal");
  assert.equal(payload.event.schedule, "*/5 * * * *");
  assert.equal(payload.event.scheduledFor, "2026-05-11T12:00:00.000Z");
  assert.equal(payload.event.id, "delivery-123");
});

test("relaycron webhook ingress preserves one-shot schedule semantics", async () => {
  const forwarded: Request[] = [];
  const stub = {
    async fetch(request: Request): Promise<Response> {
      forwarded.push(request);
      return Response.json({ ok: true }, { status: 202 });
    },
  };

  const response = await worker.fetch(
    new Request("https://agent-gateway.test/internal/cron/tick", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-gateway-secret": "internal-test-secret",
        "x-agentcron-delivery": "delivery-oneshot",
      },
      body: JSON.stringify({
        workspace: "support",
        agentId: "support-agent",
        gatewayScheduleId: "sched-oneshot",
        schedule: "oneshot:2026-05-11T12:00:00.000Z",
        scheduleType: "once",
        scheduledFor: "2026-05-11T12:00:00.000Z",
      }),
    }),
    {
      RELAYAUTH_URL: "https://relayauth.test",
      AGENT_GATEWAY_BASE_URL: "https://agent-gateway.test",
      AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
      WORKSPACE_GATEWAY_DO: {
        idFromName(name: string) {
          return name;
        },
        get() {
          return stub;
        },
      } as never,
    },
  );

  assert.equal(response.status, 202);
  const forwardedRequest = forwarded[0];
  const payload = await forwardedRequest.json() as {
    event: {
      schedule: string;
      scheduleType: string;
    };
  };

  assert.equal(payload.event.schedule, "oneshot:2026-05-11T12:00:00.000Z");
  assert.equal(payload.event.scheduleType, "once");
});

test("relaycron webhook ingress accepts the internal secret from the registered callback URL", async () => {
  const forwarded: Request[] = [];
  const stub = {
    async fetch(request: Request): Promise<Response> {
      forwarded.push(request);
      return Response.json({ ok: true }, { status: 202 });
    },
  };

  const response = await worker.fetch(
    new Request(
      "https://agent-gateway.test/internal/cron/tick"
        + "?internal_token=internal-test-secret"
        + "&workspace=support"
        + "&agent_id=support-agent"
        + "&gateway_schedule_id=sched-query-token"
        + "&schedule=*/5%20*%20*%20*%20*",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace: "attacker-workspace",
          agentId: "attacker-agent",
          gatewayScheduleId: "attacker-schedule",
          schedule: "*/1 * * * *",
        }),
      },
    ),
    {
      RELAYAUTH_URL: "https://relayauth.test",
      AGENT_GATEWAY_BASE_URL: "https://agent-gateway.test",
      AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
      WORKSPACE_GATEWAY_DO: {
        idFromName(name: string) {
          return name;
        },
        get() {
          return stub;
        },
      } as never,
    },
  );

  assert.equal(response.status, 202);
  assert.equal(forwarded.length, 1);
  const forwardedPayload = await forwarded[0]!.json() as {
    agentId: string;
    event: { resource: { path: string }; schedule: string };
  };
  assert.equal(forwardedPayload.agentId, "support-agent");
  assert.equal(forwardedPayload.event.resource.path, "/_cron/sched-query-token");
  assert.equal(forwardedPayload.event.schedule, "*/5 * * * *");
});

test("internal secret query fallback is scoped to relaycron webhook ingress", async () => {
  await assert.rejects(
    () => worker.fetch(
      new Request("https://agent-gateway.test/v1/workspaces/support/metrics?internal_token=internal-test-secret"),
      {
        RELAYAUTH_URL: "https://relayauth.test",
        AGENT_GATEWAY_BASE_URL: "https://agent-gateway.test",
        AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
        WORKSPACE_GATEWAY_DO: {
          idFromName(name: string) {
            return name;
          },
          get() {
            throw new Error("query token must not grant internal metrics access");
          },
        } as never,
      },
    ),
    /Workspace token is required/,
  );
});

test("POST /v1/watch directs callers to the websocket control plane", async () => {
  const response = await worker.fetch(
    new Request("https://agent-gateway.test/v1/watch", {
      method: "POST",
    }),
    {
      RELAYAUTH_URL: "https://relayauth.test",
      AGENT_GATEWAY_BASE_URL: "https://agent-gateway.test",
      AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
      WORKSPACE_GATEWAY_DO: {} as never,
    },
  );

  assert.equal(response.status, 501);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: {
      code: "not_implemented",
      message: "watch registration is handled over the gateway websocket in M2",
    },
  });
});

test("POST /v1/inbox directs callers to the websocket control plane", async () => {
  const response = await worker.fetch(
    new Request("https://agent-gateway.test/v1/inbox", {
      method: "POST",
    }),
    {
      RELAYAUTH_URL: "https://relayauth.test",
      AGENT_GATEWAY_BASE_URL: "https://agent-gateway.test",
      AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
      WORKSPACE_GATEWAY_DO: {} as never,
    },
  );

  assert.equal(response.status, 501);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: {
      code: "not_implemented",
      message: "inbox registration is handled over the gateway websocket in M3",
    },
  });
});

test("GET /v1/workspaces/:workspace/metrics proxies to the workspace durable object", async () => {
  const forwarded: Request[] = [];
  const stub = {
    async fetch(request: Request): Promise<Response> {
      forwarded.push(request);
      return Response.json({
        ok: true,
        data: {
          workspace: "support",
          totals: {
            eventsReceivedTotal: 3,
          },
        },
      });
    },
  };

  const response = await worker.fetch(
    new Request("https://agent-gateway.test/v1/workspaces/support/metrics?agentId=agent-a&windowMinutes=120", {
      method: "GET",
      headers: {
        "x-agent-gateway-secret": "internal-test-secret",
      },
    }),
    {
      RELAYAUTH_URL: "https://relayauth.test",
      AGENT_GATEWAY_BASE_URL: "https://agent-gateway.test",
      AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
      WORKSPACE_GATEWAY_DO: {
        idFromName(name: string) {
          return name;
        },
        get() {
          return stub;
        },
      } as never,
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    data: {
      workspace: "support",
      totals: {
        eventsReceivedTotal: 3,
      },
    },
  });

  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0]?.url, "https://agent-gateway.internal/metrics?agentId=agent-a&windowMinutes=120");
  assert.equal(forwarded[0]?.method, "GET");
  assert.equal(
    forwarded[0]?.headers.get("x-agent-gateway-workspace"),
    "support",
  );
});

test("GET /v1/workspaces/:workspace/agents inspector routes proxy to the workspace durable object", async () => {
  const forwarded: Request[] = [];
  const stub = {
    async fetch(request: Request): Promise<Response> {
      forwarded.push(request);
      return Response.json({
        ok: true,
        data: {
          events: [],
        },
      });
    },
  };

  const response = await worker.fetch(
    new Request("https://agent-gateway.test/v1/workspaces/support/agents/agent-a/events", {
      method: "GET",
      headers: {
        "x-agent-gateway-secret": "internal-test-secret",
      },
    }),
    {
      RELAYAUTH_URL: "https://relayauth.test",
      AGENT_GATEWAY_BASE_URL: "https://agent-gateway.test",
      AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
      WORKSPACE_GATEWAY_DO: {
        idFromName(name: string) {
          return name;
        },
        get() {
          return stub;
        },
      } as never,
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    data: {
      events: [],
    },
  });
  assert.equal(forwarded.length, 1);
  assert.equal(
    forwarded[0]?.url,
    "https://agent-gateway.internal/agents/agent-a/events",
  );
  assert.equal(
    forwarded[0]?.headers.get("x-agent-gateway-workspace"),
    "support",
  );
  assert.equal(
    forwarded[0]?.headers.get("x-agent-gateway-agent-id"),
    "agent-a",
  );
});

test("POST /internal/workspaces/:workspace/costs proxies cost samples to the workspace durable object", async () => {
  const forwarded: Request[] = [];
  const stub = {
    async fetch(request: Request): Promise<Response> {
      forwarded.push(request);
      return Response.json({ ok: true });
    },
  };

  const response = await worker.fetch(
    new Request("https://agent-gateway.test/internal/workspaces/support/costs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-gateway-secret": "internal-test-secret",
      },
      body: JSON.stringify({
        agentId: "agent-a",
        eventType: "cron.tick",
        costUsd: 0.42,
        inputTokens: 12,
        outputTokens: 8,
        occurredAt: "2026-05-12T10:06:00.000Z",
      }),
    }),
    {
      RELAYAUTH_URL: "https://relayauth.test",
      AGENT_GATEWAY_BASE_URL: "https://agent-gateway.test",
      AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
      WORKSPACE_GATEWAY_DO: {
        idFromName(name: string) {
          return name;
        },
        get() {
          return stub;
        },
      } as never,
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0]?.url, "https://agent-gateway.internal/internal/cost");
  assert.equal(forwarded[0]?.method, "POST");
  assert.equal(
    forwarded[0]?.headers.get("x-agent-gateway-workspace"),
    "support",
  );
  assert.deepEqual(await forwarded[0]!.json(), {
    agentId: "agent-a",
    eventType: "cron.tick",
    costUsd: 0.42,
    inputTokens: 12,
    outputTokens: 8,
    occurredAt: "2026-05-12T10:06:00.000Z",
  });
});

test("GET /v1/workspaces/:workspace/dlq lists relayfile-backed DLQ records", async () => {
  const originalFetch = globalThis.fetch;
  const seen: Request[] = [];

  globalThis.fetch = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    seen.push(request);

    if (request.url.includes("/fs/query?")) {
      return Response.json({
        items: [{
          path: "/_dlq/support/evt_123.json",
          revision: "rev-1",
          contentType: "application/json",
          size: 128,
          lastEditedAt: "2026-05-12T10:10:00.000Z",
        }],
        nextCursor: null,
      });
    }

    throw new Error(`Unexpected request: ${request.url}`);
  }) as typeof globalThis.fetch;

  try {
    const response = await worker.fetch(
      new Request("https://agent-gateway.test/v1/workspaces/support/dlq", {
        method: "GET",
        headers: {
          "x-agent-gateway-secret": "internal-test-secret",
          "x-relayfile-token": "relay_ws_test",
        },
      }),
      {
        RELAYAUTH_URL: "https://relayauth.test",
        RELAYFILE_URL: "https://relayfile.test",
        AGENT_GATEWAY_BASE_URL: "https://agent-gateway.test",
        AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
        WORKSPACE_GATEWAY_DO: {} as never,
      },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      data: {
        workspace: "support",
        items: [{
          eventId: "evt_123",
          path: "/_dlq/support/evt_123.json",
          revision: "rev-1",
          contentType: "application/json",
          size: 128,
          lastEditedAt: "2026-05-12T10:10:00.000Z",
        }],
        nextCursor: null,
      },
    });
    assert.match(seen[0]!.url, /\/v1\/workspaces\/support\/fs\/query\?/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /v1/workspaces/:workspace/dlq/:eventId/replay reloads the record and re-enqueues it", async () => {
  const originalFetch = globalThis.fetch;
  const relayfileRequests: Request[] = [];
  const forwarded: Request[] = [];
  const stub = {
    async fetch(request: Request): Promise<Response> {
      forwarded.push(request);
      return Response.json({ ok: true }, { status: 202 });
    },
  };

  globalThis.fetch = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    relayfileRequests.push(request);

    if (request.url.includes("/fs/file?")) {
      return Response.json({
        path: "/_dlq/support/evt_123.json",
        revision: "rev-1",
        contentType: "application/json",
        content: JSON.stringify({
          agentId: "support-agent",
          event: {
            id: "evt_123",
            workspace: "support",
            type: "cron.tick",
            occurredAt: "2026-05-12T10:00:00.000Z",
            attempt: 5,
            resource: {
              path: "/_cron/sched-1",
              kind: "cron.tick",
              id: "sched-1",
              provider: "internal",
            },
            summary: {
              title: "cron tick",
            },
            schedule: "*/5 * * * *",
            scheduledFor: "2026-05-12T10:00:00.000Z",
          },
        }),
      });
    }

    throw new Error(`Unexpected request: ${request.url}`);
  }) as typeof globalThis.fetch;

  try {
    const response = await worker.fetch(
      new Request("https://agent-gateway.test/v1/workspaces/support/dlq/evt_123/replay", {
        method: "POST",
        headers: {
          "x-agent-gateway-secret": "internal-test-secret",
          "x-relayfile-token": "relay_ws_test",
        },
      }),
      {
        RELAYAUTH_URL: "https://relayauth.test",
        RELAYFILE_URL: "https://relayfile.test",
        AGENT_GATEWAY_BASE_URL: "https://agent-gateway.test",
        AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
        WORKSPACE_GATEWAY_DO: {
          idFromName(name: string) {
            return name;
          },
          get() {
            return stub;
          },
        } as never,
      },
    );

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(relayfileRequests.length, 1);
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0]!.url, "https://agent-gateway.internal/internal/enqueue");
    assert.deepEqual(await forwarded[0]!.json(), {
      agentId: "support-agent",
      event: {
        id: "evt_123",
        workspace: "support",
        type: "cron.tick",
        occurredAt: "2026-05-12T10:00:00.000Z",
        attempt: 5,
        resource: {
          path: "/_cron/sched-1",
          kind: "cron.tick",
          id: "sched-1",
          provider: "internal",
        },
        summary: {
          title: "cron tick",
        },
        schedule: "*/5 * * * *",
        scheduledFor: "2026-05-12T10:00:00.000Z",
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DELETE /v1/workspaces/:workspace/dlq purges all relayfile pages", async () => {
  const originalFetch = globalThis.fetch;
  const queryCursors: Array<string | null> = [];
  const deletedPaths: string[] = [];

  globalThis.fetch = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname.endsWith("/fs/query")) {
      const cursor = url.searchParams.get("cursor");
      queryCursors.push(cursor);
      if (!cursor) {
        return Response.json({
          items: [
            { path: "/_dlq/support/evt_1.json", revision: "rev-1" },
          ],
          nextCursor: "page-2",
        });
      }
      return Response.json({
        items: [
          { path: "/_dlq/support/evt_2.json", revision: "rev-2" },
        ],
        nextCursor: null,
      });
    }

    if (request.method === "DELETE" && url.pathname.endsWith("/fs/file")) {
      deletedPaths.push(url.searchParams.get("path") ?? "");
      return Response.json({ opId: `delete-${deletedPaths.length}`, status: "queued" });
    }

    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  }) as typeof globalThis.fetch;

  try {
    const response = await worker.fetch(
      new Request("https://agent-gateway.test/v1/workspaces/support/dlq", {
        method: "DELETE",
        headers: {
          "x-agent-gateway-secret": "internal-test-secret",
          "x-relayfile-token": "relay_ws_test",
        },
      }),
      {
        RELAYAUTH_URL: "https://relayauth.test",
        RELAYFILE_URL: "https://relayfile.test",
        AGENT_GATEWAY_BASE_URL: "https://agent-gateway.test",
        AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
        WORKSPACE_GATEWAY_DO: {} as never,
      },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      data: {
        workspace: "support",
        deleted: 2,
      },
    });
    assert.deepEqual(queryCursors, [null, "page-2"]);
    assert.deepEqual(deletedPaths, [
      "/_dlq/support/evt_1.json",
      "/_dlq/support/evt_2.json",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("internal DLQ routes require a dedicated relayfile token header", async () => {
  await assert.rejects(
    worker.fetch(
      new Request("https://agent-gateway.test/v1/workspaces/support/dlq", {
        method: "GET",
        headers: {
          authorization: "Bearer internal-test-secret",
        },
      }),
      {
        RELAYAUTH_URL: "https://relayauth.test",
        RELAYFILE_URL: "https://relayfile.test",
        AGENT_GATEWAY_BASE_URL: "https://agent-gateway.test",
        AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
        WORKSPACE_GATEWAY_DO: {} as never,
      },
    ),
    /workspace token is required for DLQ relayfile access/,
  );
});
