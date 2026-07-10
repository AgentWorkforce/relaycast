import { resolveDaytonaAuthCredentials } from "@cloud/core/auth/credentials.js";
import { optionalEnv } from "@/lib/env";
import { Resource } from "sst";

/**
 * Read a secret from SST `Resource.<Name>.value` when available, otherwise
 * fall back to the equivalent env var. `Resource` can throw when SST links
 * are unavailable in local dev / unit tests; the catch keeps both modes
 * working.
 */
function readDaytonaResource(name: string, envFallback: string): string | undefined {
  try {
    const value = (Resource as unknown as Record<string, { value?: string } | undefined>)[name]?.value;
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  } catch {
    // SST Resource not available in this runtime (local dev / unit
    // tests); fall through to the env fallback.
  }
  return optionalEnv(envFallback);
}

export function resolveServerDaytonaAuthParams(): {
  daytonaApiKey?: string;
  daytonaJwtToken?: string;
  daytonaOrganizationId?: string;
} {
  // All three secrets must use the SST Resource path, not optionalEnv —
  // process.env is empty in deployed workers, so any secret read through
  // env-only would silently downgrade to undefined and produce 500s.
  const resolved = resolveDaytonaAuthCredentials({
    apiKey: readDaytonaResource("DaytonaApiKey", "DAYTONA_API_KEY"),
    jwtToken: readDaytonaResource("DaytonaJwtToken", "DAYTONA_JWT_TOKEN"),
    organizationId: readDaytonaResource(
      "DaytonaOrganizationId",
      "DAYTONA_ORGANIZATION_ID",
    ),
  });

  if ("apiKey" in resolved) {
    return { daytonaApiKey: resolved.apiKey };
  }

  return {
    daytonaJwtToken: resolved.jwtToken,
    daytonaOrganizationId: resolved.organizationId,
  };
}
