import type { Context } from "hono";

export interface Bindings {
  // D1
  DB: D1Database;

  // R2
  CONTENT_BUCKET: R2Bucket;

  // Queues
  ENVELOPE_QUEUE: Queue;
  WRITEBACK_QUEUE: Queue;
  WEBHOOK_QUEUE?: Queue;
  GITHUB_TAR_IMPORT_QUEUE?: Queue;
  AUDIT_QUEUE?: Queue;

  // Durable Objects
  WORKSPACE_DO: DurableObjectNamespace;

  // KV
  KV: KVNamespace;
  DEDUP_KV?: KVNamespace;
  // Shared rate-limit counter namespace, bound to both the cloud
  // router and this api worker so a workspace's per-minute counter
  // isn't accidentally doubled by hitting both gateways. See
  // packages/router/src/rate-limit.ts and infra/rate-limit.ts.
  RATE_LIMIT_COUNTERS?: KVNamespace;
  // ROUTER_CONFIG KV namespace (read-only here): both Workers share
  // the same set of rate-limit config keys so operators only have to
  // tune them in one place.
  ROUTER_CONFIG?: KVNamespace;

  // Vars
  ENVIRONMENT: string;
  RELAYFILE_WRITEBACK_BRIDGE_URL?: string;
  RELAYFILE_AUDIT_URL?: string;
  RELAYFILE_DIGEST_TIMEZONE?: string;
  RELAYFILE_DIGEST_VERB_OVERRIDE_BUDGET_BYTES?: string;
  NANGO_BASE_URL?: string;
  RELAYFILE_DO_MAX_INFLIGHT_REQUESTS?: string;
  RELAYFILE_DO_MAX_INFLIGHT_AGE_MS?: string;
  RELAYFILE_DO_RETRY_AFTER_SECONDS?: string;
  RELAYFILE_MAX_WRITE_BYTES?: string;
  RELAYFILE_ROUTER_MAX_INFLIGHT_REQUESTS?: string;
  RELAYFILE_ROUTER_RETRY_AFTER_SECONDS?: string;
  RELAYFILE_SHARDED_WORKSPACE?: string;
  RELAYFILE_LOG_SHARD_ROUTING?: string;
  RELAYFILE_GITHUB_BASE_SNAPSHOT_WORKSPACES?: string;
  RELAYFILE_GITHUB_BASE_IMPORT_CHUNK_ENTRIES?: string;
  RELAYFILE_GITHUB_BASE_IMPORT_BLOB_PUT_CONCURRENCY?: string;
  RELAYFILE_WRITE_ADMISSION_MAX_INFLIGHT?: string;
  RELAYFILE_WRITE_ADMISSION_FOREGROUND_RESERVED?: string;
  RELAYFILE_WRITE_ADMISSION_BACKGROUND_MAX?: string;
  RELAYFILE_WRITE_ADMISSION_LEASE_TTL_MS?: string;
  RELAYFILE_SLACK_WRITEBACK_IDEMPOTENCY_TTL_SECONDS?: string;
  RELAYFILE_WEBHOOK_HOST_ALLOWLIST?: string;
  // Per-blob R2 read timeout for tar/JSON export streaming. Bounds the max
  // no-byte gap when a single R2 read hangs (transient hiccup), so the
  // ordered tar yield can't wedge indefinitely. Default 8000 ms.
  RELAYFILE_EXPORT_BLOB_READ_TIMEOUT_MS?: string;
  // Number of attempts for a single blob read before failing the stream
  // loudly. Default 3.
  RELAYFILE_EXPORT_BLOB_READ_ATTEMPTS?: string;

  // RelayAuth JWKS URL for RS256 verification. Defaults to the production
  // endpoint when unset; overridable so preview/staging can point at their
  // own relayauth deployment.
  RELAYAUTH_JWKS_URL?: string;

  // Expected `iss` claim on RS256 tokens. Without this pinned, any token
  // that verifies against the JWKS and claims `aud: "relayfile"` would be
  // accepted regardless of issuer — cross-issuer drift risk in staging /
  // preview where multiple relayauth deployments might share a JWKS.
  // Defaults to the production relayauth issuer.
  RELAYAUTH_ISSUER?: string;

  // Secrets
  INTERNAL_HMAC_SECRET: string;
  NANGO_SECRET_KEY?: string;
}

export interface Variables {
  requestId: string;
  workspaceId?: string;
  correlationId?: string;
  authClaims?: {
    workspaceId: string;
    agentName: string;
    scopes: string[];
    exp: number;
  };
}

export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
};

export type AppContext = Context<AppEnv>;

export interface RelayfileWritebackBridgeConfig {
  bridgeUrl: string;
  internalHmacSecret: string;
}

export function resolveRelayfileWritebackBridgeConfig(
  env: Pick<
    Bindings,
    "INTERNAL_HMAC_SECRET" | "RELAYFILE_WRITEBACK_BRIDGE_URL"
  >,
  overrides?: {
    bridgeUrl?: string;
  },
): RelayfileWritebackBridgeConfig {
  const bridgeUrl = requireAbsoluteUrl(
    firstNonEmptyValue(
      overrides?.bridgeUrl,
      env.RELAYFILE_WRITEBACK_BRIDGE_URL,
      getProcessEnv("RELAYFILE_WRITEBACK_BRIDGE_URL"),
    ),
    "RELAYFILE_WRITEBACK_BRIDGE_URL",
  );
  const internalHmacSecret = requireNonEmptyString(
    env.INTERNAL_HMAC_SECRET,
    "INTERNAL_HMAC_SECRET",
  );

  return {
    bridgeUrl,
    internalHmacSecret,
  };
}

function firstNonEmptyValue(
  ...values: Array<string | undefined>
): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function getProcessEnv(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env[name] : undefined;
}

function requireNonEmptyString(
  value: string | undefined,
  name: string,
): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return trimmed;
}

function requireAbsoluteUrl(value: string | undefined, name: string): string {
  const trimmed = requireNonEmptyString(value, name);
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid URL env var: ${name}`);
  }

  if (!parsed.protocol || !parsed.host) {
    throw new Error(`Invalid URL env var: ${name}`);
  }

  return parsed.toString();
}
