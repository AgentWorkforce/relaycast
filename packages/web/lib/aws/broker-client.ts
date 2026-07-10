/**
 * Worker-side client for the Lambda STS broker.
 *
 * The Cloudflare Worker has no IAM identity, so it cannot call STS directly.
 * This module signs requests to the broker Lambda with HMAC-SHA256 (Web
 * Crypto), caches credentials in-memory until shortly before expiry, and
 * returns scoped temporary S3 credentials for a given (userId, runId).
 *
 * Symmetry with the Lambda side: the canonical signing string lives in
 * `@cloud/sts-broker`'s `hmac.ts`. Both halves MUST produce identical bytes
 * for a given (method, path, body, timestamp) tuple, so we import the
 * helpers rather than reimplementing them here.
 *
 * Cache lifetime: STS credentials default to 900s. We refresh 60s before
 * expiry so a long-running route handler doesn't stall mid-flight when the
 * cached creds tick over the boundary. Cache key includes both userId and
 * runId because each (user, run) combination gets its own scoped prefix.
 */

import {
  buildSigningString,
  REQUEST_SIGNATURE_HEADER,
  REQUEST_TIMESTAMP_HEADER,
} from "@cloud/sts-broker/hmac.js";

export type BrokerCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  bucket: string;
  prefix: string;
  expiresAt: string;
};

type CacheEntry = {
  credentials: BrokerCredentials;
  expiresAtMs: number;
};

type BrokerClientConfig = {
  brokerUrl: string;
  hmacSecret: string;
  fetchImpl?: typeof fetch;
  /** For tests — overrides Date.now() */
  nowMs?: () => number;
  /** For tests — overrides setTimeout-backed sleep */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Refresh credentials this many ms before they actually expire. Without the
 * skew the Worker hands out creds that are technically valid but expire in
 * the middle of an in-flight S3 multipart upload.
 */
const REFRESH_SKEW_MS = 60_000;

/**
 * Exponential backoff schedule for transient broker failures. Lambda Function
 * URLs return 429 when account concurrency is exhausted, even though the
 * caller is not being rate-limited. Treat those like transient 5xxs and leave
 * enough retry budget to ride out short SQS/Lambda concurrency spikes.
 */
const RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000];

const cache = new Map<string, CacheEntry>();

/** Reset for tests so each test starts with a cold cache. */
export function clearBrokerCacheForTesting(): void {
  cache.clear();
}

/** Snapshot the cache for tests to assert hit/miss behaviour. */
export function inspectBrokerCacheForTesting(): Map<string, CacheEntry> {
  return new Map(cache);
}

function cacheKey(scope: BrokerScope, userId: string, runId?: string): string {
  return `${scope}::${userId}::${runId ?? ""}`;
}

async function signRequestBrowser(
  secret: string,
  method: string,
  path: string,
  body: string,
  timestamp: string,
): Promise<string> {
  const signingString = buildSigningString({ method, path, body, timestamp });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signatureBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingString),
  );
  // Base64-encode the raw bytes. The Worker runtime exposes `btoa` and
  // `Uint8Array`; we route the bytes through a Latin-1 string to keep the
  // mapping byte-faithful (atob/btoa expect Latin-1).
  const bytes = new Uint8Array(signatureBytes);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableStatus(status: number): boolean {
  // Match the broker's contract: 4xx is terminal (signature mismatch, bad
  // request), 5xx is transient (STS throttling, Lambda cold-start blip), and
  // Lambda Function URL 429s are transient account-concurrency throttles.
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Broker scopes — see packages/sts-broker/src/handler.ts for the canonical
 * definition. Mirrored here so the Worker side compiles without a runtime
 * dependency on the broker package's handler module.
 */
export type BrokerScope = "workflow-run" | "credential-store";

export type GetStsCredentialsInput = {
  scope?: BrokerScope;
  userId: string;
  /** Required when scope is "workflow-run". */
  runId?: string;
  durationSeconds?: number;
};

/**
 * Fetch scoped S3 credentials from the broker, with in-memory caching and
 * exponential backoff on transient failures.
 *
 * Throws on:
 *   - 4xx response (terminal — caller should propagate to the client as 403)
 *   - 5xx after `RETRY_DELAYS_MS.length` retries (caller should return 503)
 *   - Network failure after retries (same)
 *   - Missing config (broker URL or HMAC secret)
 */
export async function getStsCredentials(
  input: GetStsCredentialsInput,
  config: BrokerClientConfig,
): Promise<BrokerCredentials> {
  const scope: BrokerScope = input.scope ?? "workflow-run";
  if (scope === "workflow-run" && !input.runId) {
    throw new Error("[broker-client] runId is required for workflow-run scope");
  }
  const now = (config.nowMs ?? Date.now)();
  const key = cacheKey(scope, input.userId, input.runId);
  const cached = cache.get(key);
  if (cached && cached.expiresAtMs - REFRESH_SKEW_MS > now) {
    return cached.credentials;
  }

  if (!config.brokerUrl) {
    throw new Error("[broker-client] BROKER_URL is not configured");
  }
  if (!config.hmacSecret) {
    throw new Error("[broker-client] BROKER_HMAC_SECRET is not configured");
  }

  const fetchImpl = config.fetchImpl ?? fetch;
  const sleep = config.sleep ?? defaultSleep;
  const path = "/broker/sts/assume-role";
  const body = JSON.stringify({
    scope,
    userId: input.userId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.durationSeconds ? { durationSeconds: input.durationSeconds } : {}),
  });

  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    const timestamp = String(Math.floor(((config.nowMs ?? Date.now)()) / 1000));
    const signature = await signRequestBrowser(
      config.hmacSecret,
      "POST",
      path,
      body,
      timestamp,
    );
    const url = `${stripTrailingSlash(config.brokerUrl)}${path}`;

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [REQUEST_SIGNATURE_HEADER]: signature,
          [REQUEST_TIMESTAMP_HEADER]: timestamp,
        },
        body,
      });
    } catch (err) {
      lastError = err;
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw new Error(
        `[broker-client] network error reaching broker after ${attempt + 1} attempts: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    if (response.ok) {
      const credentials = (await response.json()) as BrokerCredentials;
      cache.set(key, {
        credentials,
        expiresAtMs: Date.parse(credentials.expiresAt),
      });
      return credentials;
    }

    if (!isRetriableStatus(response.status)) {
      // Drain body for the error message but keep the original status in
      // the throw so callers can map to the right HTTP response.
      const text = await response.text().catch(() => "");
      throw new BrokerClientError(
        `[broker-client] broker rejected request: ${response.status} ${text}`,
        response.status,
      );
    }

    lastError = new BrokerClientError(
      `[broker-client] broker returned ${response.status}`,
      response.status,
    );
    if (attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`[broker-client] broker call failed: ${String(lastError)}`);
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export class BrokerClientError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "BrokerClientError";
  }
}
