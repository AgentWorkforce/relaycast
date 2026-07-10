import assert from "node:assert/strict";
import { test } from "vitest";

import { createCronTickEvent } from "@agent-relay/events";

import { WorkspaceGatewayDO } from "../src/durable-object.js";
import {
  computeRetryDelayMs,
  DEFAULT_RETRY_POLICY,
  NoRetry,
  shouldRetry,
} from "../src/retry.js";
import {
  createLinkedSockets,
  FakeDurableObjectState,
} from "./support/fake-cloudflare.js";

test("shouldRetry stops on NoRetry and after the max attempt", () => {
  assert.equal(shouldRetry(1, new Error("boom")), true);
  assert.equal(shouldRetry(1, new NoRetry("stop")), false);
  assert.equal(
    shouldRetry(DEFAULT_RETRY_POLICY.maxAttempts, new Error("boom")),
    false,
  );
});

test("computeRetryDelayMs follows the exponential schedule and caps at the final delay", () => {
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    assert.equal(computeRetryDelayMs(1), 1_000);
    assert.equal(computeRetryDelayMs(2), 5_000);
    assert.equal(computeRetryDelayMs(3), 30_000);
    assert.equal(computeRetryDelayMs(4), 5 * 60_000);
    assert.equal(computeRetryDelayMs(5), 30 * 60_000);
    assert.equal(computeRetryDelayMs(99), 30 * 60_000);
  } finally {
    Math.random = originalRandom;
  }
});

test("gateway nack reschedules the inflight head with the next attempt and backoff", async () => {
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const state = new FakeDurableObjectState();
    const gateway = new WorkspaceGatewayDO(state as never, {
      WORKSPACE_GATEWAY_DO: {} as never,
      RELAYAUTH_URL: "https://relayauth.test",
      AGENT_GATEWAY_BASE_URL: "http://agent-gateway.test",
      AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
    } as never);

    const { client, server } = createLinkedSockets();
    const delivered: Array<{ event: { id: string; attempt: number } }> = [];

    client.onmessage = (message) => {
      delivered.push(
        JSON.parse(String(message.data)) as { event: { id: string; attempt: number } },
      );
    };

    server.serializeAttachment({
      workspace: "support",
      agentId: "support-agent",
      agentName: "support-agent",
      authenticated: true,
      legacyProtocol: false,
    });
    state.acceptWebSocket(server);

    const event = createCronTickEvent({
      workspace: "support",
      scheduleId: "sched-retry",
      schedule: "oneshot:retry",
      scheduledFor: "2026-05-11T12:00:00.000Z",
    });

    await gateway["enqueueEvent"]("support-agent", event);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(delivered.map((entry) => entry.event.attempt), [1]);

    await gateway["handleNack"]("support-agent", event.id, "fail once", false);

    const afterNack = await state.storage.get<{
      queues: Record<string, Array<{
        attempt: number;
        inflight: boolean;
        dueAt: string;
        lastError?: string;
        event: { attempt: number };
      }>>;
    }>("workspace-state");
    const entry = afterNack?.queues["support-agent"]?.[0];
    assert.ok(entry, "expected the delivery to stay queued for retry");
    assert.equal(entry.attempt, 2);
    assert.equal(entry.event.attempt, 2);
    assert.equal(entry.inflight, false);
    assert.equal(entry.lastError, "fail once");
    assert.ok(
      Date.parse(entry.dueAt) >= Date.now() + 900,
      `expected retry dueAt to land about 1s in the future, got ${entry.dueAt}`,
    );

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(delivered.map((entry) => entry.event.attempt), [1, 2]);
  } finally {
    Math.random = originalRandom;
  }
});

test("gateway stops retrying when noRetry is requested and removes the delivery", async () => {
  const originalConsoleError = console.error;
  const originalFetch = globalThis.fetch;
  const errors: string[] = [];
  console.error = ((value: string) => {
    errors.push(value);
  }) as typeof console.error;
  try {
    globalThis.fetch = async () =>
      Response.json({
        opId: "op_dlq_retry_test",
        status: "queued",
      });
    const state = new FakeDurableObjectState();
    const gateway = new WorkspaceGatewayDO(state as never, {
      WORKSPACE_GATEWAY_DO: {} as never,
      RELAYAUTH_URL: "https://relayauth.test",
      RELAYFILE_URL: "https://relayfile.test",
      AGENT_GATEWAY_BASE_URL: "http://agent-gateway.test",
      AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
    } as never);

    const { server } = createLinkedSockets();
    server.serializeAttachment({
      workspace: "support",
      agentId: "support-agent",
      agentName: "support-agent",
      authenticated: true,
      legacyProtocol: false,
    });
    state.acceptWebSocket(server);
    await gateway["persistAuthenticatedSession"]({
      workspace: "support",
      agentId: "support-agent",
      agentName: "support-agent",
      accessToken: "relayfile-token",
    });

    const event = createCronTickEvent({
      workspace: "support",
      scheduleId: "sched-no-retry",
      schedule: "oneshot:no-retry",
      scheduledFor: "2026-05-11T12:00:00.000Z",
    });

    await gateway["enqueueEvent"]("support-agent", event);
    await new Promise((resolve) => setImmediate(resolve));
    await gateway["handleNack"]("support-agent", event.id, "fatal", true);

    const afterNoRetry = await state.storage.get<{
      queues: Record<string, Array<unknown>>;
    }>("workspace-state");
    assert.deepEqual(afterNoRetry?.queues["support-agent"] ?? [], []);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /agent_gateway_dlq_write/);
    assert.match(errors[0] ?? "", /"path":"\/_dlq\/[^"]+\.json"/);
    assert.match(errors[0] ?? "", /"eventId":"[^"]+"/);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});
