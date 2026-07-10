import { Resource } from "sst";

/**
 * Process-env readers for non-secret configuration (URLs, regions,
 * feature flags, local-dev overrides). They are intentionally NOT
 * Resource-aware: deployed lambdas should read SST-managed secrets via
 * `Resource.<Name>.value` directly so the type-time check guarantees the
 * binding exists in `infra/web.ts`. See `lib/daytona-auth.ts` for the
 * canonical Resource-first-with-env-fallback pattern.
 *
 * If you reach for `optionalEnv("DAYTONA_API_KEY")` in a deployed code
 * path, prefer `tryResourceValue("DaytonaApiKey")` (or
 * `Resource.DaytonaApiKey.value` directly) so missing infra bindings
 * surface at the call site instead of silently falling through to
 * `undefined`.
 */
export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

/**
 * Read a string value off an SST `Resource.<name>.value` binding without
 * the literal-type indexing requirement. Returns `undefined` when the
 * binding is missing, the value is empty, or the resource SDK throws
 * (e.g. local dev where SST isn't injected).
 *
 * Use the typed accessor — `Resource.DaytonaApiKey.value` — when you can.
 * This helper is for the small set of call sites that need a string name
 * (boot checks, generic config plumbing, env→secret bridges).
 */
export function tryResourceValue(name: string): string | undefined {
  // Resource is a build-time-typed proxy; cast it for runtime string
  // indexing. This mirrors `lib/boot/resource-check.ts:65-90`.
  const proxy = Resource as unknown as Record<string, unknown>;
  let bound: unknown;
  try {
    bound = proxy[name];
  } catch {
    return undefined;
  }
  if (bound === undefined || bound === null) {
    return undefined;
  }
  const value = (bound as { value?: unknown }).value;
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  return value.trim();
}
