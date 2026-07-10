import { beforeEach, describe, expect, it, vi } from "vitest";
import { isAllowedSlackProxyRoute } from "../slack-proxy-schema";
import {
  handleSlackRelayOutboundEvent,
  type RelaycastOutboundEvent,
  type SlackRelayOutboundEgress,
  type SlackRelayOutboundMapping,
  type SlackRelayOutboundStore,
} from "./bridge";

const link = {
  id: "link-1",
  workspaceId: "workspace-1",
  slackChannelId: "C123",
  relayChannelId: "relay-general",
};

const baseEvent: RelaycastOutboundEvent = {
  type: "message.created",
  workspaceId: link.workspaceId,
  relayChannelId: link.relayChannelId,
  messageId: "relay-message-1",
  text: "hello from relay",
  authorName: "agent",
};

function createStore(mapping?: SlackRelayOutboundMapping): SlackRelayOutboundStore & {
  mappings: SlackRelayOutboundMapping[];
} {
  const mappings = mapping ? [mapping] : [];
  return {
    mappings,
    async findLinkByRelayChannel() {
      return link;
    },
    async findMappingByRelayMessage(input) {
      return mappings.find((row) => row.relayMessageId === input.relayMessageId) ?? null;
    },
    async recordMapping(input) {
      if (mappings.some((row) => row.slackTs === input.slackTs)) {
        return { inserted: false };
      }
      mappings.push(input);
      return { inserted: true };
    },
  };
}

function createEgress(): SlackRelayOutboundEgress {
  return {
    postMessage: vi.fn(async () => ({ ok: true, ts: "1700000000.000100" })),
    updateMessage: vi.fn(async () => ({ ok: true })),
    deleteMessage: vi.fn(async () => ({ ok: true })),
    startStream: vi.fn(async () => ({ ok: true, ts: "1700000000.000200" })),
    appendStream: vi.fn(async () => ({ ok: true })),
    stopStream: vi.fn(async () => ({ ok: true })),
  };
}

describe("handleSlackRelayOutboundEvent", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("short-circuits when SLACK_RELAY_BRIDGE_OUTBOUND_ENABLED is false", async () => {
    const egress = createEgress();
    const outcome = await handleSlackRelayOutboundEvent(baseEvent, {
      store: createStore(),
      egress,
      isEnabled: () => false,
    });

    expect(outcome).toEqual({ status: "disabled" });
    expect(egress.postMessage).not.toHaveBeenCalled();
  });

  it("posts relay messages to Slack and records the relay_to_slack mapping", async () => {
    const store = createStore();
    const egress = createEgress();

    const outcome = await handleSlackRelayOutboundEvent(baseEvent, {
      store,
      egress,
      isEnabled: () => true,
    });

    expect(outcome).toEqual({
      status: "posted",
      slackTs: "1700000000.000100",
      linkId: link.id,
    });
    expect(egress.postMessage).toHaveBeenCalledWith({
      workspaceId: link.workspaceId,
      channel: link.slackChannelId,
      text: "*agent:* hello from relay",
      unfurlLinks: false,
    });
    expect(store.mappings).toEqual([
      {
        linkId: link.id,
        slackTs: "1700000000.000100",
        relayMessageId: baseEvent.messageId,
        direction: "relay_to_slack",
      },
    ]);
  });

  it("updates and deletes Slack messages through the stored relay mapping", async () => {
    const mapping = {
      linkId: link.id,
      slackTs: "1700000000.000100",
      relayMessageId: baseEvent.messageId,
      direction: "relay_to_slack" as const,
    };
    const egress = createEgress();

    const updated = await handleSlackRelayOutboundEvent(
      { ...baseEvent, type: "message.updated", text: "edited" },
      { store: createStore(mapping), egress, isEnabled: () => true },
    );
    const deleted = await handleSlackRelayOutboundEvent(
      { ...baseEvent, type: "message.deleted" },
      { store: createStore(mapping), egress, isEnabled: () => true },
    );

    expect(updated).toEqual({ status: "updated", slackTs: mapping.slackTs, linkId: link.id });
    expect(deleted).toEqual({ status: "deleted", slackTs: mapping.slackTs, linkId: link.id });
    expect(egress.updateMessage).toHaveBeenCalledWith({
      workspaceId: link.workspaceId,
      channel: link.slackChannelId,
      ts: mapping.slackTs,
      text: "*agent:* edited",
    });
    expect(egress.deleteMessage).toHaveBeenCalledWith({
      workspaceId: link.workspaceId,
      channel: link.slackChannelId,
      ts: mapping.slackTs,
    });
    expect(isAllowedSlackProxyRoute("/chat.delete", "POST")).toBe(true);
  });

  it("uses Slack stream APIs and stores the returned stream timestamp", async () => {
    const store = createStore();
    const egress = createEgress();

    const started = await handleSlackRelayOutboundEvent(
      { ...baseEvent, type: "stream.started", markdownText: "working" },
      { store, egress, isEnabled: () => true },
    );
    const appended = await handleSlackRelayOutboundEvent(
      { ...baseEvent, type: "stream.appended", markdownText: "still working" },
      { store, egress, isEnabled: () => true },
    );
    const stopped = await handleSlackRelayOutboundEvent(
      { ...baseEvent, type: "stream.stopped", markdownText: "done" },
      { store, egress, isEnabled: () => true },
    );

    expect(started).toEqual({
      status: "stream_started",
      slackTs: "1700000000.000200",
      linkId: link.id,
    });
    expect(appended).toEqual({
      status: "stream_appended",
      slackTs: "1700000000.000200",
      linkId: link.id,
    });
    expect(stopped).toEqual({
      status: "stream_stopped",
      slackTs: "1700000000.000200",
      linkId: link.id,
    });
    expect(egress.startStream).toHaveBeenCalledWith({
      workspaceId: link.workspaceId,
      channel: link.slackChannelId,
      markdownText: "working",
    });
    expect(egress.appendStream).toHaveBeenCalledWith({
      workspaceId: link.workspaceId,
      channel: link.slackChannelId,
      ts: "1700000000.000200",
      markdownText: "still working",
    });
    expect(egress.stopStream).toHaveBeenCalledWith({
      workspaceId: link.workspaceId,
      channel: link.slackChannelId,
      ts: "1700000000.000200",
      markdownText: "done",
    });
  });
});
