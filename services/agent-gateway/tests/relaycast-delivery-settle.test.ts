import assert from "node:assert/strict";
import { onTestFinished, test } from "vitest";

import { WorkspaceGatewayDO } from "../src/durable-object.js";
import {
  buildRelaycastMessageEnvelope,
  buildRelayfileChangedEnvelope,
} from "../src/envelope-builder.js";
import { FakeDurableObjectState } from "./support/fake-cloudflare.js";

type RecordedRequest = {
  url: string;
  method: string;
  authorization: string | null;
  body: string | null;
};

function createGateway(): WorkspaceGatewayDO {
  const state = new FakeDurableObjectState();
  return new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    RELAYAUTH_URL: "https://relayauth.test",
    RELAYCAST_URL: "https://api.relaycast.test",
    AGENT_GATEWAY_BASE_URL: "http://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
  } as never);
}

function stubFetch(
  requests: RecordedRequest[],
  respond: (request: RecordedRequest) => Response | Promise<Response>,
): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const recorded: RecordedRequest = {
      url: String(input instanceof Request ? input.url : input),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      body: typeof init?.body === "string" ? init.body : null,
    };
    requests.push(recorded);
    return await respond(recorded);
  }) as typeof fetch;
  onTestFinished(() => {
    globalThis.fetch = originalFetch;
  });
}

function okResponse(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), { status: 200 });
}

async function registerAgent(gateway: WorkspaceGatewayDO): Promise<void> {
  await gateway["persistAuthenticatedSession"]({
    workspace: "support",
    agentId: "agent-a",
    agentName: "agent-a",
    accessToken: "token-a",
  });
}

test("acking a relaycast envelope acks the correlated delivery with the recipient's token", async () => {
  const requests: RecordedRequest[] = [];
  stubFetch(requests, () => okResponse({}));

  const gateway = createGateway();
  await registerAgent(gateway);

  const envelope = await buildRelaycastMessageEnvelope({
    workspace: "support",
    eventId: "evt-1",
    channel: "ops",
    messageId: "msg-1",
    text: "Channel message",
  });
  assert.equal(envelope.messageId, "msg-1");

  gateway["recordRelaycastDeliveryId"]("agent-a", {
    deliveryId: "del-1",
    messageId: "msg-1",
  });

  await gateway["enqueueEvent"]("agent-a", envelope);
  await gateway["handleAck"]("agent-a", envelope.id);

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://api.relaycast.test/v1/deliveries/del-1/ack",
  );
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].authorization, "Bearer token-a");

  const state = await gateway["loadState"]();
  assert.equal((state.queues["agent-a"] ?? []).length, 0);
});

test("a correlation miss falls back to the durable deliveries feed", async () => {
  const requests: RecordedRequest[] = [];
  stubFetch(requests, (request) => {
    if (request.url.includes("/v1/deliveries?")) {
      return okResponse([
        { id: "del-other", message_id: "msg-other", status: "accepted" },
        { id: "del-feed-1", message_id: "msg-2", status: "accepted" },
      ]);
    }
    return okResponse({});
  });

  const gateway = createGateway();
  await registerAgent(gateway);

  const envelope = await buildRelaycastMessageEnvelope({
    workspace: "support",
    eventId: "evt-2",
    channel: "ops",
    messageId: "msg-2",
    text: "Channel message",
  });

  await gateway["enqueueEvent"]("agent-a", envelope);
  await gateway["handleAck"]("agent-a", envelope.id);

  assert.equal(requests.length, 2);
  assert.equal(
    requests[0].url,
    "https://api.relaycast.test/v1/deliveries?limit=200",
  );
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[0].authorization, "Bearer token-a");
  assert.equal(
    requests[1].url,
    "https://api.relaycast.test/v1/deliveries/del-feed-1/ack",
  );
  assert.equal(requests[1].method, "POST");
  assert.equal(requests[1].authorization, "Bearer token-a");

  const state = await gateway["loadState"]();
  assert.equal((state.queues["agent-a"] ?? []).length, 0);
});

test("a correlation miss with no matching delivery row skips settlement", async () => {
  const requests: RecordedRequest[] = [];
  stubFetch(requests, (request) => {
    if (request.url.includes("/v1/deliveries?")) {
      return okResponse([]);
    }
    return okResponse({});
  });

  const gateway = createGateway();
  await registerAgent(gateway);

  const envelope = await buildRelaycastMessageEnvelope({
    workspace: "support",
    eventId: "evt-3",
    channel: "ops",
    messageId: "msg-3",
    text: "Channel message",
  });

  await gateway["enqueueEvent"]("agent-a", envelope);
  await gateway["handleAck"]("agent-a", envelope.id);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "GET");

  const state = await gateway["loadState"]();
  assert.equal((state.queues["agent-a"] ?? []).length, 0);
});

test("a terminal nack fails the correlated delivery as non-retryable", async () => {
  const requests: RecordedRequest[] = [];
  stubFetch(requests, () => okResponse({}));

  const gateway = createGateway();
  await registerAgent(gateway);

  const envelope = await buildRelaycastMessageEnvelope({
    workspace: "support",
    eventId: "evt-4",
    channel: "ops",
    messageId: "msg-4",
    text: "Channel message",
  });

  gateway["recordRelaycastDeliveryId"]("agent-a", {
    deliveryId: "del-4",
    messageId: "msg-4",
  });

  await gateway["enqueueEvent"]("agent-a", envelope);
  await gateway["handleNack"]("agent-a", envelope.id, "handler exploded", true);

  const failRequest = requests.find((request) =>
    request.url.endsWith("/v1/deliveries/del-4/fail"),
  );
  assert.ok(failRequest, "terminal nack should call failDelivery");
  assert.equal(failRequest.method, "POST");
  assert.equal(failRequest.authorization, "Bearer token-a");
  assert.deepEqual(JSON.parse(failRequest.body ?? "{}"), {
    error: "handler exploded",
    retryable: false,
  });

  const state = await gateway["loadState"]();
  assert.equal((state.queues["agent-a"] ?? []).length, 0);
});

test("a retryable nack does not touch the relaycast delivery ledger", async () => {
  const requests: RecordedRequest[] = [];
  stubFetch(requests, () => okResponse({}));

  const gateway = createGateway();
  await registerAgent(gateway);

  const envelope = await buildRelaycastMessageEnvelope({
    workspace: "support",
    eventId: "evt-5",
    channel: "ops",
    messageId: "msg-5",
    text: "Channel message",
  });

  await gateway["enqueueEvent"]("agent-a", envelope);
  await gateway["handleNack"]("agent-a", envelope.id, "transient", false);

  const deliveryRequests = requests.filter((request) =>
    request.url.includes("/v1/deliveries"),
  );
  assert.equal(deliveryRequests.length, 0);

  const state = await gateway["loadState"]();
  assert.equal((state.queues["agent-a"] ?? []).length, 1);
});

test("engine-side settle failure does not fail the gateway ack", async () => {
  const requests: RecordedRequest[] = [];
  stubFetch(requests, () => {
    throw new Error("relaycast unreachable");
  });

  const gateway = createGateway();
  await registerAgent(gateway);

  const envelope = await buildRelaycastMessageEnvelope({
    workspace: "support",
    eventId: "evt-6",
    channel: "ops",
    messageId: "msg-6",
    text: "Channel message",
  });

  gateway["recordRelaycastDeliveryId"]("agent-a", {
    deliveryId: "del-6",
    messageId: "msg-6",
  });

  await gateway["enqueueEvent"]("agent-a", envelope);
  await gateway["handleAck"]("agent-a", envelope.id);

  assert.equal(requests.length, 1);
  const state = await gateway["loadState"]();
  assert.equal((state.queues["agent-a"] ?? []).length, 0);
});

test("engine-side settle error response does not fail the gateway ack", async () => {
  const requests: RecordedRequest[] = [];
  stubFetch(
    requests,
    () =>
      new Response(
        JSON.stringify({ ok: false, error: { code: "not_found", message: "no delivery" } }),
        { status: 404 },
      ),
  );

  const gateway = createGateway();
  await registerAgent(gateway);

  const envelope = await buildRelaycastMessageEnvelope({
    workspace: "support",
    eventId: "evt-7",
    channel: "ops",
    messageId: "msg-7",
    text: "Channel message",
  });

  gateway["recordRelaycastDeliveryId"]("agent-a", {
    deliveryId: "del-7",
    messageId: "msg-7",
  });

  await gateway["enqueueEvent"]("agent-a", envelope);
  await gateway["handleAck"]("agent-a", envelope.id);

  assert.equal(requests.length, 1);
  const state = await gateway["loadState"]();
  assert.equal((state.queues["agent-a"] ?? []).length, 0);
});

test("correlation entries expire after the TTL", async () => {
  const requests: RecordedRequest[] = [];
  stubFetch(requests, (request) => {
    if (request.url.includes("/v1/deliveries?")) {
      return okResponse([]);
    }
    return okResponse({});
  });

  const gateway = createGateway();
  await registerAgent(gateway);

  const envelope = await buildRelaycastMessageEnvelope({
    workspace: "support",
    eventId: "evt-8",
    channel: "ops",
    messageId: "msg-8",
    text: "Channel message",
  });

  gateway["recordRelaycastDeliveryId"]("agent-a", {
    deliveryId: "del-8",
    messageId: "msg-8",
  });
  // Force the entry past its TTL.
  const entry = gateway["relaycastDeliveryIds"].get("agent-a:msg-8");
  assert.ok(entry);
  entry.expiresAt = Date.now() - 1;

  await gateway["enqueueEvent"]("agent-a", envelope);
  await gateway["handleAck"]("agent-a", envelope.id);

  // The stale id must not be used; the durable feed is consulted instead.
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://api.relaycast.test/v1/deliveries?limit=200",
  );

  const state = await gateway["loadState"]();
  assert.equal((state.queues["agent-a"] ?? []).length, 0);
});

test("the correlation map is bounded", () => {
  const gateway = createGateway();

  for (let index = 0; index < 2_100; index += 1) {
    gateway["recordRelaycastDeliveryId"]("agent-a", {
      deliveryId: `del-${index}`,
      messageId: `msg-${index}`,
    });
  }

  assert.ok(gateway["relaycastDeliveryIds"].size <= 2_000);
  // Newest entries are retained, oldest evicted.
  assert.ok(gateway["relaycastDeliveryIds"].has("agent-a:msg-2099"));
  assert.ok(!gateway["relaycastDeliveryIds"].has("agent-a:msg-0"));
});

test("acking a non-relaycast envelope performs no relaycast call", async () => {
  const requests: RecordedRequest[] = [];
  stubFetch(requests, () => okResponse({}));

  const gateway = createGateway();
  await registerAgent(gateway);

  const envelope = await buildRelayfileChangedEnvelope({
    workspace: "support",
    path: "/github/prs/42.json",
    eventId: "evt-relayfile-1",
    type: "file.updated",
  });

  await gateway["enqueueEvent"]("agent-a", envelope);
  await gateway["handleAck"]("agent-a", envelope.id);

  assert.equal(requests.length, 0);
  const state = await gateway["loadState"]();
  assert.equal((state.queues["agent-a"] ?? []).length, 0);
});
