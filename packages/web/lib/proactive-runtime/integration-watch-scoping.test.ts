import { describe, it, expect } from "vitest";
import { agentMatchesEvent } from "@cloud/core/proactive-runtime/match.js";

/**
 * Channel-scoped Slack agents must wake ONLY for their channel.
 *
 * Regression guard for the dispatcher (integration-watch-dispatcher.ts,
 * `matchEventPaths`): it must feed `agentMatchesEvent` the EXPLICIT event path,
 * not the broadened set from `relayfileProviderEventPaths`. The broadened set
 * mixes in the provider's generic resource glob (slack channels messages), and a
 * channel-scoped watch path shares the "/slack/channels/" prefix with it — so
 * `pathCouldIntersect` returns true and EVERY channel-scoped slack agent woke for
 * EVERY channel.
 */
describe("channel-scoped slack agent wake gating", () => {
  const scopedRow = (channel: string) =>
    ({
      spec: { integrations: { slack: {} } },
      watch_globs: ["/slack/channels/" + channel + "/messages/**"],
      watch_rules: [
        { paths: ["/slack/channels/" + channel + "/messages/**"], events: ["message.created"] },
      ],
    }) as never;

  const match = (row: never, path: string) =>
    agentMatchesEvent(
      { row, provider: "slack", eventType: "message.created", eventPaths: [path] },
      { requireTriggerSpec: false },
    );

  it("wakes for its OWN channel's message (explicit path)", () => {
    expect(match(scopedRow("C0AD7UU0J1G"), "/slack/channels/C0AD7UU0J1G/messages/1/meta.json")).toBe(true);
  });

  it("does NOT wake for a DIFFERENT channel's message (explicit path)", () => {
    expect(match(scopedRow("C0AD7UU0J1G"), "/slack/channels/C0B9287EP6Y/messages/1/meta.json")).toBe(false);
  });

  it("over-matches the generic resource glob — why the dispatcher must NOT feed it", () => {
    expect(match(scopedRow("C0AD7UU0J1G"), "/slack/channels/**/messages/**")).toBe(true);
  });
});
