import { describe, expect, it } from "vitest";
import { emailDomain, isInternalEmail, normalizeEmail } from "./access";

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Will@AgentRelay.com ")).toBe("will@agentrelay.com");
  });

  it("returns null for empty/nullish", () => {
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail("   ")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
  });
});

describe("emailDomain", () => {
  it("extracts the domain", () => {
    expect(emailDomain("a@agentrelay.com")).toBe("agentrelay.com");
  });

  it("uses the last @ for odd addresses", () => {
    expect(emailDomain("weird@thing@agentrelay.com")).toBe("agentrelay.com");
  });

  it("returns null when there is no usable domain", () => {
    expect(emailDomain("noatsign")).toBeNull();
    expect(emailDomain("trailingat@")).toBeNull();
    expect(emailDomain(null)).toBeNull();
  });
});

describe("isInternalEmail", () => {
  it("allows the internal tester domain (case/space-insensitive)", () => {
    expect(isInternalEmail("will@agentrelay.com")).toBe(true);
    expect(isInternalEmail("  Will@AgentRelay.com ")).toBe(true);
  });

  it("rejects look-alike and unrelated domains", () => {
    // hyphenated variant is intentionally NOT the allowed domain
    expect(isInternalEmail("will@agent-relay.com")).toBe(false);
    expect(isInternalEmail("will@tailwindapp.com")).toBe(false);
    expect(isInternalEmail("attacker@notagentrelay.com")).toBe(false);
    expect(isInternalEmail("attacker@agentrelay.com.evil.com")).toBe(false);
  });

  it("rejects missing/garbage emails", () => {
    expect(isInternalEmail(null)).toBe(false);
    expect(isInternalEmail(undefined)).toBe(false);
    expect(isInternalEmail("not-an-email")).toBe(false);
  });
});
