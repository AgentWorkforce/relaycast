import assert from "node:assert/strict";
import { test } from "vitest";

import type { ResourceAtEventResult } from "../../../../relayfile/packages/sdk/typescript/src/types.js";
import { buildSummary as buildLinearSummary } from "@relayfile/adapter-linear";

import { events } from "@agent-relay/events";
import { WorkspaceGatewayDO } from "../src/durable-object.js";
import {
  createLinkedSockets,
  FakeDurableObjectState,
} from "./support/fake-cloudflare.js";

type GatewayWatchState = {
  ackedEventIds: string[];
  lastWatchRegistration?: string[];
  relayfileResource: ResourceAtEventResult;
  subscription?:
    | {
        onEvent: (event: unknown) => void;
        onError?: (error: unknown) => void;
      }
    | undefined;
  webhookReceivedAt?: number;
};

class GatewayBackedWebSocket {
  static readonly OPEN = 1;

  readonly client;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(state: FakeDurableObjectState, gateway: WorkspaceGatewayDO) {
    const { client, server } = createLinkedSockets();
    this.client = client;

    client.onmessage = (event) => {
      this.onmessage?.({ data: String(event.data) });
    };
    client.onclose = () => {
      this.readyState = 3;
      this.onclose?.();
    };

    queueMicrotask(() => {
      server.serializeAttachment({
        workspace: "support",
        agentId: "support-agent",
        agentName: "support-agent",
        authenticated: true,
        legacyProtocol: false,
      });
      state.acceptWebSocket(server);
      this.readyState = GatewayBackedWebSocket.OPEN;
      this.onopen?.();
    });

    void gateway;
  }

  send(payload: string): void {
    this.client.send(payload);
  }

  close(): void {
    this.readyState = 3;
    this.client.close();
  }
}

// TODO(cloud#548-dedupe-followup): re-enable this test after reconciling the
// gateway-protocol divergence between npm `@agent-relay/events@^6.0.21` and the
// in-cloud `WorkspaceGatewayDO`. The fork that previously lived at
// `packages/agent-relay-events/src/` was 595 diff lines from relay#844's
// canonical version; the websocket protocol handshake / event dispatch differs
// enough that this test's mock DO never sees the relayfile.changed delivery
// arrive. The test was green pre-dedupe (commit 2f1c33b2). Tracking issue:
// AgentWorkforce/cloud#TBD (see commit message of this skip).
test("M2 data trigger E2E: injected Linear watch events cross the real gateway DO watch boundary and expand returns the full payload", { timeout: 15_000 }, async () => {
  const linearIssue = {
    id: "ENG-412",
    title: "Customer escalation follow-up",
    description: "Priority escalation from support",
    state: { name: "In Progress" },
    labels: [{ name: "ops" }, { name: "urgent" }],
    actionBy: {
      id: "usr_linear_1",
      name: "Ada Lovelace",
    },
    previousData: {
      title: "Customer escalation triage",
    },
  };
  const relayfileResource: ResourceAtEventResult = {
    path: "/linear/issues/ENG-412.json",
    data: linearIssue,
    digest: "sha256:linear-eng-412",
  };
  const state = new FakeDurableObjectState();
  const watchState: GatewayWatchState = {
    ackedEventIds: [],
    relayfileResource,
  };
  const gateway = new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    RELAYAUTH_URL: "https://relayauth.test",
    RELAYFILE_URL: "https://relayfile.test",
    AGENT_GATEWAY_BASE_URL: "http://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
  } as never);
  const adapterSummary = buildLinearSummary(linearIssue);
  const expectedForwardedSummary = {
    ...adapterSummary,
    tags: ["linear", ...(adapterSummary.tags ?? [])],
  };
  let observedLatencyMs = Number.POSITIVE_INFINITY;
  let streamHandle: ReturnType<typeof events> | undefined;

  gateway["relayfileClient"] = {
    subscribe(input: {
      workspace: string;
      globs: string[];
      onEvent: (event: unknown) => void;
      onError?: (error: unknown) => void;
    }) {
      assert.equal(input.workspace, "support");
      watchState.lastWatchRegistration = input.globs;
      watchState.subscription = input;
      return {
        close() {
          watchState.subscription = undefined;
        },
      };
    },
    async getResourceAtEvent() {
      return watchState.relayfileResource;
    },
    async getEvents() {
      return { events: [], nextCursor: null };
    },
  } as never;

  const originalHandleAck = gateway["handleAck"].bind(gateway);
  gateway["handleAck"] = async (agentId: string, eventId: string) => {
    watchState.ackedEventIds.push(eventId);
    await originalHandleAck(agentId, eventId);
  };

  await gateway["persistAuthenticatedSession"]({
    workspace: "support",
    agentId: "support-agent",
    agentName: "support-agent",
    accessToken: "relayfile-agent-token",
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : String(input);
    if (url.startsWith("https://relayfile.test/v1/workspaces/support/fs/file")) {
      return new Response(
        JSON.stringify({
          path: watchState.relayfileResource.path,
          content: JSON.stringify(watchState.relayfileResource.data),
          contentType: "application/json",
          contentHash: watchState.relayfileResource.digest,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const delivery = new Promise<void>((resolve, reject) => {
      // 10s budget — npm-published @agent-relay/events@^6.0.21 has a slightly slower
      // websocket bootstrap + handshake than the in-tree fork; 2s was tight enough that
      // CI hit the deadline on first-event delivery (see cloud#548 dedupe commit 2f1c33b2).
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for the Linear watch delivery"));
      }, 10_000);

      const stream = events({
        workspace: "support",
        apiKey: "relay_ws_test",
        webSocketFactory: () => new GatewayBackedWebSocket(state, gateway) as never,
        onEvent: async (event) => {
          observedLatencyMs =
            Date.now() - (watchState.webhookReceivedAt ?? Date.now());
          assert.equal(event.type, "relayfile.changed");
          assert.equal(event.resource.path, "/linear/issues/ENG-412.json");
          assert.deepEqual(watchState.lastWatchRegistration, [
            "/linear/issues/**",
          ]);
          assert.deepEqual(event.summary, expectedForwardedSummary);

          const full = await event.expand("full");
          assert.deepEqual(full, {
            level: "full",
            path: "/linear/issues/ENG-412.json",
            data: linearIssue,
            digest: "sha256:linear-eng-412",
            url: "https://relayfile.test/v1/workspaces/support/fs/file?path=%2Flinear%2Fissues%2FENG-412.json",
          });

          clearTimeout(timeout);
          resolve();
        },
        onError: async (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      streamHandle = stream;

      void stream.ready
        .then(async () => {
          await stream.registerWatches(["/linear/issues/**"]);
          assert.ok(
            watchState.subscription,
            "gateway should install a workspace watch subscription",
          );
          watchState.webhookReceivedAt = Date.now();
          // This test exercises the real gateway DO fan-in after relayfile watch
          // registration. It injects at the watch subscription boundary rather
          // than driving provider HTTP webhook ingress.
          watchState.subscription?.onEvent({
            eventId: "evt_linear_watch_1",
            type: "file.updated",
            path: "/linear/issues/ENG-412.json",
            revision: "rev_linear_1",
            timestamp: "2026-05-12T01:00:00.000Z",
            provider: "linear",
          });
        })
        .catch(reject);
    });

    await delivery;
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(
      observedLatencyMs < 1_000,
      `expected watch delivery under 1s, got ${observedLatencyMs}ms`,
    );
    assert.deepEqual(watchState.ackedEventIds, ["evt_linear_watch_1"]);
  } finally {
    try {
      await streamHandle?.close();
    } catch {
      // Cleanup must not mask delivery assertions.
    }
    globalThis.fetch = originalFetch;
  }
});
