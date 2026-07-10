// Client-safe mirror of Cloud-supported agent-relay CLIs. The config package
// barrel re-exports server-only modules (e.g.
// `bridge-utils`) that break Turbopack client-bundle codegen, so the dashboard
// (a client component) cannot import it directly. This literal list is kept in
// lockstep with the server-side Cloud-supported set by a sync-guard test
// (`spawnable-clis.test.ts`).
// Server code should prefer `SPAWNABLE_CLIS` from `factory-fleet-emitter`,
// which is derived from the registry at runtime.
export const FLEET_SPAWNABLE_CLIS: readonly string[] = [
  "claude",
  "codex",
  "gemini",
  "cursor",
  "droid",
  "opencode",
  "grok",
  "aider",
];

// Relaycast dispatch selects candidate nodes by *exact* capability name (the
// invoked action). The factory emitter invokes the bare `spawn` action for any
// `spawn:<cli>` harness, so a node enrolled with only `spawn:<cli>` capabilities
// would be filtered out by `nodeHasCapability(node, "spawn")` and never receive
// factory spawns. Always advertise the bare `spawn` capability alongside the
// per-harness entries so enrolled nodes stay dispatch-eligible (the
// `spawn:<cli>` entries still record which harnesses the node may run).
// See PR #2234 review (codex P1).
export function withDispatchCapabilities(selected: readonly string[]): string[] {
  const out = new Set(selected);
  if (selected.some((capability) => capability.startsWith("spawn:"))) {
    out.add("spawn");
  }
  return [...out];
}
