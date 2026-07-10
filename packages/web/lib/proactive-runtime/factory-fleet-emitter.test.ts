import { describe, expect, it } from "vitest";
import { CLIs } from "@agent-relay/config";
import {
  capabilityToCli,
  DEFAULT_SPAWN_CAPABILITY,
  FACTORY_SPAWN_CAPABILITIES,
  isSpawnableCli,
  SPAWNABLE_CLIS,
  spawnCapabilityForCli,
  type FactorySpawnCapability,
} from "@/lib/proactive-runtime/factory-fleet-emitter";

describe("factory fleet emitter capabilities", () => {
  it("derives the Cloud-supported spawnable harness set from @agent-relay/config", () => {
    expect(SPAWNABLE_CLIS).toEqual([
      CLIs.CLAUDE,
      CLIs.CODEX,
      CLIs.GEMINI,
      CLIs.CURSOR,
      CLIs.DROID,
      CLIs.OPENCODE,
      CLIs.GROK,
      CLIs.AIDER,
    ]);
    // Sanity: the canonical supported harnesses are all present.
    for (const cli of ["claude", "codex", "gemini", "cursor", "opencode", "grok", "aider", "droid"]) {
      expect(SPAWNABLE_CLIS).toContain(cli);
    }
  });

  it("exposes spawn:<cli> for every harness plus workflow:run", () => {
    for (const cli of SPAWNABLE_CLIS) {
      expect(FACTORY_SPAWN_CAPABILITIES).toContain(`spawn:${cli}`);
    }
    expect(FACTORY_SPAWN_CAPABILITIES).toContain("workflow:run");
    expect(FACTORY_SPAWN_CAPABILITIES.length).toBe(SPAWNABLE_CLIS.length + 1);
  });

  it("maps every spawn:<cli> capability generically to its cli", () => {
    for (const cli of SPAWNABLE_CLIS) {
      expect(capabilityToCli(`spawn:${cli}`)).toBe(cli);
    }
  });

  it("treats workflow:run specially (no cli)", () => {
    expect(capabilityToCli("workflow:run")).toBeNull();
  });

  it("returns null for an unknown harness capability", () => {
    expect(capabilityToCli("spawn:nonexistent" as FactorySpawnCapability)).toBeNull();
    expect(capabilityToCli("garbage" as FactorySpawnCapability)).toBeNull();
  });

  it("does not crash on non-string capability values at runtime", () => {
    // Defensive boundary: persisted/untyped metadata could yield a non-string.
    for (const bad of [undefined, null, 42, {}, []]) {
      expect(capabilityToCli(bad as unknown as FactorySpawnCapability)).toBeNull();
    }
  });

  it("validates harness names against the registry", () => {
    expect(isSpawnableCli("opencode")).toBe(true);
    expect(isSpawnableCli("grok")).toBe(true);
    expect(isSpawnableCli("nope")).toBe(false);
  });

  it("builds capabilities from a cli name, defaulting to claude for unknown/absent", () => {
    expect(spawnCapabilityForCli("grok")).toBe("spawn:grok");
    expect(spawnCapabilityForCli("opencode")).toBe("spawn:opencode");
    expect(spawnCapabilityForCli("unknown")).toBe(DEFAULT_SPAWN_CAPABILITY);
    expect(spawnCapabilityForCli(undefined)).toBe(DEFAULT_SPAWN_CAPABILITY);
    expect(DEFAULT_SPAWN_CAPABILITY).toBe("spawn:claude");
  });
});
