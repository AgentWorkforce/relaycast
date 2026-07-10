import assert from "node:assert/strict";
import { test } from "vitest";

import { createCronTickEvent } from "@agent-relay/events";

import { WorkspaceGatewayDO } from "../src/durable-object.js";
import {
  createLinkedSockets,
  FakeDurableObjectState,
} from "./support/fake-cloudflare.js";

test("workspace queue preserves FIFO delivery until the head event is acknowledged", async () => {
  const state = new FakeDurableObjectState();
  const gateway = new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    RELAYAUTH_URL: "https://relayauth.test",
    AGENT_GATEWAY_BASE_URL: "http://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
  } as never);

  const { client, server } = createLinkedSockets();
  const delivered: Array<{ event: { id: string } }> = [];

  client.onmessage = (message) => {
    delivered.push(JSON.parse(String(message.data)) as { event: { id: string } });
  };

  server.serializeAttachment({
    workspace: "support",
    agentId: "support-agent",
    agentName: "support-agent",
    authenticated: true,
    legacyProtocol: false,
  });
  state.acceptWebSocket(server);

  const first = createCronTickEvent({
    workspace: "support",
    scheduleId: "sched-first",
    schedule: "oneshot:first",
    scheduledFor: "2026-05-11T12:00:00.000Z",
  });
  const second = createCronTickEvent({
    workspace: "support",
    scheduleId: "sched-second",
    schedule: "oneshot:second",
    scheduledFor: "2026-05-11T12:00:01.000Z",
  });

  await gateway["enqueueEvent"]("support-agent", first);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered.map((entry) => entry.event.id), [first.id]);

  await gateway["enqueueEvent"]("support-agent", second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    delivered.map((entry) => entry.event.id),
    [first.id],
    "second event should wait behind the inflight head",
  );

  await gateway["handleAck"]("support-agent", first.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered.map((entry) => entry.event.id), [first.id, second.id]);
});
