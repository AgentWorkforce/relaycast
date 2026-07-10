import { describe, expect, it } from "vitest";

import {
  parseSlackReplyMessagePath,
  slackUserReplyCorrelationKey,
  slackUserReplyCorrelationKeyFromPayload,
} from "./continuation-correlation";

describe("continuation Slack user-reply correlation", () => {
  it("builds the exact key consumed by the resume lookup", () => {
    expect(
      slackUserReplyCorrelationKey({
        channel: "C123",
        thread: "1700000000.000100",
        user: "U123",
      }),
    ).toBe("slack:channel:C123:thread:1700000000.000100:user:U123");
  });

  it("normalizes suffixed Relayfile channel segments before building keys", () => {
    expect(
      slackUserReplyCorrelationKey({
        channel: "C123__support",
        thread: "1700000000.000100",
        user: "U123",
      }),
    ).toBe("slack:channel:C123:thread:1700000000.000100:user:U123");
  });

  it("extracts the same key from Slack message payloads", () => {
    expect(
      slackUserReplyCorrelationKeyFromPayload({
        type: "slack.message.created",
        resource: {
          channel: "C123",
          thread_ts: "1700000000.000100",
          user: "U123",
          ts: "1700000001.000200",
        },
      }),
    ).toBe("slack:channel:C123:thread:1700000000.000100:user:U123");
  });

  it("extracts normalized keys from suffixed Relayfile channel payloads", () => {
    expect(
      slackUserReplyCorrelationKeyFromPayload({
        type: "slack.message.created",
        resource: {
          channel: "C123__support",
          thread_ts: "1700000000.000100",
          user: "U123",
          ts: "1700000001.000200",
        },
      }),
    ).toBe("slack:channel:C123:thread:1700000000.000100:user:U123");
  });

  it("parses concrete workspace-local Slack reply paths", () => {
    expect(
      parseSlackReplyMessagePath(
        "/slack/channels/C123/messages/1700000000.000100/replies/1700000001.000200.json",
      ),
    ).toEqual({
      channel: "C123",
      thread: "1700000000.000100",
      replyTs: "1700000001.000200",
    });
  });

  it("normalizes suffixed channel segments when parsing Slack reply paths", () => {
    expect(
      parseSlackReplyMessagePath(
        "/slack/channels/C123__support/messages/1700000000.000100/replies/1700000001.000200.json",
      ),
    ).toEqual({
      channel: "C123",
      thread: "1700000000.000100",
      replyTs: "1700000001.000200",
    });
  });

  it("returns null for malformed encoded Slack reply paths", () => {
    expect(
      parseSlackReplyMessagePath(
        "/slack/channels/C123/messages/1700000000.000100/replies/%zz.json",
      ),
    ).toBeNull();
  });
});
