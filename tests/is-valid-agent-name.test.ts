import { describe, expect, it } from "vitest";
import { isValidAgentName } from "../packages/web/lib/relay-workspaces.ts";

describe("isValidAgentName", () => {
  it("accepts well-formed agent names", () => {
    expect(isValidAgentName("relayfile-cli")).toBe(true);
    expect(isValidAgentName("alice")).toBe(true);
    expect(isValidAgentName("agent_42")).toBe(true);
    expect(isValidAgentName("My.Bot-1")).toBe(true);
  });

  it("rejects malformed names per AGENT_NAME_PATTERN", () => {
    expect(isValidAgentName("")).toBe(false);
    expect(isValidAgentName("-leading-dash")).toBe(false);
    expect(isValidAgentName("with space")).toBe(false);
    expect(isValidAgentName("emoji-🤖")).toBe(false);
    // 129 chars (max is 128: 1 leading + 127 trailing)
    expect(isValidAgentName("a".repeat(129))).toBe(false);
  });

  // Codex P2 on PR #474: token-claim-based gates in
  // packages/relayfile/src/middleware/auth.ts (e.g. `isProviderSyncWriter`)
  // assume that an external caller cannot mint a token whose `agentName`
  // matches a cloud-internal worker. We enforce that here, at the public
  // /join and /provision routes, by reserving those names.
  it("rejects names reserved for internal trust-bearing minters", () => {
    expect(isValidAgentName("github-clone-worker")).toBe(false);
    expect(isValidAgentName("nango-sync-worker")).toBe(false);
  });

  it("trims whitespace before matching reserved names", () => {
    // Defense-in-depth: an attacker can't bypass the reservation by
    // padding the name. Pattern test would fail anyway on a leading
    // space — this just makes the layered-trim contract explicit.
    expect(isValidAgentName("  github-clone-worker  ")).toBe(false);
    expect(isValidAgentName("  nango-sync-worker  ")).toBe(false);
  });
});
