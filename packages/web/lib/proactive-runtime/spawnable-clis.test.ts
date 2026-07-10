import { describe, expect, it } from "vitest";
import { CLIs } from "@agent-relay/config";
import {
  FLEET_SPAWNABLE_CLIS,
  withDispatchCapabilities,
} from "@/lib/proactive-runtime/spawnable-clis";

describe("client-safe spawnable CLI mirror", () => {
  it("stays in lockstep with the server-side Cloud-supported CLI set", () => {
    // If this fails, Cloud's supported harness list changed and the client-safe
    // mirror must be updated to match. The dashboard cannot import the config
    // barrel because it pulls server-only modules into the client bundle.
    expect(FLEET_SPAWNABLE_CLIS).toEqual([
      CLIs.CLAUDE,
      CLIs.CODEX,
      CLIs.GEMINI,
      CLIs.CURSOR,
      CLIs.DROID,
      CLIs.OPENCODE,
      CLIs.GROK,
      CLIs.AIDER,
    ]);
  });
});

describe("withDispatchCapabilities", () => {
  it("adds the bare `spawn` capability when any spawn:<cli> is selected", () => {
    // Without this, a node enrolled with only spawn:claude/spawn:codex would not
    // match nodeHasCapability(node, "spawn") and never receive factory spawns.
    expect(withDispatchCapabilities(["spawn:claude", "spawn:codex"])).toEqual(
      expect.arrayContaining(["spawn:claude", "spawn:codex", "spawn"]),
    );
    expect(withDispatchCapabilities(["spawn:grok"])).toContain("spawn");
  });

  it("does not add `spawn` when no spawn:<cli> is selected", () => {
    expect(withDispatchCapabilities(["workflow:run"])).toEqual(["workflow:run"]);
    expect(withDispatchCapabilities([])).toEqual([]);
  });

  it("does not duplicate an already-present bare `spawn`", () => {
    const result = withDispatchCapabilities(["spawn", "spawn:claude"]);
    expect(result.filter((c) => c === "spawn")).toHaveLength(1);
  });

  it("de-duplicates repeated capabilities", () => {
    expect(withDispatchCapabilities(["spawn:claude", "spawn:claude"])).toEqual([
      "spawn:claude",
      "spawn",
    ]);
  });
});
