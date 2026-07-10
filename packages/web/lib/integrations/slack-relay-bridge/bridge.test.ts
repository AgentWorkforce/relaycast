import { beforeEach, describe, expect, it, vi } from "vitest";
import { forwardSlackToRelay } from "./bridge";
import type { RelayPoster, SlackRelayStore } from "./types";

function createStore(overrides?: Partial<SlackRelayStore>): SlackRelayStore {
  return {
    findLink: vi.fn().mockResolvedValue({
      id: "link_1",
      workspaceId: "workspace_1",
      slackChannelId: "C123",
      relayChannelId: "engineering",
    }),
    findMapping: vi.fn().mockResolvedValue(null),
    recordMapping: vi.fn().mockResolvedValue({ inserted: true }),
    ...overrides,
  };
}

function createPoster(): RelayPoster {
  return {
    post: vi.fn().mockResolvedValue({ messageId: "msg_1" }),
  };
}

describe("forwardSlackToRelay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts linked Slack messages to the relay channel and records the mapping", async () => {
    const store = createStore();
    const poster = createPoster();

    const outcome = await forwardSlackToRelay(
      {
        workspaceId: "workspace_1",
        slackChannelId: "C123",
        slackTs: "1779100000.000100",
        text: "hello from Slack",
        slackUserName: "Ava",
      },
      { store, poster },
    );

    expect(outcome).toEqual({
      status: "posted",
      relayMessageId: "msg_1",
      linkId: "link_1",
    });
    expect(poster.post).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      relayChannelId: "engineering",
      text: "hello from Slack",
      fromName: "Ava",
      idempotencyKey: "slack:link_1:1779100000.000100",
    });
    expect(store.recordMapping).toHaveBeenCalledWith({
      linkId: "link_1",
      slackTs: "1779100000.000100",
      relayMessageId: "msg_1",
      direction: "slack_to_relay",
    });
  });

  it("skips unlinked Slack channels", async () => {
    const store = createStore({ findLink: vi.fn().mockResolvedValue(null) });
    const poster = createPoster();

    const outcome = await forwardSlackToRelay(
      {
        workspaceId: "workspace_1",
        slackChannelId: "C404",
        slackTs: "1779100000.000200",
        text: "ignored",
      },
      { store, poster },
    );

    expect(outcome).toEqual({ status: "skipped", reason: "no_link" });
    expect(poster.post).not.toHaveBeenCalled();
  });

  it("dedupes retried Slack deliveries by link and slack ts", async () => {
    const store = createStore({
      findMapping: vi.fn().mockResolvedValue({ relayMessageId: "msg_existing" }),
    });
    const poster = createPoster();

    const outcome = await forwardSlackToRelay(
      {
        workspaceId: "workspace_1",
        slackChannelId: "C123",
        slackTs: "1779100000.000300",
        text: "already delivered",
      },
      { store, poster },
    );

    expect(outcome).toEqual({ status: "skipped", reason: "duplicate" });
    expect(poster.post).not.toHaveBeenCalled();
  });
});
