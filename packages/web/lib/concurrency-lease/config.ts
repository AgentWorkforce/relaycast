/**
 * Concurrency-lease config knobs (issue #1384).
 *
 * INTERIM values until the cloud-team firing diagnostic publishes the real cap
 * surface (global vs per-agent vs Daytona-sandbox-count). The cap is a config
 * knob on purpose: when the diagnostic lands, the value swaps in with NO code
 * change. The lease primitive itself never bakes a cap — callers pass it.
 */

/** Interim single global pool; scope becomes pluggable once the surface lands. */
export const DEFAULT_CLOUD_AGENT_WARM_LEASE_POOL_ID = "cloud-agent-warm:global";

/**
 * Conservative interim cap: our sequential ~50-run probe peaks at ~3-4 live
 * sandboxes, so 4 is safe under any plausible account cap while the real
 * surface is resolved. Aggressive idle-stop remains the actual backstop.
 */
export const DEFAULT_CLOUD_AGENT_WARM_LEASE_CAP = 4;

type LeaseConfigEnv = {
  CLOUD_AGENT_WARM_LEASE_CAP?: string;
  CLOUD_AGENT_WARM_LEASE_POOL_ID?: string;
};

function readEnv(env?: LeaseConfigEnv): LeaseConfigEnv {
  if (env) {
    return env;
  }
  // Fallback for Node/Lambda local dev; deployed Workers should pass their
  // binding `env` explicitly.
  return typeof process !== "undefined"
    ? (process.env as LeaseConfigEnv)
    : {};
}

export function getCloudAgentWarmLeaseCap(env?: LeaseConfigEnv): number {
  const raw = readEnv(env).CLOUD_AGENT_WARM_LEASE_CAP;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_CLOUD_AGENT_WARM_LEASE_CAP;
}

export function getCloudAgentWarmLeasePoolId(env?: LeaseConfigEnv): string {
  const raw = readEnv(env).CLOUD_AGENT_WARM_LEASE_POOL_ID?.trim();
  return raw && raw.length > 0
    ? raw
    : DEFAULT_CLOUD_AGENT_WARM_LEASE_POOL_ID;
}
