import { describe, expect, it } from "vitest";

import { normalizeSlackChannelId } from "./slack-channel-id";

describe("normalizeSlackChannelId", () => {
  it("keeps bare Slack ids unchanged", () => {
    expect(normalizeSlackChannelId("C0B8ZL2L9GC")).toBe("C0B8ZL2L9GC");
    expect(normalizeSlackChannelId("D0B2MHP6E3T")).toBe("D0B2MHP6E3T");
  });

  it("strips Relayfile id-slug suffixes from Slack channel segments", () => {
    expect(normalizeSlackChannelId("C0B8ZL2L9GC__pear-pty-investigation")).toBe("C0B8ZL2L9GC");
    expect(normalizeSlackChannelId("D0B2MHP6E3T__direct-message")).toBe("D0B2MHP6E3T");
  });

  it("does not rewrite arbitrary non-Slack-looking values", () => {
    expect(normalizeSlackChannelId("proj-cloud__C0B8ZL2L9GC")).toBe("proj-cloud__C0B8ZL2L9GC");
    expect(normalizeSlackChannelId("DONE__triage")).toBe("DONE__triage");
    expect(normalizeSlackChannelId("general")).toBe("general");
  });

  it("tolerates non-string runtime values", () => {
    expect(normalizeSlackChannelId(null)).toBe("");
    expect(normalizeSlackChannelId({ channel: "C0B8ZL2L9GC" })).toBe("");
  });
});
