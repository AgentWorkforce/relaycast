import { describe, expect, it } from "vitest";
import { isValidLoginInviteToken } from "./login-invite.server";

describe("server login invite validation", () => {
  it("only accepts configured login invite tokens", () => {
    expect(isValidLoginInviteToken("RELAY-2026")).toBe(true);
    expect(isValidLoginInviteToken("relay-2026")).toBe(true);
    expect(isValidLoginInviteToken("RELAY-2025")).toBe(false);
  });
});
