import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "vitest";

import { createAgentEvent, createCronTickEvent } from "@agent-relay/events";

import { WorkspaceGatewayDO } from "../src/durable-object.js";
import {
  createLinkedSockets,
  FakeDurableObjectState,
} from "./support/fake-cloudflare.js";

test("gateway metrics snapshot aggregates received, retries, drops, latency, and cost by event type", async () => {
  const costOccurredAt = new Date().toISOString();
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
    agentName: "agent-a",
    authenticated: true,
    legacyProtocol: false,
  });
  state.acceptWebSocket(server);

  const firstCronEvent = createCronTickEvent({
    workspace: "support",
    resourceId: "sched-1",
    schedule: "*/5 * * * *",
    scheduledFor: "2026-05-12T10:00:00.000Z",
  });
  await gateway["enqueueEvent"]("agent-a", firstCronEvent);
  await delay(5);
  await gateway["handleAck"]("agent-a", firstCronEvent.id);

  const secondCronEvent = createCronTickEvent({
    workspace: "support",
    resourceId: "sched-2",
    schedule: "*/10 * * * *",
    scheduledFor: "2026-05-12T10:05:00.000Z",
  });
  await gateway["enqueueEvent"]("agent-a", secondCronEvent);
  await delay(5);
  await gateway["handleNack"]("agent-a", secondCronEvent.id, "retry once", false);

  const firstChangeEvent = createAgentEvent({
    workspace: "support",
    type: "relayfile.changed",
    path: "/docs/alpha.md",
    watch: "/docs/*.md",
    action: "updated",
    resource: {
      path: "/docs/alpha.md",
      kind: "file",
      id: "docs-alpha",
      provider: "relayfile",
    },
  });
  const secondChangeEvent = createAgentEvent({
    workspace: "support",
    type: "relayfile.changed",
    path: "/docs/beta.md",
    watch: "/docs/*.md",
    action: "updated",
    resource: {
      path: "/docs/beta.md",
      kind: "file",
      id: "docs-beta",
      provider: "relayfile",
    },
  });
  await gateway["enqueueEvent"]("agent-b", firstChangeEvent, 1);
  await gateway["enqueueEvent"]("agent-b", secondChangeEvent, 1);

  const costResponse = await gateway.fetch(
    new Request("https://agent-gateway.internal/internal/cost", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-gateway-workspace": "support",
      },
      body: JSON.stringify({
        agentId: "agent-a",
        eventType: "cron.tick",
        costUsd: 0.42,
        inputTokens: 1200,
        outputTokens: 300,
        occurredAt: costOccurredAt,
      }),
    }),
  );
  assert.equal(costResponse.status, 200);

  const snapshotResponse = await gateway.fetch(
    new Request("https://agent-gateway.internal/metrics?windowMinutes=240", {
      method: "GET",
      headers: {
        "x-agent-gateway-workspace": "support",
      },
    }),
  );
  assert.equal(snapshotResponse.status, 200);

  const snapshotPayload = (await snapshotResponse.json()) as {
    ok: boolean;
    data: {
      workspace: string;
      series: {
        eventsPerMinuteByType: Record<string, number[]>;
        costUsdPerMinute: number[];
        costUsdPerMinuteByEventType: Record<string, number[]>;
      };
      totals: {
        eventsReceivedTotal: number;
        retriesTotal: number;
        dropsTotal: number;
        latencyP50Ms: number;
      };
      agents: Array<{
        agentId: string;
        summary: {
          eventsReceivedTotal: number;
          retriesTotal: number;
          dropsTotal: number;
        };
        byEventType: Array<{
          eventType: string;
          summary: {
            eventsReceivedTotal: number;
            retriesTotal: number;
            dropsTotal: number;
          };
        }>;
      }>;
      costByEventType: Array<{
        eventType: string;
        costUsd: number;
        inputTokens: number;
        outputTokens: number;
        sampleCount: number;
      }>;
    };
  };

  assert.equal(snapshotPayload.ok, true);
  assert.equal(snapshotPayload.data.workspace, "support");
  assert.equal(snapshotPayload.data.totals.eventsReceivedTotal, 4);
  assert.equal(snapshotPayload.data.totals.retriesTotal, 1);
  assert.equal(snapshotPayload.data.totals.dropsTotal, 1);
  assert.ok(snapshotPayload.data.totals.latencyP50Ms >= 1);
  assert.equal(
    snapshotPayload.data.series.eventsPerMinuteByType["cron.tick"]?.reduce((sum, value) => sum + value, 0),
    2,
  );
  assert.equal(
    snapshotPayload.data.series.eventsPerMinuteByType["relayfile.changed"]?.reduce((sum, value) => sum + value, 0),
    2,
  );
  assert.equal(
    snapshotPayload.data.series.costUsdPerMinute.reduce((sum, value) => sum + value, 0),
    0.42,
  );
  assert.equal(
    snapshotPayload.data.series.costUsdPerMinuteByEventType["cron.tick"]?.reduce((sum, value) => sum + value, 0),
    0.42,
  );

  const agentA = snapshotPayload.data.agents.find((entry) => entry.agentId === "agent-a");
  assert.ok(agentA);
  assert.equal(agentA?.summary.eventsReceivedTotal, 2);
  assert.equal(agentA?.summary.retriesTotal, 1);
  assert.equal(agentA?.summary.dropsTotal, 0);

  const cronMetrics = agentA?.byEventType.find((entry) => entry.eventType === "cron.tick");
  assert.ok(cronMetrics);
  assert.equal(cronMetrics?.summary.eventsReceivedTotal, 2);
  assert.equal(cronMetrics?.summary.retriesTotal, 1);
  assert.equal(cronMetrics?.summary.dropsTotal, 0);

  assert.deepEqual(snapshotPayload.data.costByEventType, [
    {
      eventType: "cron.tick",
      costUsd: 0.42,
      inputTokens: 1200,
      outputTokens: 300,
      sampleCount: 1,
    },
  ]);
});

test("gateway metrics snapshot supports per-agent filtering", async () => {
  const state = new FakeDurableObjectState();
  const gateway = new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    RELAYAUTH_URL: "https://relayauth.test",
    AGENT_GATEWAY_BASE_URL: "http://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
  } as never);

  const eventA = createCronTickEvent({
    workspace: "support",
    resourceId: "sched-agent-a",
    schedule: "manual",
    scheduledFor: "2026-05-12T10:00:00.000Z",
  });
  const eventB = createCronTickEvent({
    workspace: "support",
    resourceId: "sched-agent-b",
    schedule: "manual",
    scheduledFor: "2026-05-12T10:01:00.000Z",
  });

  await gateway["enqueueEvent"]("agent-a", eventA);
  await gateway["enqueueEvent"]("agent-b", eventB);

  const response = await gateway.fetch(
    new Request("https://agent-gateway.internal/metrics?agentId=agent-b&windowMinutes=240", {
      method: "GET",
      headers: {
        "x-agent-gateway-workspace": "support",
      },
    }),
  );
  assert.equal(response.status, 200);

  const payload = (await response.json()) as {
    ok: boolean;
    data: {
      selectedAgentId?: string;
      totals: {
        eventsReceivedTotal: number;
        retriesTotal: number;
        dropsTotal: number;
      };
      agents: Array<{ agentId: string }>;
    };
  };

  assert.equal(payload.ok, true);
  assert.equal(payload.data.selectedAgentId, "agent-b");
  assert.equal(payload.data.totals.eventsReceivedTotal, 1);
  assert.equal(payload.data.totals.retriesTotal, 0);
  assert.equal(payload.data.totals.dropsTotal, 0);
  assert.deepEqual(payload.data.agents.map((entry) => entry.agentId), ["agent-b"]);
});
