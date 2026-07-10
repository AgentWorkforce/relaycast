import assert from "node:assert/strict";
import { onTestFinished, test } from "vitest";

import { WorkspaceGatewayDO } from "../src/durable-object.js";
import {
  createLinkedSockets,
  FakeDurableObjectState,
} from "./support/fake-cloudflare.js";

test("inbox registration fans in shared channel messages and agent-specific @self messages", async () => {
  // Acking a relaycast.message envelope settles the engine-side delivery
  // ledger; stub fetch so the test never reaches the network. The deliveries
  // feed responds empty so the correlation miss is skipped quietly.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    const data = url.includes("/v1/deliveries?") ? [] : {};
    return new Response(JSON.stringify({ ok: true, data }), { status: 200 });
  }) as typeof fetch;
  onTestFinished(() => {
    globalThis.fetch = originalFetch;
  });

  const state = new FakeDurableObjectState();
  const gateway = new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    RELAYAUTH_URL: "https://relayauth.test",
    RELAYCAST_URL: "https://api.relaycast.dev",
    AGENT_GATEWAY_BASE_URL: "http://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
  } as never);

  type FakeClient = {
    agentId: string;
    accessToken: string;
    selectors: string[];
    emit(event: Record<string, unknown>): void;
  };
  const clients: FakeClient[] = [];
  gateway["relaycastClientFactory"] = ({
    agentId,
    accessToken,
  }: {
    agentId: string;
    accessToken: string;
  }) => {
    let handler: ((event: unknown) => void | Promise<void>) | null = null;
    const fake: FakeClient = {
      agentId,
      accessToken,
      selectors: [],
      emit(event) {
        if (handler) {
          void handler(event);
        }
      },
    };
    clients.push(fake);
    return {
      subscribe(channels: string[], onMessage: (event: unknown) => void | Promise<void>) {
        fake.selectors = [...channels];
        handler = onMessage;
        return {
          unsubscribe() {
            handler = null;
            fake.selectors = [];
          },
        };
      },
      disconnect() {},
    };
  };

  await gateway["persistAuthenticatedSession"]({
    workspace: "support",
    agentId: "agent-a",
    agentName: "agent-a",
    accessToken: "token-a",
  });
  await gateway["persistAuthenticatedSession"]({
    workspace: "support",
    agentId: "agent-b",
    agentName: "agent-b",
    accessToken: "token-b",
  });

  const socketA = createLinkedSockets();
  const socketB = createLinkedSockets();
  const deliveredA: Array<Record<string, unknown>> = [];
  const deliveredB: Array<Record<string, unknown>> = [];
  socketA.client.onmessage = (message) => {
    deliveredA.push(JSON.parse(String(message.data)) as Record<string, unknown>);
  };
  socketB.client.onmessage = (message) => {
    deliveredB.push(JSON.parse(String(message.data)) as Record<string, unknown>);
  };
  socketA.server.serializeAttachment({
    workspace: "support",
    agentId: "agent-a",
    agentName: "agent-a",
    authenticated: true,
    legacyProtocol: false,
  });
  socketB.server.serializeAttachment({
    workspace: "support",
    agentId: "agent-b",
    agentName: "agent-b",
    authenticated: true,
    legacyProtocol: false,
  });
  state.acceptWebSocket(socketA.server);
  state.acceptWebSocket(socketB.server);

  await gateway["handleRegister"]("agent-a", socketA.server as never, {
    type: "register",
    inbox: ["ops", "@self"],
  });
  await gateway["handleRegister"]("agent-b", socketB.server as never, {
    type: "register",
    inbox: ["ops"],
  });
  await new Promise((resolve) => setImmediate(resolve));

  const sharedClient = clients.find(
    (client) => client.agentId === "agent-a" && client.selectors.includes("ops"),
  );
  assert.ok(sharedClient, "shared channel listener should run under agent-a's identity");
  const selfClient = clients.find(
    (client) => client.agentId === "agent-a" && client.selectors.includes("@self"),
  );
  assert.ok(selfClient, "agent-a should have a @self listener");

  sharedClient.emit({
    id: "evt-channel-1",
    type: "message.created",
    channel: "ops",
    message: {
      id: "msg-channel-1",
      agentId: "usr_1",
      agentName: "Ada Lovelace",
      text: "Channel message",
      attachments: [],
    },
  });
  selfClient.emit({
    id: "evt-dm-1",
    type: "dm.received",
    conversationId: "dm-1",
    message: {
      id: "msg-dm-1",
      agentId: "usr_2",
      agentName: "Grace Hopper",
      text: "Private note",
    },
  });
  await waitForEventCount(deliveredA, 1);
  const firstEventId = deliveredA
    .filter((entry) => entry.type === "event")
    .map((entry) => (entry.event as { id: string }).id)[0];
  if (firstEventId) {
    await gateway["handleAck"]("agent-a", firstEventId);
  }
  await waitForEventCount(deliveredA, 2);
  await waitForEventCount(deliveredB, 1);

  const eventIdsA = deliveredA
    .filter((entry) => entry.type === "event")
    .map((entry) => (entry.event as { id: string }).id);
  const eventIdsB = deliveredB
    .filter((entry) => entry.type === "event")
    .map((entry) => (entry.event as { id: string }).id);
  assert.deepEqual([...eventIdsA].sort(), ["evt-channel-1", "evt-dm-1"].sort());
  assert.deepEqual(eventIdsB, ["evt-channel-1"]);
});

test("delivery.accepted events correlate the engine delivery id used on ack", async () => {
  const requests: Array<{ url: string; method: string; authorization: string | null }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({
      url: String(input instanceof Request ? input.url : input),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
    });
    return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 });
  }) as typeof fetch;
  onTestFinished(() => {
    globalThis.fetch = originalFetch;
  });

  const state = new FakeDurableObjectState();
  const gateway = new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    RELAYAUTH_URL: "https://relayauth.test",
    RELAYCAST_URL: "https://api.relaycast.test",
    AGENT_GATEWAY_BASE_URL: "http://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
  } as never);

  type FakeClient = {
    agentId: string;
    selectors: string[];
    emit(event: Record<string, unknown>): void;
    emitDeliveryAccepted(event: { deliveryId: string; messageId: string }): void;
  };
  const clients: FakeClient[] = [];
  gateway["relaycastClientFactory"] = ({ agentId }: { agentId: string }) => {
    let handler: ((event: unknown) => void | Promise<void>) | null = null;
    let deliveryHandler:
      | ((event: { deliveryId: string; messageId: string }) => void)
      | null = null;
    const fake: FakeClient = {
      agentId,
      selectors: [],
      emit(event) {
        if (handler) {
          void handler(event);
        }
      },
      emitDeliveryAccepted(event) {
        deliveryHandler?.(event);
      },
    };
    clients.push(fake);
    return {
      subscribe(channels: string[], onMessage: (event: unknown) => void | Promise<void>) {
        fake.selectors = [...channels];
        handler = onMessage;
        return {
          unsubscribe() {
            handler = null;
            fake.selectors = [];
          },
        };
      },
      onDeliveryAccepted(callback: (event: { deliveryId: string; messageId: string }) => void) {
        deliveryHandler = callback;
        return () => {
          deliveryHandler = null;
        };
      },
      disconnect() {},
    };
  };

  await gateway["persistAuthenticatedSession"]({
    workspace: "support",
    agentId: "agent-a",
    agentName: "agent-a",
    accessToken: "token-a",
  });

  const socketA = createLinkedSockets();
  const deliveredA: Array<Record<string, unknown>> = [];
  socketA.client.onmessage = (message) => {
    deliveredA.push(JSON.parse(String(message.data)) as Record<string, unknown>);
  };
  socketA.server.serializeAttachment({
    workspace: "support",
    agentId: "agent-a",
    agentName: "agent-a",
    authenticated: true,
    legacyProtocol: false,
  });
  state.acceptWebSocket(socketA.server);

  await gateway["handleRegister"]("agent-a", socketA.server as never, {
    type: "register",
    inbox: ["@self"],
  });
  await new Promise((resolve) => setImmediate(resolve));

  const selfClient = clients.find((client) => client.selectors.includes("@self"));
  assert.ok(selfClient, "agent-a should have a @self listener");

  selfClient.emitDeliveryAccepted({ deliveryId: "del-dm-1", messageId: "msg-dm-1" });
  selfClient.emit({
    id: "evt-dm-1",
    type: "dm.received",
    conversationId: "dm-1",
    message: {
      id: "msg-dm-1",
      agentId: "usr_2",
      agentName: "Grace Hopper",
      text: "Private note",
    },
  });
  await waitForEventCount(deliveredA, 1);

  await gateway["handleAck"]("agent-a", "evt-dm-1");

  assert.equal(requests.length, 1, "correlated id must be used without a feed lookup");
  assert.equal(
    requests[0].url,
    "https://api.relaycast.test/v1/deliveries/del-dm-1/ack",
  );
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].authorization, "Bearer token-a");
});

test("inbox deployment delivery skips live-agent duplicates and self-authored messages", async () => {
  const state = new FakeDurableObjectState();
  const delivered: Array<Record<string, unknown>> = [];
  const candidateCalls: Array<Record<string, unknown>> = [];
  const cloudWeb = {
    async fetch(request: Request): Promise<Response> {
      const body = await request.json() as Record<string, unknown>;
      if (request.url.endsWith("/api/internal/proactive-runtime/inbox/candidates")) {
        candidateCalls.push(body);
        return Response.json({
          ok: true,
          data: {
            agents: [
              {
                agentId: "agent-a",
                deployedName: "agent-a",
                inboxSelectors: ["ops"],
              },
              {
                agentId: "persona-b",
                deployedName: "persona-b",
                inboxSelectors: ["ops"],
              },
            ],
          },
        });
      }
      if (request.url.endsWith("/api/internal/proactive-runtime/inbox/deliver")) {
        delivered.push(body);
        return Response.json({ ok: true, data: { status: "starting" } }, { status: 202 });
      }
      return Response.json({ ok: false }, { status: 404 });
    },
  };
  const gateway = new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    CLOUD_WEB_WORKER: cloudWeb,
    RELAYAUTH_URL: "https://relayauth.test",
    AGENT_GATEWAY_BASE_URL: "http://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
  } as never);

  await state.storage.put("workspace-state", {
    workspace: "support",
    agents: {
      "agent-a": {
        agentId: "agent-a",
        agentName: "agent-a",
        workspace: "support",
        schedules: [],
        inbox: [{ selector: "ops" }],
      },
    },
    queues: {},
  });

  await gateway["handleRelaycastChannelEvent"]("support", "ops", {
    id: "evt-1",
    channel: "ops",
    messageId: "msg-1",
    text: "wake deployment",
    occurredAt: "2026-06-16T14:00:00.000Z",
    from: {
      id: "usr_1",
      displayName: "Ada",
    },
  });

  assert.deepEqual(candidateCalls, [{ workspaceId: "support", selector: "ops" }]);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.agentId, "persona-b");
  assert.equal(delivered[0]?.workspaceId, "support");
  assert.equal((delivered[0]?.payload as Record<string, unknown>).type, "relaycast.message");
  assert.equal((delivered[0]?.payload as Record<string, unknown>).channel, "ops");
  assert.equal((delivered[0]?.payload as Record<string, unknown>).messageId, "msg-1");

  await gateway["handleRelaycastChannelEvent"]("support", "ops", {
    id: "evt-2",
    channel: "ops",
    messageId: "msg-2",
    text: "self-authored",
    occurredAt: "2026-06-16T14:00:01.000Z",
    from: {
      id: "persona-b",
      displayName: "persona-b",
    },
  });

  assert.equal(delivered.length, 1, "self-authored deployment messages must not trigger that deployment");
});

test("@self inbox deployment delivery wakes only the addressed cold deployment", async () => {
  const state = new FakeDurableObjectState();
  const delivered: Array<Record<string, unknown>> = [];
  const candidateCalls: Array<Record<string, unknown>> = [];
  const cloudWeb = {
    async fetch(request: Request): Promise<Response> {
      const body = await request.json() as Record<string, unknown>;
      if (request.url.endsWith("/api/internal/proactive-runtime/inbox/candidates")) {
        candidateCalls.push(body);
        return Response.json({
          ok: true,
          data: {
            agents: [
              {
                agentId: "agent-a",
                deployedName: "agent-a",
                inboxSelectors: ["@self"],
              },
              {
                agentId: "agent-b",
                deployedName: "agent-b",
                inboxSelectors: ["@self"],
              },
              {
                agentId: "agent-c",
                deployedName: "agent-c",
                inboxSelectors: ["@self"],
              },
            ],
          },
        });
      }
      if (request.url.endsWith("/api/internal/proactive-runtime/inbox/deliver")) {
        delivered.push(body);
        return Response.json({ ok: true, data: { status: "starting" } }, { status: 202 });
      }
      return Response.json({ ok: false }, { status: 404 });
    },
  };
  const gateway = new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    CLOUD_WEB_WORKER: cloudWeb,
    RELAYAUTH_URL: "https://relayauth.test",
    AGENT_GATEWAY_BASE_URL: "http://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
  } as never);

  await state.storage.put("workspace-state", {
    workspace: "support",
    agents: {},
    queues: {},
  });

  await gateway["handleRelaycastSelfEvent"]("support", "agent-a", {
    id: "evt-dm-1",
    channel: "dm:dm-1",
    messageId: "msg-dm-1",
    text: "private note",
    occurredAt: "2026-06-16T14:00:00.000Z",
    from: {
      id: "usr_1",
      displayName: "Ada",
    },
  });

  assert.deepEqual(candidateCalls, [{ workspaceId: "support", selector: "@self" }]);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.agentId, "agent-a");
  assert.equal(delivered[0]?.workspaceId, "support");
  assert.equal((delivered[0]?.payload as Record<string, unknown>).type, "relaycast.message");
  assert.equal((delivered[0]?.payload as Record<string, unknown>).channel, "dm:dm-1");
  assert.equal((delivered[0]?.payload as Record<string, unknown>).messageId, "msg-dm-1");
});

async function waitForEventCount(
  delivered: Array<Record<string, unknown>>,
  expectedCount: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    const count = delivered.filter((entry) => entry.type === "event").length;
    if (count >= expectedCount) {
      return;
    }
  }

  throw new Error(`Timed out waiting for ${expectedCount} delivered events`);
}
