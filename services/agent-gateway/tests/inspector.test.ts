import assert from "node:assert/strict";
import { test } from "vitest";

import { createCronTickEvent } from "@agent-relay/events";

import { WorkspaceGatewayDO } from "../src/durable-object.js";
import {
  createLinkedSockets,
  FakeDurableObjectState,
} from "./support/fake-cloudflare.js";

test("workspace inspector returns agent summaries, detail, and recent events", async () => {
  const state = new FakeDurableObjectState();
  const gateway = new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    RELAYAUTH_URL: "https://relayauth.test",
    AGENT_GATEWAY_BASE_URL: "http://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
  } as never);

  const { server } = createLinkedSockets();
  server.serializeAttachment({
    workspace: "support",
    agentId: "agent-a",
    agentName: "Agent A",
    authenticated: true,
    role: "agent",
  });
  state.acceptWebSocket(server);

  await gateway["persistAuthenticatedSession"]({
    workspace: "support",
    agentId: "agent-a",
    agentName: "Agent A",
  });

  const event = createCronTickEvent({
    workspace: "support",
    resourceId: "sched-1",
    schedule: "*/5 * * * *",
    scheduledFor: "2026-05-12T10:00:00.000Z",
  });
  await gateway["enqueueEvent"]("agent-a", event);

  const listResponse = await gateway.fetch(
    new Request("https://agent-gateway.internal/agents", {
      method: "GET",
      headers: {
        "x-agent-gateway-workspace": "support",
      },
    }),
  );
  assert.equal(listResponse.status, 200);
  const listPayload = await listResponse.json() as {
    data: {
      agents: Array<{
        agentId: string;
        agentName: string;
        status: string;
        queueDepth: number;
        lastEvent: string | null;
      }>;
    };
  };
  assert.deepEqual(listPayload.data.agents.map((agent) => agent.agentId), ["agent-a"]);
  assert.equal(listPayload.data.agents[0]?.agentName, "Agent A");
  assert.equal(listPayload.data.agents[0]?.status, "online");
  assert.equal(listPayload.data.agents[0]?.queueDepth, 1);
  assert.equal(listPayload.data.agents[0]?.lastEvent, "event.enqueued");

  const detailResponse = await gateway.fetch(
    new Request("https://agent-gateway.internal/agents/agent-a", {
      method: "GET",
      headers: {
        "x-agent-gateway-workspace": "support",
      },
    }),
  );
  assert.equal(detailResponse.status, 200);
  const detailPayload = await detailResponse.json() as {
    data: {
      agent: {
        policy: {
          maxBacklog: number;
          handlerTimeoutMs: number;
        };
        recentEvents: Array<{ kind: string; eventId?: string }>;
      };
    };
  };
  assert.equal(detailPayload.data.agent.policy.maxBacklog, 1_000);
  assert.equal(detailPayload.data.agent.policy.handlerTimeoutMs, 300_000);
  assert.equal(detailPayload.data.agent.recentEvents[0]?.kind, "event.enqueued");
  assert.equal(detailPayload.data.agent.recentEvents[0]?.eventId, event.id);

  const eventsResponse = await gateway.fetch(
    new Request("https://agent-gateway.internal/agents/agent-a/events", {
      method: "GET",
      headers: {
        "x-agent-gateway-workspace": "support",
      },
    }),
  );
  assert.equal(eventsResponse.status, 200);
  const eventsPayload = await eventsResponse.json() as {
    data: {
      events: Array<{ kind: string; eventId?: string }>;
    };
  };
  const retainedEvent = eventsPayload.data.events.find(
    (entry) => entry.kind === "event.enqueued",
  );
  assert.equal(retainedEvent?.eventId, event.id);
});

test("inspector observer sockets receive activity but cannot send agent control frames", async () => {
  const state = new FakeDurableObjectState();
  const gateway = new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    RELAYAUTH_URL: "https://relayauth.test",
    AGENT_GATEWAY_BASE_URL: "http://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
  } as never);

  await gateway["persistAuthenticatedSession"]({
    workspace: "support",
    agentId: "agent-a",
    agentName: "Agent A",
  });

  const { client, server } = createLinkedSockets();
  server.serializeAttachment({
    workspace: "support",
    agentId: "agent-a",
    authenticated: true,
    role: "observer",
  });
  state.acceptWebSocket(server);

  const received: unknown[] = [];
  client.onmessage = (message) => {
    received.push(JSON.parse(String(message.data)));
  };

  const event = createCronTickEvent({
    workspace: "support",
    resourceId: "sched-1",
    schedule: "*/5 * * * *",
    scheduledFor: "2026-05-12T10:00:00.000Z",
  });
  await gateway["enqueueEvent"]("agent-a", event);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    (received[0] as { type?: string; activity?: { kind?: string } })?.type,
    "activity",
  );
  assert.equal(
    (received[0] as { activity?: { kind?: string } })?.activity?.kind,
    "event.enqueued",
  );

  await gateway.webSocketMessage(
    server as never,
    JSON.stringify({ type: "ack", eventId: event.id }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  const error = received.find(
    (message): message is { type: string; code: string } =>
      Boolean(message)
      && typeof message === "object"
      && (message as { type?: unknown }).type === "error",
  );
  assert.equal(error?.code, "observer_read_only");

  const eventsResponse = await gateway.fetch(
    new Request("https://agent-gateway.internal/agents/agent-a/events", {
      method: "GET",
      headers: {
        "x-agent-gateway-workspace": "support",
      },
    }),
  );
  const eventsPayload = await eventsResponse.json() as {
    data: {
      events: Array<{ kind: string; eventId?: string }>;
    };
  };
  const retainedEvent = eventsPayload.data.events.find(
    (entry) => entry.kind === "event.enqueued",
  );
  assert.equal(retainedEvent?.eventId, event.id);
});
