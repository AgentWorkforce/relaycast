import assert from "node:assert/strict";
import { test } from "vitest";

import type { RelaycastMessageEvent } from "@relaycast/sdk";

import {
  WorkspaceInboxSubscriber,
  type RelaycastInboxClient,
  type RelaycastInboxDeliveryAccepted,
  type RelaycastInboxMessageEvent,
  type RelaycastInboxSubscription,
} from "../src/inbox-subscriber.js";

type SubscribeCall = {
  agentId: string;
  selectors: string[];
};

type DisconnectCall = {
  agentId: string;
};

type FakeClientHandle = {
  client: RelaycastInboxClient;
  emit(event: RelaycastMessageEvent): void;
  emitDeliveryAccepted(event: RelaycastInboxDeliveryAccepted): void;
  hasDeliveryListener(): boolean;
};

function createFakeClient(
  calls: {
    subscribe: SubscribeCall[];
    unsubscribe: SubscribeCall[];
    disconnect: DisconnectCall[];
  },
  agentId: string,
): FakeClientHandle {
  let handler: ((event: RelaycastMessageEvent) => void | Promise<void>) | null = null;
  let deliveryHandler: ((event: RelaycastInboxDeliveryAccepted) => void) | null = null;
  let activeSelectors: string[] = [];

  const client: RelaycastInboxClient = {
    subscribe(channels, onMessage): RelaycastInboxSubscription {
      activeSelectors = [...channels];
      handler = onMessage;
      calls.subscribe.push({ agentId, selectors: [...channels] });
      return {
        unsubscribe: () => {
          calls.unsubscribe.push({ agentId, selectors: activeSelectors });
          handler = null;
          activeSelectors = [];
        },
      };
    },
    onDeliveryAccepted(callback) {
      deliveryHandler = callback;
      return () => {
        deliveryHandler = null;
      };
    },
    disconnect() {
      calls.disconnect.push({ agentId });
    },
  };

  return {
    client,
    emit(event) {
      if (handler) {
        void handler(event);
      }
    },
    emitDeliveryAccepted(event) {
      deliveryHandler?.(event);
    },
    hasDeliveryListener() {
      return deliveryHandler !== null;
    },
  };
}

test("WorkspaceInboxSubscriber subscribes the shared channel listener and one @self listener per agent", async () => {
  const calls = {
    subscribe: [] as SubscribeCall[],
    unsubscribe: [] as SubscribeCall[],
    disconnect: [] as DisconnectCall[],
  };
  const handles = new Map<string, FakeClientHandle>();
  const subscriber = new WorkspaceInboxSubscriber(
    "https://api.relaycast.dev",
    ({ agentId }) => {
      const handle = createFakeClient(calls, agentId);
      // multiple connections per agent may exist (shared + self); keep last
      handles.set(agentId, handle);
      return handle.client;
    },
    async () => {},
    async () => {},
    async (error) => {
      assert.fail(String(error));
    },
  );

  await subscriber.update([
    {
      agentId: "agent-a",
      accessToken: "token-a",
      selectors: ["ops", "#support", "@self"],
    },
    {
      agentId: "agent-b",
      accessToken: "token-b",
      selectors: ["ops", "@self"],
    },
  ]);

  // Sort by agentId+selector breadth so the assertion is deterministic.
  const subscribeByAgent = calls.subscribe.map((entry) => ({
    agentId: entry.agentId,
    selectors: [...entry.selectors].sort(),
  }));
  assert.deepEqual(
    subscribeByAgent.filter((entry) => entry.selectors.length > 1),
    [{ agentId: "agent-a", selectors: ["ops", "support"] }],
    "shared channel listener uses the owner agent's identity and unions selectors",
  );
  const selfCalls = subscribeByAgent.filter((entry) => entry.selectors[0] === "@self");
  assert.deepEqual(
    selfCalls.sort((a, b) => a.agentId.localeCompare(b.agentId)),
    [
      { agentId: "agent-a", selectors: ["@self"] },
      { agentId: "agent-b", selectors: ["@self"] },
    ],
    "each agent that declares @self gets its own self-listener",
  );
});

test("shared channel listener fans message.created events out only for active selectors", async () => {
  const calls = {
    subscribe: [] as SubscribeCall[],
    unsubscribe: [] as SubscribeCall[],
    disconnect: [] as DisconnectCall[],
  };
  let sharedHandle: FakeClientHandle | null = null;
  const channelEvents: Array<{ selector: string; event: RelaycastInboxMessageEvent }> = [];

  const subscriber = new WorkspaceInboxSubscriber(
    undefined,
    ({ agentId, accessToken }) => {
      const handle = createFakeClient(calls, agentId);
      if (!sharedHandle && accessToken === "token-a") {
        sharedHandle = handle;
      }
      return handle.client;
    },
    async (selector, event) => {
      channelEvents.push({ selector, event });
    },
    async () => {},
    async (error) => assert.fail(String(error)),
  );

  await subscriber.update([
    {
      agentId: "agent-a",
      accessToken: "token-a",
      selectors: ["ops"],
    },
  ]);

  assert.ok(sharedHandle, "shared channel handle should exist");

  sharedHandle!.emit({
    id: "evt-abc",
    type: "message.created",
    channel: "ops",
    message: {
      id: "msg-1",
      text: "all hands",
      agentId: "usr_1",
      agentName: "Alice",
    },
  } as unknown as RelaycastMessageEvent);

  sharedHandle!.emit({
    id: "evt-def",
    type: "message.created",
    channel: "noise",
    message: {
      id: "msg-2",
      text: "wrong channel",
      agentId: "usr_2",
      agentName: "Bob",
    },
  } as unknown as RelaycastMessageEvent);

  // Wait one microtask tick so the async handler invocations resolve.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(channelEvents.length, 1);
  assert.equal(channelEvents[0]!.selector, "ops");
  assert.equal(channelEvents[0]!.event.id, "evt-abc");
  assert.equal(channelEvents[0]!.event.messageId, "msg-1");
  assert.equal(channelEvents[0]!.event.text, "all hands");
});

test("self listener forwards dm.received events to the owning agent", async () => {
  const calls = {
    subscribe: [] as SubscribeCall[],
    unsubscribe: [] as SubscribeCall[],
    disconnect: [] as DisconnectCall[],
  };
  let selfHandle: FakeClientHandle | null = null;
  const selfEvents: Array<{ agentId: string; event: RelaycastInboxMessageEvent }> = [];

  const subscriber = new WorkspaceInboxSubscriber(
    undefined,
    ({ agentId }) => {
      const handle = createFakeClient(calls, agentId);
      selfHandle = handle;
      return handle.client;
    },
    async () => {},
    async (agentId, event) => {
      selfEvents.push({ agentId, event });
    },
    async (error) => assert.fail(String(error)),
  );

  await subscriber.update([
    {
      agentId: "agent-a",
      accessToken: "token-a",
      selectors: ["@self"],
    },
  ]);

  assert.ok(selfHandle, "self listener handle should exist");

  selfHandle!.emit({
    id: "evt-self-1",
    type: "dm.received",
    conversationId: "dm-conv-1",
    message: {
      id: "dm-1",
      text: "private hello",
      agentId: "usr_99",
      agentName: "Carol",
    },
  } as unknown as RelaycastMessageEvent);

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(selfEvents.length, 1);
  assert.equal(selfEvents[0]!.agentId, "agent-a");
  assert.equal(selfEvents[0]!.event.id, "evt-self-1");
  assert.equal(selfEvents[0]!.event.channel, "dm:dm-conv-1");
});

test("close() unsubscribes and disconnects every connection", async () => {
  const calls = {
    subscribe: [] as SubscribeCall[],
    unsubscribe: [] as SubscribeCall[],
    disconnect: [] as DisconnectCall[],
  };
  const subscriber = new WorkspaceInboxSubscriber(
    undefined,
    ({ agentId }) => createFakeClient(calls, agentId).client,
    async () => {},
    async () => {},
    async (error) => assert.fail(String(error)),
  );

  await subscriber.update([
    { agentId: "agent-a", accessToken: "token-a", selectors: ["ops", "@self"] },
    { agentId: "agent-b", accessToken: "token-b", selectors: ["@self"] },
  ]);

  await subscriber.close();

  // Shared (agent-a channels) + agent-a self + agent-b self = 3 connections.
  assert.equal(calls.subscribe.length, 3);
  assert.equal(calls.unsubscribe.length, 3);
  assert.equal(calls.disconnect.length, 3);
});

test("delivery.accepted events surface the connection's agent id", async () => {
  const calls = {
    subscribe: [] as SubscribeCall[],
    unsubscribe: [] as SubscribeCall[],
    disconnect: [] as DisconnectCall[],
  };
  const handles: Array<{ agentId: string; handle: FakeClientHandle }> = [];
  const accepted: Array<{ agentId: string; event: RelaycastInboxDeliveryAccepted }> = [];

  const subscriber = new WorkspaceInboxSubscriber(
    undefined,
    ({ agentId }) => {
      const handle = createFakeClient(calls, agentId);
      handles.push({ agentId, handle });
      return handle.client;
    },
    async () => {},
    async () => {},
    async (error) => assert.fail(String(error)),
    (agentId, event) => {
      accepted.push({ agentId, event });
    },
  );

  await subscriber.update([
    { agentId: "agent-a", accessToken: "token-a", selectors: ["ops", "@self"] },
    { agentId: "agent-b", accessToken: "token-b", selectors: ["@self"] },
  ]);

  // Every connection (shared channel + each @self) gets a delivery listener.
  assert.equal(handles.length, 3);
  for (const { handle } of handles) {
    assert.ok(handle.hasDeliveryListener(), "delivery listener should be attached");
  }

  const selfB = handles.find(
    ({ agentId, handle }) => agentId === "agent-b" && handle.hasDeliveryListener(),
  );
  assert.ok(selfB);
  selfB.handle.emitDeliveryAccepted({ deliveryId: "del-b-1", messageId: "msg-b-1" });

  // The shared channel connection is owned by agent-a, so its delivery
  // events are attributed to agent-a.
  const shared = handles.find(({ handle }) =>
    calls.subscribe.some(
      (entry) => entry.selectors.includes("ops"),
    ) && handle.hasDeliveryListener(),
  );
  assert.ok(shared);

  assert.deepEqual(accepted, [
    { agentId: "agent-b", event: { deliveryId: "del-b-1", messageId: "msg-b-1" } },
  ]);

  await subscriber.close();
  for (const { handle } of handles) {
    assert.ok(!handle.hasDeliveryListener(), "close() should stop delivery listeners");
  }
});

test("clients without delivery support still subscribe normally", async () => {
  const calls = {
    subscribe: [] as SubscribeCall[],
    unsubscribe: [] as SubscribeCall[],
    disconnect: [] as DisconnectCall[],
  };

  const subscriber = new WorkspaceInboxSubscriber(
    undefined,
    ({ agentId }) => {
      const handle = createFakeClient(calls, agentId);
      // Simulate a client (or test double) without onDeliveryAccepted.
      const { onDeliveryAccepted: _omit, ...rest } = handle.client;
      return rest as RelaycastInboxClient;
    },
    async () => {},
    async () => {},
    async (error) => assert.fail(String(error)),
    () => {},
  );

  await subscriber.update([
    { agentId: "agent-a", accessToken: "token-a", selectors: ["@self"] },
  ]);

  assert.equal(calls.subscribe.length, 1);
  await subscriber.close();
  assert.equal(calls.disconnect.length, 1);
});
