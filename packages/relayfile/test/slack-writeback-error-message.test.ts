import { describe, expect, it } from "vitest";

import { actionableSlackWritebackError } from "../src/writeback/providers/slack.js";

describe("actionableSlackWritebackError", () => {
  it("turns not_in_channel into an actionable, channel-scoped message", () => {
    const message = actionableSlackWritebackError("not_in_channel", "C0B873KEDK9");
    expect(message).toMatch(/not a member of the channel \(channel C0B873KEDK9\)/);
    expect(message).toMatch(/\/invite/);
  });

  it("still produces an actionable message when the channel is unknown", () => {
    const message = actionableSlackWritebackError("not_in_channel", undefined);
    expect(message).toMatch(/not a member of the channel\./);
    expect(message).not.toMatch(/\(channel/);
  });

  it("maps missing_scope to a reconnect instruction (chat:write)", () => {
    expect(actionableSlackWritebackError("missing_scope", "C123")).toMatch(
      /chat:write/,
    );
  });

  it("maps auth-class errors to a reconnect instruction", () => {
    for (const code of [
      "not_authed",
      "invalid_auth",
      "account_inactive",
      "token_revoked",
    ]) {
      expect(actionableSlackWritebackError(code, "C123")).toMatch(
        /Reconnect the Slack integration/,
      );
    }
  });

  it("returns undefined for unknown codes so callers fall back to the raw code", () => {
    expect(actionableSlackWritebackError("ratelimited", "C123")).toBeUndefined();
    expect(actionableSlackWritebackError("some_new_error", undefined)).toBeUndefined();
  });
});
