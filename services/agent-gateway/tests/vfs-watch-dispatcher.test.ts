import assert from "node:assert/strict";
import { test } from "vitest";
import { deriveIntegrationWatchDeliveryId } from "@cloud/core/proactive-runtime/match.js";

import {
  claimVfsWatchDelivery,
  onVfsWatchEvent,
  releaseVfsWatchDelivery,
  vfsWatchDedupeKey,
  type VfsWatchDispatchCandidate,
} from "../src/watch-subscriber.js";
import { WorkspaceGatewayDO } from "../src/durable-object.js";
import {
  FakeDurableObjectState,
  FakeDurableObjectStorage,
} from "./support/fake-cloudflare.js";

const event = {
  workspaceId: "support",
  path: "/github/issues/opened/42.json",
  writeId: "write-1",
  provider: "github",
  eventType: "issues.opened",
  occurredAt: "2026-05-21T12:00:00.000Z",
};
const eventDedupeId = deriveIntegrationWatchDeliveryId({
  workspaceId: event.workspaceId,
  provider: event.provider,
  eventType: event.eventType,
  paths: [event.path],
});

test("onVfsWatchEvent records dedupe after a successful first delivery", async () => {
  const storage = new FakeDurableObjectStorage();
  const delivered: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const candidates: VfsWatchDispatchCandidate[] = [
    {
      agentId: "agent-1",
      watchGlobs: ["/github/issues/opened/**"],
    },
  ];

  const first = await onVfsWatchEvent(event, {
    storage: storage as never,
    async readCandidateAgents() {
      return candidates;
    },
    async deliver(candidate) {
      delivered.push(candidate.agentId);
    },
    log(entry) {
      logs.push(entry);
    },
    nowMs: () => 1_000,
  });

  const second = await onVfsWatchEvent(event, {
    storage: storage as never,
    async readCandidateAgents() {
      return candidates;
    },
    async deliver() {
      throw new Error("should not deliver after dedupe");
    },
    log(entry) {
      logs.push(entry);
    },
    nowMs: () => 2_000,
  });

  assert.deepEqual(first, {
    matched: 1,
    delivered: 1,
    failed: 0,
    skipped: 0,
    dedupe: "first",
  });
  assert.deepEqual(second, {
    matched: 1,
    delivered: 0,
    failed: 0,
    skipped: 1,
    dedupe: "skipped",
  });
  assert.deepEqual(delivered, ["agent-1"]);
  assert.equal(
    Boolean(await storage.get(vfsWatchDedupeKey("support", "agent-1", eventDedupeId))),
    true,
  );
  assert.deepEqual(
    logs.map((entry) => entry.dedupe),
    ["first", "skipped"],
  );
});

test("onVfsWatchEvent uses the shared integration watch delivery id for dedupe", async () => {
  const storage = new FakeDurableObjectStorage();
  const delivered: string[] = [];
  const candidates: VfsWatchDispatchCandidate[] = [
    {
      agentId: "agent-1",
      watchGlobs: ["/github/issues/opened/**"],
    },
  ];
  const inlineDeliveryId = deriveIntegrationWatchDeliveryId({
    workspaceId: event.workspaceId,
    provider: event.provider,
    eventType: event.eventType,
    paths: [event.path],
  });

  await claimVfsWatchDelivery(
    storage as never,
    event.workspaceId,
    "agent-1",
    inlineDeliveryId,
    1_000,
  );

  const result = await onVfsWatchEvent(event, {
    storage: storage as never,
    async readCandidateAgents() {
      return candidates;
    },
    async deliver(candidate) {
      delivered.push(candidate.agentId);
    },
    log() {},
    nowMs: () => 2_000,
  });

  assert.deepEqual(result, {
    matched: 1,
    delivered: 0,
    failed: 0,
    skipped: 1,
    dedupe: "skipped",
  });
  assert.deepEqual(delivered, []);
});

test("onVfsWatchEvent matches and filters candidate agents using shared watch logic", async () => {
  const storage = new FakeDurableObjectStorage();
  const delivered: string[] = [];

  const result = await onVfsWatchEvent(event, {
    storage: storage as never,
    async readCandidateAgents() {
      return [
        {
          agentId: "agent-match",
          watchGlobs: ["/github/issues/opened/**"],
        },
        {
          agentId: "agent-miss",
          watchGlobs: ["/linear/issues/**"],
        },
      ];
    },
    async deliver(candidate) {
      delivered.push(candidate.agentId);
    },
    log() {},
  });

  assert.equal(result.matched, 1);
  assert.equal(result.delivered, 1);
  assert.equal(result.skipped, 0);
  assert.deepEqual(delivered, ["agent-match"]);
});

test("onVfsWatchEvent delivers provider-prefixed AgentEvent payloads for VFS trigger events", async () => {
  const storage = new FakeDurableObjectStorage();
  const delivered: Array<{
    candidate: VfsWatchDispatchCandidate;
    payload: Record<string, unknown>;
  }> = [];
  const neonEvent = {
    workspaceId: "support",
    path: "/neon/operations/op-1.json",
    writeId: "neon:operation.failed:op-1:2026-06-18T09:00:00.000Z",
    provider: "neon",
    eventType: "operation.failed",
    connectionId: "conn-neon",
    occurredAt: "2026-06-18T09:00:00.000Z",
    payload: {
      id: "op-1",
      objectType: "operation",
      payload: { id: "op-1", status: "failed" },
      metadata: { action: "ADDED" },
    },
  };

  const result = await onVfsWatchEvent(neonEvent, {
    storage: storage as never,
    async readCandidateAgents() {
      return [{ agentId: "neon-agent", watchGlobs: ["/neon/operations/**"] }];
    },
    async deliver(candidate, payload) {
      delivered.push({ candidate, payload: payload as unknown as Record<string, unknown> });
    },
    log() {},
  });

  assert.equal(result.matched, 1);
  assert.equal(result.delivered, 1);
  assert.equal(delivered[0]?.candidate.agentId, "neon-agent");
  assert.deepEqual(delivered[0]?.payload, {
    id: "neon:operation.failed:op-1:2026-06-18T09:00:00.000Z",
    eventId: "neon:operation.failed:op-1:2026-06-18T09:00:00.000Z",
    type: "neon.operation.failed",
    deliveryId: "neon:operation.failed:op-1:2026-06-18T09:00:00.000Z",
    path: "/neon/operations/op-1.json",
    paths: ["/neon/operations/op-1.json"],
    revision: "neon:operation.failed:op-1:2026-06-18T09:00:00.000Z",
    timestamp: "2026-06-18T09:00:00.000Z",
    occurredAt: "2026-06-18T09:00:00.000Z",
    provider: "neon",
    eventType: "operation.failed",
    resource: neonEvent.payload,
  });
});

test("onVfsWatchEvent leaves dedupe unmarked when delivery fails so the next event retries", async () => {
  const storage = new FakeDurableObjectStorage();
  let attempts = 0;

  const first = await onVfsWatchEvent(event, {
    storage: storage as never,
    async readCandidateAgents() {
      return [{ agentId: "agent-1", watchGlobs: ["/github/issues/opened/**"] }];
    },
    async deliver() {
      attempts += 1;
      throw new Error("daytona unavailable");
    },
    log() {},
  });

  const second = await onVfsWatchEvent(event, {
    storage: storage as never,
    async readCandidateAgents() {
      return [{ agentId: "agent-1", watchGlobs: ["/github/issues/opened/**"] }];
    },
    async deliver() {
      attempts += 1;
    },
    log() {},
  });

  assert.deepEqual(first, {
    matched: 1,
    delivered: 0,
    failed: 1,
    skipped: 0,
    dedupe: "first",
  });
  assert.deepEqual(second, {
    matched: 1,
    delivered: 1,
    failed: 0,
    skipped: 0,
    dedupe: "first",
  });
  assert.equal(attempts, 2);
  assert.equal(
    Boolean(await storage.get(vfsWatchDedupeKey("support", "agent-1", eventDedupeId))),
    true,
  );
});

test("onVfsWatchEvent claims per agent so concurrent dispatchers produce one delivery", async () => {
  const storage = new FakeDurableObjectStorage();
  const delivered: string[] = [];
  const candidates: VfsWatchDispatchCandidate[] = [
    {
      agentId: "agent-1",
      watchGlobs: ["/github/issues/opened/**"],
    },
  ];

  const [first, second] = await Promise.all([
    onVfsWatchEvent(event, {
      storage: storage as never,
      async readCandidateAgents() {
        return candidates;
      },
      async deliver(candidate) {
        delivered.push(`first:${candidate.agentId}`);
      },
      log() {},
      nowMs: () => 1_000,
    }),
    onVfsWatchEvent(event, {
      storage: storage as never,
      async readCandidateAgents() {
        return candidates;
      },
      async deliver(candidate) {
        delivered.push(`second:${candidate.agentId}`);
      },
      log() {},
      nowMs: () => 1_000,
    }),
  ]);

  assert.equal(first.delivered + second.delivered, 1);
  assert.equal(first.skipped + second.skipped, 1);
  assert.equal(delivered.length, 1);
});

test("onVfsWatchEvent retries only failed agents after partial fan-out", async () => {
  const storage = new FakeDurableObjectStorage();
  const attempts: string[] = [];
  const candidates: VfsWatchDispatchCandidate[] = [
    { agentId: "agent-a", watchGlobs: ["/github/issues/opened/**"] },
    { agentId: "agent-b", watchGlobs: ["/github/issues/opened/**"] },
  ];

  const first = await onVfsWatchEvent(event, {
    storage: storage as never,
    async readCandidateAgents() {
      return candidates;
    },
    async deliver(candidate) {
      attempts.push(`first:${candidate.agentId}`);
      if (candidate.agentId === "agent-b") {
        throw new Error("sandbox unavailable");
      }
    },
    log() {},
    nowMs: () => 1_000,
  });

  const second = await onVfsWatchEvent(event, {
    storage: storage as never,
    async readCandidateAgents() {
      return candidates;
    },
    async deliver(candidate) {
      attempts.push(`second:${candidate.agentId}`);
    },
    log() {},
    nowMs: () => 2_000,
  });

  assert.deepEqual(first, {
    matched: 2,
    delivered: 1,
    failed: 1,
    skipped: 0,
    dedupe: "first",
  });
  assert.deepEqual(second, {
    matched: 2,
    delivered: 1,
    failed: 0,
    skipped: 1,
    dedupe: "first",
  });
  assert.deepEqual(attempts, [
    "first:agent-a",
    "first:agent-b",
    "second:agent-b",
  ]);
  assert.equal(
    Boolean(await storage.get(vfsWatchDedupeKey("support", "agent-a", eventDedupeId))),
    true,
  );
  assert.equal(
    Boolean(await storage.get(vfsWatchDedupeKey("support", "agent-b", eventDedupeId))),
    true,
  );
});

test("claimVfsWatchDelivery releases failed agent claims without clearing successes", async () => {
  const storage = new FakeDurableObjectStorage();

  assert.equal(
    await claimVfsWatchDelivery(storage as never, "support", "agent-a", "write-1", 1_000),
    "claimed",
  );
  assert.equal(
    await claimVfsWatchDelivery(storage as never, "support", "agent-a", "write-1", 1_001),
    "skipped",
  );
  await releaseVfsWatchDelivery(storage as never, "support", "agent-a", "write-1");
  assert.equal(
    await claimVfsWatchDelivery(storage as never, "support", "agent-a", "write-1", 1_002),
    "claimed",
  );
});

test("workspace VFS watch POST reads persona candidates from Cloud Web and invokes deployment delivery", async () => {
  const state = new FakeDurableObjectState();
  const delivered: Array<Record<string, unknown>> = [];
  const cloudWeb = {
    async fetch(request: Request): Promise<Response> {
      if (request.url.endsWith("/api/internal/proactive-runtime/vfs-watch/candidates")) {
        return Response.json({
          ok: true,
          data: {
            agents: [
              {
                agentId: "persona-agent",
                watchGlobs: ["/github/issues/opened/**"],
                spec: null,
              },
            ],
          },
        });
      }
      if (request.url.endsWith("/api/internal/proactive-runtime/vfs-watch/deliver")) {
        delivered.push(await request.json() as Record<string, unknown>);
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

  const response = await gateway.fetch(new Request("https://agent-gateway.internal/internal/vfs-watch", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-gateway-workspace": "support",
    },
    body: JSON.stringify(event),
  }));

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json() as { data: unknown }).data, {
    matched: 1,
    delivered: 1,
    failed: 0,
    skipped: 0,
    dedupe: "first",
  });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.workspaceId, "support");
  assert.equal(delivered[0]?.agentId, "persona-agent");
});

test("workspace VFS watch POST ignores DO-registered watches when Cloud Web has no active persona candidate", async () => {
  const state = new FakeDurableObjectState();
  await state.storage.put("workspace-state", {
    workspace: "support",
    agents: {
      registeredOnly: {
        agentId: "registered-only",
        agentName: "registered-only",
        workspace: "support",
        schedules: [],
        watches: [{ glob: "/github/issues/opened/**", replayOnStart: "none", coalesceMs: 0 }],
      },
    },
    queues: {},
  });
  const delivered: Array<Record<string, unknown>> = [];
  const gateway = new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    CLOUD_WEB_WORKER: {
      async fetch(request: Request): Promise<Response> {
        if (request.url.endsWith("/api/internal/proactive-runtime/vfs-watch/candidates")) {
          return Response.json({ ok: true, data: { agents: [] } });
        }
        delivered.push(await request.json() as Record<string, unknown>);
        return Response.json({ ok: true }, { status: 202 });
      },
    },
    RELAYAUTH_URL: "https://relayauth.test",
    AGENT_GATEWAY_BASE_URL: "http://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
  } as never);

  const response = await gateway.fetch(new Request("https://agent-gateway.internal/internal/vfs-watch", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-gateway-workspace": "support",
    },
    body: JSON.stringify(event),
  }));

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json() as { data: unknown }).data, {
    matched: 0,
    delivered: 0,
    failed: 0,
    skipped: 0,
    dedupe: "first",
  });
  assert.deepEqual(delivered, []);
});
