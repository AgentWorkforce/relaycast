import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

import { WorkspaceGatewayDO } from "../src/durable-object.js";
import {
  LEGACY_DRAIN_CORRELATION_PREFIX,
  shouldSuppressRelayfileWatchDelivery,
} from "../src/watch-subscriber.js";
import {
  createLinkedSockets,
  FakeDurableObjectState,
} from "./support/fake-cloudflare.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

// Cross-package drift guard (cloud2029-shadow #2038): the relayfile DO drain
// stamps this exact prefix; if the agent-gateway copy drifts, drain tombstones
// silently un-suppress. Pin both copies to the canonical literal (the relayfile
// side asserts the same in drain-legacy-drafts.test.ts).
test("LEGACY_DRAIN_CORRELATION_PREFIX matches the canonical literal", () => {
  assert.equal(LEGACY_DRAIN_CORRELATION_PREFIX, "relayfile:legacy-draft-drain:");
});

const DRAIN_CORR = `${LEGACY_DRAIN_CORRELATION_PREFIX}run_1`;

// ── Unit: the narrow predicate (cloud#2029 #2). ───────────────────────────────
// Mutation guards: broadening to "all system deletes" makes the non-drain-system
// case fail; dropping the type check makes the file.updated case fail.

test("shouldSuppressRelayfileWatchDelivery: suppresses ONLY a drain-marked system file.deleted", () => {
  assert.equal(
    shouldSuppressRelayfileWatchDelivery({
      type: "file.deleted",
      origin: "system",
      correlationId: DRAIN_CORR,
    }),
    true,
  );
});

test("shouldSuppressRelayfileWatchDelivery: does NOT suppress a non-drain system delete (digest/sync/d1)", () => {
  assert.equal(
    shouldSuppressRelayfileWatchDelivery({
      type: "file.deleted",
      origin: "system",
      correlationId: "digest-refresh",
    }),
    false,
  );
  assert.equal(
    shouldSuppressRelayfileWatchDelivery({
      type: "file.deleted",
      origin: "system",
      // no correlationId at all
    }),
    false,
  );
});

test("shouldSuppressRelayfileWatchDelivery: does NOT suppress agent/provider deletes or non-deletes", () => {
  assert.equal(
    shouldSuppressRelayfileWatchDelivery({
      type: "file.deleted",
      origin: "agent_write",
      correlationId: DRAIN_CORR,
    }),
    false,
  );
  assert.equal(
    shouldSuppressRelayfileWatchDelivery({
      type: "file.updated",
      origin: "system",
      correlationId: DRAIN_CORR,
    }),
    false,
  );
});

function makeGateway(state: FakeDurableObjectState) {
  return new WorkspaceGatewayDO(state as never, {
    WORKSPACE_GATEWAY_DO: {} as never,
    RELAYAUTH_URL: "https://relayauth.test",
    AGENT_GATEWAY_BASE_URL: "http://agent-gateway.test",
    AGENT_GATEWAY_INTERNAL_SECRET: "internal-test-secret",
    RELAYFILE_URL: "https://relayfile.test",
  } as never);
}

async function registerSlackWatch(
  gateway: WorkspaceGatewayDO,
  state: FakeDurableObjectState,
  server: WebSocket,
  replayOnStart: string,
): Promise<void> {
  server.serializeAttachment({
    workspace: "support",
    agentId: "slack-comms",
    agentName: "slack-comms",
    authenticated: true,
    legacyProtocol: false,
  });
  state.acceptWebSocket(server);
  await gateway["persistAuthenticatedSession"]({
    workspace: "support",
    agentId: "slack-comms",
    agentName: "slack-comms",
    accessToken: "relayfile-agent-token",
  });
  await gateway["handleRegister"]("slack-comms", server as never, {
    type: "register",
    watch: { glob: "/slack/channels/**", coalesceMs: 10, replayOnStart },
  });
}

// ── Integration: live fan-out (handleRelayfileWorkspaceEvent). ────────────────

test("handleRelayfileWorkspaceEvent suppresses a drain-marked tombstone but delivers a normal delete", async () => {
  const state = new FakeDurableObjectState();
  const gateway = makeGateway(state);
  gateway["relayfileClient"] = {
    subscribe: () => () => {},
    async getResourceAtEvent() {
      return { data: {} };
    },
    async getEvents() {
      return { events: [], nextCursor: null };
    },
  } as never;

  const { client, server } = createLinkedSockets();
  const messages: Array<Record<string, unknown>> = [];
  client.onmessage = (m) => messages.push(JSON.parse(String(m.data)) as Record<string, unknown>);
  await registerSlackWatch(gateway, state, server, "none");

  // Drain-marked tombstone → suppressed (it still cleared the mount via the feed).
  await gateway["handleRelayfileWorkspaceEvent"]("support", {
    eventId: "evt-drain",
    type: "file.deleted",
    path: "/slack/channels/C0B8ZL2L9GC__x/messages/draft-abc.json",
    revision: "rev-9",
    timestamp: "2026-06-09T12:00:00.000Z",
    provider: "slack",
    origin: "system",
    correlationId: DRAIN_CORR,
  });
  // A genuine (non-drain) delete still delivers.
  await gateway["handleRelayfileWorkspaceEvent"]("support", {
    eventId: "evt-real",
    type: "file.deleted",
    path: "/slack/channels/C0B8ZL2L9GC__x/messages/draft-real.json",
    revision: "rev-10",
    timestamp: "2026-06-09T12:00:01.000Z",
    provider: "slack",
    origin: "agent_write",
  });

  await new Promise((resolve) => setTimeout(resolve, 40));
  await new Promise((resolve) => setImmediate(resolve));

  const delivered = messages.filter((entry) => entry.type === "event");
  assert.equal(delivered.length, 1);
  assert.equal((delivered[0]?.event as { id: string }).id, "evt-real");
});

// ── Integration: REPLAY path (replayRegisteredWatchEvents) — the stored-feed
// gotcha an operator mute can't bracket. ──────────────────────────────────────

test("replayRegisteredWatchEvents suppresses a drain-marked tombstone on re-registration", async () => {
  const state = new FakeDurableObjectState();
  const gateway = makeGateway(state);
  gateway["relayfileClient"] = {
    subscribe: () => () => {},
    async getResourceAtEvent() {
      return { data: {} };
    },
    async getEvents() {
      return { events: [], nextCursor: null };
    },
    async listLastNChanges() {
      return [
        {
          eventId: "evt-drain-replay",
          type: "file.deleted",
          path: "/slack/channels/C0B8ZL2L9GC__x/messages/draft-abc.json",
          revision: "rev-9",
          timestamp: "2026-06-09T12:00:00.000Z",
          provider: "slack",
          origin: "system",
          correlationId: DRAIN_CORR,
        },
        {
          eventId: "evt-real-replay",
          type: "file.updated",
          path: "/slack/channels/C0B8ZL2L9GC__x/messages/draft-real.json",
          revision: "rev-10",
          timestamp: "2026-06-09T12:00:01.000Z",
          provider: "slack",
          origin: "agent_write",
        },
      ];
    },
  } as never;

  const { client, server } = createLinkedSockets();
  const messages: Array<Record<string, unknown>> = [];
  client.onmessage = (m) => messages.push(JSON.parse(String(m.data)) as Record<string, unknown>);
  await registerSlackWatch(gateway, state, server, "last:5");

  await gateway["replayRegisteredWatchEvents"]("slack-comms");
  await new Promise((resolve) => setTimeout(resolve, 40));
  await new Promise((resolve) => setImmediate(resolve));

  const delivered = messages.filter((entry) => entry.type === "event");
  // The drain tombstone must NOT re-deliver; the real change still does.
  assert.ok(delivered.every((e) => (e.event as { id?: string }).id !== "evt-drain-replay"));
  assert.ok(delivered.some((e) => (e.event as { id?: string }).id === "evt-real-replay"));
});
