import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

import { createCronTickEvent } from "@agent-relay/events";

import { WorkspaceGatewayDO } from "../src/durable-object.js";
import {
  createLinkedSockets,
  FakeDurableObjectState,
} from "./support/fake-cloudflare.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("watch-only registration coalesces relayfile changes per agent path", async () => {
  const state = new FakeDurableObjectState();
  const gateway = new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    RELAYAUTH_URL: "https://relayauth.test",
    AGENT_GATEWAY_BASE_URL: "http://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
    RELAYFILE_URL: "https://relayfile.test",
  } as never);

  gateway["relayfileClient"] = {
    subscribe() {
      return () => {};
    },
    async getResourceAtEvent() {
      return {
        data: {
          title: "Customer escalation follow-up",
          state: { name: "In Progress" },
          actionBy: { id: "usr_1", name: "Ada Lovelace" },
        },
      };
    },
    async getEvents() {
      return { events: [], nextCursor: null };
    },
  } as never;

  const { client, server } = createLinkedSockets();
  const messages: Array<Record<string, unknown>> = [];
  client.onmessage = (message) => {
    messages.push(JSON.parse(String(message.data)) as Record<string, unknown>);
  };

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
    accessToken: "relayfile-agent-token",
  });

  await gateway["handleRegister"]("support-agent", server as never, {
    type: "register",
    watch: {
      glob: "/linear/**",
      coalesceMs: 25,
      replayOnStart: "none",
    },
  });

  await gateway["handleRelayfileWorkspaceEvent"]("support", {
    eventId: "evt-1",
    type: "file.updated",
    path: "/linear/issues/ENG-1.json",
    revision: "rev-1",
    timestamp: "2026-05-11T12:00:00.000Z",
    provider: "linear",
  });
  await gateway["handleRelayfileWorkspaceEvent"]("support", {
    eventId: "evt-2",
    type: "file.updated",
    path: "/linear/issues/ENG-1.json",
    revision: "rev-2",
    timestamp: "2026-05-11T12:00:01.000Z",
    provider: "linear",
  });

  await new Promise((resolve) => setTimeout(resolve, 60));
  await new Promise((resolve) => setImmediate(resolve));

  const delivered = messages.filter((entry) => entry.type === "event");
  assert.equal(delivered.length, 1);
  assert.equal((delivered[0]?.event as { id: string }).id, "evt-2");
  assert.equal((delivered[0]?.event as { watch: string }).watch, "/linear/**");
  assert.deepEqual((delivered[0]?.event as {
    summary: {
      title: string;
      status: string;
      actor: { id: string; displayName: string };
      tags: string[];
    };
  }).summary, {
    title: "Customer escalation follow-up",
    status: "In Progress",
    actor: { id: "usr_1", displayName: "Ada Lovelace" },
    tags: ["linear", "state:In Progress"],
  });
});

test("schedule re-registration cancels relaycron schedules omitted by the update", async () => {
  const state = new FakeDurableObjectState();
  const gateway = new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    RELAYAUTH_URL: "https://relayauth.test",
    AGENT_GATEWAY_BASE_URL: "https://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
    RELAYCRON_URL: "https://relaycron.test",
    RELAYCRON_API_KEY: "relaycron-key",
    RELAYFILE_URL: "https://relayfile.test",
  } as never);

  const requests: Request[] = [];
  let created = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.method === "POST") {
      created += 1;
      return Response.json({ ok: true, data: { id: `relaycron-${created}` } });
    }
    return Response.json({ ok: true, data: {} });
  }));

  const { client, server } = createLinkedSockets();
  const messages: Array<Record<string, unknown>> = [];
  client.onmessage = (message) => {
    messages.push(JSON.parse(String(message.data)) as Record<string, unknown>);
  };
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
    accessToken: "relayfile-agent-token",
  });

  await gateway["handleRegister"]("support-agent", server as never, {
    type: "register",
    schedule: "*/2 * * * *",
  });
  await gateway["handleRegister"]("support-agent", server as never, {
    type: "register",
    schedule: "*/5 * * * *",
  });

  const deleteRequests = requests.filter((request) => request.method === "DELETE");
  assert.equal(deleteRequests.length, 1);
  assert.equal(deleteRequests[0]?.url, "https://relaycron.test/v1/schedules/relaycron-1");
  const currentState = await gateway["loadState"]();
  assert.deepEqual(
    currentState.agents["support-agent"]?.schedules.map((schedule) => schedule.relaycronScheduleId),
    ["relaycron-2"],
  );
  assert.deepEqual(
    (messages.filter((message) => message.type === "registered").at(-1)?.schedules as Array<{
      relaycronScheduleId: string;
      schedule: string;
    }>).map((schedule) => ({
      relaycronScheduleId: schedule.relaycronScheduleId,
      schedule: schedule.schedule,
    })),
    [{ relaycronScheduleId: "relaycron-2", schedule: "*/5 * * * *" }],
  );
});

test("schedule re-registration cancels duplicate relaycron schedules with the same fingerprint", async () => {
  const state = new FakeDurableObjectState();
  const gateway = new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    RELAYAUTH_URL: "https://relayauth.test",
    AGENT_GATEWAY_BASE_URL: "https://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
    RELAYCRON_URL: "https://relaycron.test",
    RELAYCRON_API_KEY: "relaycron-key",
    RELAYFILE_URL: "https://relayfile.test",
  } as never);

  const requests: Request[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.method === "POST") {
      return Response.json({ ok: true, data: { id: "relaycron-primary" } });
    }
    return Response.json({ ok: true, data: {} });
  }));

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
    accessToken: "relayfile-agent-token",
  });

  await gateway["handleRegister"]("support-agent", server as never, {
    type: "register",
    schedule: "*/2 * * * *",
  });

  const stateWithDuplicate = await gateway["loadState"]();
  const primarySchedule = stateWithDuplicate.agents["support-agent"]?.schedules[0];
  assert.ok(primarySchedule);
  stateWithDuplicate.agents["support-agent"]?.schedules.push({
    ...primarySchedule,
    gatewayScheduleId: "duplicate-gateway-schedule",
    relaycronScheduleId: "relaycron-duplicate",
  });
  await gateway["saveState"](stateWithDuplicate);

  await gateway["handleRegister"]("support-agent", server as never, {
    type: "register",
    schedule: "*/2 * * * *",
  });

  const postRequests = requests.filter((request) => request.method === "POST");
  const deleteRequests = requests.filter((request) => request.method === "DELETE");
  assert.equal(postRequests.length, 1);
  assert.equal(deleteRequests.length, 1);
  assert.equal(deleteRequests[0]?.url, "https://relaycron.test/v1/schedules/relaycron-duplicate");
  const currentState = await gateway["loadState"]();
  assert.deepEqual(
    currentState.agents["support-agent"]?.schedules.map((schedule) => schedule.relaycronScheduleId),
    ["relaycron-primary"],
  );
});

test("schedule registration deduplicates duplicate requested schedules before creating relaycron entries", async () => {
  const state = new FakeDurableObjectState();
  const gateway = new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    RELAYAUTH_URL: "https://relayauth.test",
    AGENT_GATEWAY_BASE_URL: "https://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
    RELAYCRON_URL: "https://relaycron.test",
    RELAYCRON_API_KEY: "relaycron-key",
    RELAYFILE_URL: "https://relayfile.test",
  } as never);

  const requests: Request[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return Response.json({ ok: true, data: { id: "relaycron-primary" } });
  }));

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
    accessToken: "relayfile-agent-token",
  });

  await gateway["handleRegister"]("support-agent", server as never, {
    type: "register",
    schedule: ["*/2 * * * *", "*/2 * * * *"],
  });

  const postRequests = requests.filter((request) => request.method === "POST");
  assert.equal(postRequests.length, 1);
  const relaycronCreate = await postRequests[0]!.json() as {
    transport: { url: string };
    payload: { gatewayScheduleId: string };
  };
  const callbackUrl = new URL(relaycronCreate.transport.url);
  assert.equal(callbackUrl.searchParams.get("workspace"), "support");
  assert.equal(callbackUrl.searchParams.get("agent_id"), "support-agent");
  assert.equal(
    callbackUrl.searchParams.get("gateway_schedule_id"),
    relaycronCreate.payload.gatewayScheduleId,
  );
  assert.equal(callbackUrl.searchParams.get("schedule"), "*/2 * * * *");
  const currentState = await gateway["loadState"]();
  assert.deepEqual(
    currentState.agents["support-agent"]?.schedules.map((schedule) => schedule.relaycronScheduleId),
    ["relaycron-primary"],
  );
});

test("schedule re-registration with an empty schedule list cancels existing relaycron schedules", async () => {
  const state = new FakeDurableObjectState();
  const gateway = new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    RELAYAUTH_URL: "https://relayauth.test",
    AGENT_GATEWAY_BASE_URL: "https://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
    RELAYCRON_URL: "https://relaycron.test",
    RELAYCRON_API_KEY: "relaycron-key",
    RELAYFILE_URL: "https://relayfile.test",
  } as never);

  const requests: Request[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.method === "POST") {
      return Response.json({ ok: true, data: { id: "relaycron-primary" } });
    }
    return Response.json({ ok: true, data: {} });
  }));

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
    accessToken: "relayfile-agent-token",
  });

  await gateway["handleRegister"]("support-agent", server as never, {
    type: "register",
    schedule: "*/2 * * * *",
  });
  await gateway["handleRegister"]("support-agent", server as never, {
    type: "register",
    schedule: [],
  });

  const deleteRequests = requests.filter((request) => request.method === "DELETE");
  assert.equal(deleteRequests.length, 1);
  assert.equal(deleteRequests[0]?.url, "https://relaycron.test/v1/schedules/relaycron-primary");
  const currentState = await gateway["loadState"]();
  assert.deepEqual(currentState.agents["support-agent"]?.schedules, []);
});

test("schedule registration rolls back earlier relaycron creates when a later create fails", async () => {
  const state = new FakeDurableObjectState();
  const gateway = new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    RELAYAUTH_URL: "https://relayauth.test",
    AGENT_GATEWAY_BASE_URL: "https://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
    RELAYCRON_URL: "https://relaycron.test",
    RELAYCRON_API_KEY: "relaycron-key",
    RELAYFILE_URL: "https://relayfile.test",
  } as never);

  const requests: Request[] = [];
  let created = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.method === "POST") {
      created += 1;
      if (created === 2) {
        return Response.json(
          { ok: false, error: { code: "relaycron_unavailable" } },
          { status: 500 },
        );
      }
      return Response.json({ ok: true, data: { id: `relaycron-${created}` } });
    }
    return Response.json({ ok: true, data: {} });
  }));

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
    accessToken: "relayfile-agent-token",
  });

  await assert.rejects(
    () => gateway["handleRegister"]("support-agent", server as never, {
      type: "register",
      schedule: ["*/2 * * * *", "*/5 * * * *"],
    }),
    /relaycron request failed/,
  );

  const deleteRequests = requests.filter((request) => request.method === "DELETE");
  assert.equal(deleteRequests.length, 1);
  assert.equal(deleteRequests[0]?.url, "https://relaycron.test/v1/schedules/relaycron-1");
  const currentState = await gateway["loadState"]();
  assert.deepEqual(currentState.agents["support-agent"]?.schedules, []);
});

test("schedule replacement rolls back newly created relaycron schedules when old cancellation fails", async () => {
  const state = new FakeDurableObjectState();
  const gateway = new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    RELAYAUTH_URL: "https://relayauth.test",
    AGENT_GATEWAY_BASE_URL: "https://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
    RELAYCRON_URL: "https://relaycron.test",
    RELAYCRON_API_KEY: "relaycron-key",
    RELAYFILE_URL: "https://relayfile.test",
  } as never);

  const requests: Request[] = [];
  let created = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.method === "POST") {
      created += 1;
      return Response.json({ ok: true, data: { id: `relaycron-${created}` } });
    }
    if (request.method === "DELETE" && request.url.endsWith("/relaycron-1")) {
      return Response.json(
        { ok: false, error: { code: "relaycron_unavailable" } },
        { status: 500 },
      );
    }
    return Response.json({ ok: true, data: {} });
  }));

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
    accessToken: "relayfile-agent-token",
  });

  await gateway["handleRegister"]("support-agent", server as never, {
    type: "register",
    schedule: "*/2 * * * *",
  });

  await assert.rejects(
    () => gateway["handleRegister"]("support-agent", server as never, {
      type: "register",
      schedule: "*/5 * * * *",
    }),
    /relaycron request failed/,
  );

  const deleteUrls = requests
    .filter((request) => request.method === "DELETE")
    .map((request) => request.url);
  assert.deepEqual(deleteUrls, [
    "https://relaycron.test/v1/schedules/relaycron-1",
    "https://relaycron.test/v1/schedules/relaycron-2",
  ]);
});

test("watch fanout delivers the same workspace event to multiple registered agents", async () => {
  const state = new FakeDurableObjectState();
  const gateway = new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    RELAYAUTH_URL: "https://relayauth.test",
    AGENT_GATEWAY_BASE_URL: "http://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
    RELAYFILE_URL: "https://relayfile.test",
  } as never);

  gateway["relayfileClient"] = {
    subscribe() {
      return () => {};
    },
    async getResourceAtEvent() {
      return {
        data: {
          title: "Customer escalation follow-up",
          state: { name: "In Progress" },
        },
      };
    },
    async getEvents() {
      return { events: [], nextCursor: null };
    },
  } as never;

  await gateway["persistAuthenticatedSession"]({
    workspace: "support",
    agentId: "support-agent-a",
    agentName: "support-agent-a",
    accessToken: "relayfile-agent-token-a",
  });
  await gateway["persistAuthenticatedSession"]({
    workspace: "support",
    agentId: "support-agent-b",
    agentName: "support-agent-b",
    accessToken: "relayfile-agent-token-b",
  });

  const deliveredA: Array<Record<string, unknown>> = [];
  const deliveredB: Array<Record<string, unknown>> = [];
  const socketA = createLinkedSockets();
  const socketB = createLinkedSockets();
  socketA.client.onmessage = (message) => {
    deliveredA.push(JSON.parse(String(message.data)) as Record<string, unknown>);
  };
  socketB.client.onmessage = (message) => {
    deliveredB.push(JSON.parse(String(message.data)) as Record<string, unknown>);
  };
  socketA.server.serializeAttachment({
    workspace: "support",
    agentId: "support-agent-a",
    agentName: "support-agent-a",
    authenticated: true,
    legacyProtocol: false,
  });
  socketB.server.serializeAttachment({
    workspace: "support",
    agentId: "support-agent-b",
    agentName: "support-agent-b",
    authenticated: true,
    legacyProtocol: false,
  });
  state.acceptWebSocket(socketA.server);
  state.acceptWebSocket(socketB.server);

  await gateway["handleRegister"]("support-agent-a", socketA.server as never, {
    type: "register",
    watch: {
      glob: "/linear/**",
      coalesceMs: 0,
      replayOnStart: "none",
    },
  });
  await gateway["handleRegister"]("support-agent-b", socketB.server as never, {
    type: "register",
    watch: {
      glob: "/linear/**",
      coalesceMs: 0,
      replayOnStart: "none",
    },
  });

  await gateway["handleRelayfileWorkspaceEvent"]("support", {
    eventId: "evt-fanout-1",
    type: "file.updated",
    path: "/linear/issues/ENG-77.json",
    revision: "rev-77",
    timestamp: "2026-05-11T12:00:00.000Z",
    provider: "linear",
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    deliveredA.filter((entry) => entry.type === "event").map((entry) => (entry.event as { id: string }).id),
    ["evt-fanout-1"],
  );
  assert.deepEqual(
    deliveredB.filter((entry) => entry.type === "event").map((entry) => (entry.event as { id: string }).id),
    ["evt-fanout-1"],
  );
});

test("watch replay emits only the most recent matching events for last:N", async () => {
  const state = new FakeDurableObjectState();
  const gateway = new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    RELAYAUTH_URL: "https://relayauth.test",
    AGENT_GATEWAY_BASE_URL: "http://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
    RELAYFILE_URL: "https://relayfile.test",
  } as never);

  gateway["relayfileClient"] = {
    subscribe() {
      return () => {};
    },
    async getEvents() {
      return {
        events: [
          {
            eventId: "evt-3",
            type: "file.updated",
            path: "/linear/issues/ENG-3.json",
            revision: "rev-3",
            timestamp: "2026-05-11T12:00:03.000Z",
            provider: "linear",
          },
          {
            eventId: "evt-2",
            type: "file.updated",
            path: "/linear/issues/ENG-2.json",
            revision: "rev-2",
            timestamp: "2026-05-11T12:00:02.000Z",
            provider: "linear",
          },
          {
            eventId: "evt-1",
            type: "file.updated",
            path: "/github/repos/acme/platform/pulls/1.json",
            revision: "rev-1",
            timestamp: "2026-05-11T12:00:01.000Z",
            provider: "github",
          },
        ],
        nextCursor: null,
      };
    },
  } as never;

  const { client, server } = createLinkedSockets();
  const messages: Array<Record<string, unknown>> = [];
  client.onmessage = (message) => {
    messages.push(JSON.parse(String(message.data)) as Record<string, unknown>);
  };

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
    accessToken: "relayfile-agent-token",
  });

  await gateway["handleRegister"]("support-agent", server as never, {
    type: "register",
    watch: {
      glob: "/linear/**",
      coalesceMs: 0,
      replayOnStart: "last:2",
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise((resolve) => setImmediate(resolve));

  const delivered = messages.filter((entry) => entry.type === "event");
  assert.deepEqual(
    delivered.map((entry) => (entry.event as { id: string }).id),
    ["evt-2"],
  );

  await gateway["handleAck"]("support-agent", "evt-2");
  await new Promise((resolve) => setImmediate(resolve));

  const deliveredAfterAck = messages.filter((entry) => entry.type === "event");
  assert.deepEqual(
    deliveredAfterAck.map((entry) => (entry.event as { id: string }).id),
    ["evt-2", "evt-3"],
  );
});

test("watch backlog drops relayfile events before cron ticks when maxBacklog is saturated", async () => {
  const state = new FakeDurableObjectState();
  const gateway = new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    RELAYAUTH_URL: "https://relayauth.test",
    AGENT_GATEWAY_BASE_URL: "http://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
    RELAYFILE_URL: "https://relayfile.test",
  } as never);

  await gateway["persistAuthenticatedSession"]({
    workspace: "support",
    agentId: "support-agent",
    agentName: "support-agent",
    accessToken: "relayfile-agent-token",
  });

  const cronTick = createCronTickEvent({
    id: "evt-cron-1",
    workspace: "support",
    schedule: "*/5 * * * *",
    scheduledFor: "2026-05-12T00:00:00.000Z",
  });

  await gateway["enqueueEvent"]("support-agent", cronTick, 1);
  const accepted = await gateway["enqueueEvent"]("support-agent", {
    id: "evt-watch-1",
    workspace: "support",
    type: "relayfile.changed",
    occurredAt: "2026-05-12T00:00:01.000Z",
    attempt: 1,
    resource: {
      path: "/linear/issues/ENG-1.json",
      kind: "linear.issue",
      id: "ENG-1",
      provider: "linear",
    },
    summary: {
      title: "ENG-1",
      status: "updated",
    },
  }, 1);

  const stored = await state.storage.get("workspace-state") as {
    queues: Record<string, Array<{ eventId: string }>>;
  };

  assert.equal(accepted, false);
  assert.deepEqual(
    stored.queues["support-agent"]?.map((entry) => entry.eventId),
    ["evt-cron-1"],
  );
});
