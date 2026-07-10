import { describe, expect, it } from "vitest";
import {
  normalizeLoginInviteToken,
  readLoginInviteTokenParam,
} from "./login-invite";

describe("login invite tokens", () => {
  it("normalizes tokens case-insensitively", () => {
    expect(normalizeLoginInviteToken(" relay-2026 ")).toBe("RELAY-2026");
    expect(normalizeLoginInviteToken("")).toBeNull();
    expect(normalizeLoginInviteToken(null)).toBeNull();
  });

  it("reads supported URL parameter names", () => {
    expect(readLoginInviteTokenParam(new URLSearchParams("invite_token=relay-2026"))).toBe(
      "RELAY-2026",
    );
    expect(readLoginInviteTokenParam(new URLSearchParams("inviteToken=relay-2026"))).toBe(
      "RELAY-2026",
    );
    expect(readLoginInviteTokenParam(new URLSearchParams("invite=relay-2026"))).toBe("RELAY-2026");
  });
});
