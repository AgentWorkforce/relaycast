/**
 * Single Cloud-side consumer of `@agentworkforce/persona-kit`'s deep
 * persona-spec validation.
 *
 * Every other spec path in Cloud already routes through
 * `@cloud/core/proactive-runtime/*` (`team-spec.ts`, `agent-spec.ts`,
 * `runtime-package.ts`). Persona validation used to reach AROUND core
 * straight into persona-kit from `packages/web` via a dynamic
 * `await import("@agentworkforce/persona-kit")`. That forced `web` to
 * carry its own `@agentworkforce/persona-kit` dependency, which drifted
 * behind `core`'s (`^3.0.42` vs `^4.0.1`) and rejected the grok harness
 * server-side because web's older persona-kit predated grok in
 * `HARNESS_VALUES` (cloud#2191).
 *
 * Routing persona validation through this module makes `core` the SOLE
 * persona-kit consumer, so `web` can never drift behind `core` again —
 * this drift class becomes structurally impossible (cloud#2192).
 *
 * HTTP-error shaping (mapping validation failures to 400s with detail
 * paths) stays in the web caller; only the persona-kit touch lives here.
 *
 * Imports persona-kit's `./spec` entrypoint — a side-effect-free subset
 * that re-exports only the parsers/type-guards/constants from
 * `parse.ts`/`constants.ts`/`types.ts` (zero external imports). Unlike the
 * package barrel, it does NOT evaluate persona-kit's orchestration modules
 * (`mount`, `execute`, `skills`, `skill-runner`, `config-files`), so this
 * validation path pulls in no `node:child_process`/`fs` and no deferred
 * `@relayfile/local-mount` → `@parcel/watcher` native edge.
 */
import {
  isIntent as personaKitIsIntent,
  parseAgentSpec as personaKitParseAgentSpec,
  parsePersonaSpec as personaKitParsePersonaSpec,
  HARNESS_VALUES,
  type PersonaIntent,
} from "@agentworkforce/persona-kit/spec";

export type { PersonaIntent };

/**
 * The set of harness identifiers persona-kit accepts (e.g. `claude`,
 * `codex`, `grok`). Re-exported so Cloud reads the harness allowlist from
 * the single pinned persona-kit version rather than hard-coding it.
 */
export { HARNESS_VALUES };

/** Narrow an arbitrary value to a persona-kit-recognized intent. */
export function isPersonaIntent(value: unknown): value is PersonaIntent {
  return personaKitIsIntent(value);
}

/**
 * Validate a persona spec against persona-kit's schema for the expected
 * intent. Throws persona-kit's validation error (shaped into an HTTP 400
 * by the web caller). Returns the parsed spec as an opaque record; the
 * caller applies its own typing/normalization on top.
 */
export function parsePersonaSpec(value: unknown, expectedIntent: PersonaIntent): unknown {
  return personaKitParsePersonaSpec(value, expectedIntent);
}

/**
 * Validate a deployment agent spec against persona-kit's schema. Throws
 * persona-kit's validation error on a malformed spec.
 */
export function parseAgentSpec(value: unknown, context = "agent"): unknown {
  return personaKitParseAgentSpec(value, context);
}
