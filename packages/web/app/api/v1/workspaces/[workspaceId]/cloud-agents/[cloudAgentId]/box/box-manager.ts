import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { Client as NeonClient } from "@neondatabase/serverless";
import {
  getNeonDatabaseUrl,
  isLocalConnectionString,
  toDirectNeonConnectionString,
} from "@cloud/core/db/connection.js";
import { Resource } from "sst";
import { CredentialStore } from "@cloud/core/auth/credential-store.js";
import {
  mountCliCredentials,
  resolveCredentialProviderFromCli,
} from "@cloud/core/auth/cli-credentials.js";
import { deriveBrokerApiKey } from "@cloud/core/auth/broker-key.js";
import { getLiteSnapshotName, getSnapshotName } from "@cloud/core/config/snapshot.js";
import { SandboxOrchestrator } from "@cloud/core/executor/sandbox-orchestrator.js";
import {
  type MintPathScopedRelayfileTokenOptions,
  mintPathScopedRelayfileToken,
} from "@cloud/core/relayfile/client.js";
import {
  type RelayfileMountDaemonOptions,
  type RelayfileMountShellOptions,
} from "@cloud/core/relayfile/mount-script.js";
import {
  evictRelayAuthWorkspaceTokenCache,
  isRelayAuthPathTokenUnauthorizedError,
  mintRelayAuthWorkspaceToken,
} from "@/lib/relay-workspaces";
import { getBrokerKeySecret } from "@/lib/auth/secrets";
import { getDb } from "@/lib/db";
import { providerCredentials, sandboxes } from "@/lib/db/schema";
import { daytonaCommandOutput } from "@/lib/daytona-command-output";
import { optionalEnv, tryResourceValue } from "@/lib/env";
import { resolveGitCloneCredentials } from "@/lib/integrations/github-clone-token";
import {
  buildGitWorkspaceSyncShell,
  normalizeHttpsGitRemote,
} from "@/lib/integrations/git-workspace-sync-script";
import { logger } from "@/lib/logger";
import { resolveRelayAuthConfig, resolveRelayfileConfig } from "@/lib/relayfile";
import { createCredentialStoreS3Client } from "@/lib/storage";
import {
  MAX_CREATE_TIMEOUT_SECONDS,
  createDaytonaClient,
} from "../../../sandboxes/sandbox-utils";

const DEFAULT_MOUNT_PATH = "/workspace";
const DEFAULT_MOUNT_LOCAL_DIR = "/workspace";
const DEFAULT_BOX_TIMEOUT_SECONDS = 60 * 60;
const BROKER_PORT = 9800;
const URL_TTL_SECONDS = 86_400;
const LOCK_RETRY_DELAY_MS = 250;
const LOCK_WAIT_TIMEOUT_MS = 30_000;
const ASYNC_WARM_DEADLINE_MS = 5 * 60_000;
const REAL_SANDBOX_WARM_DEADLINE_MS = 10 * 60_000;
const DEFAULT_KEEPALIVE_TTL_MS = 10 * 60_000;
const CLOUD_AGENT_KEEPALIVE_TTL_MS_ENV = "CLOUD_AGENT_KEEPALIVE_TTL_MS";
const DEFAULT_DAYTONA_EXEC_FAIL_FAST_MS = 45_000;
const CLOUD_AGENT_DAYTONA_EXEC_FAIL_FAST_MS_ENV = "CLOUD_AGENT_DAYTONA_EXEC_FAIL_FAST_MS";
const KEEPALIVE_REAPER_DEFAULT_LIMIT = 25;
const WARMING_SANDBOX_ID_PREFIX = "boxwarm_";
const DIRECT_GIT_DEFAULT_MOUNT_PATH = "/integrations";
const DIRECT_GIT_RELAYFILE_LOCAL_DIR = "/";
const cloudflareContextSymbol = Symbol.for("__cloudflare-context__");

// Daytona enforces unique sandbox names per organization. The sticky cloud-agent
// box used `credential.displayName` directly, which collides when two cloud
// agents share a display name ("Anthropic", "Claude", ...) or when a re-created
// credential keeps the old name — surfacing as
// `Sandbox with name <x> already exists`. Suffixing the name with a short,
// stable slice of the cloudAgentId encodes the box's identity, so different
// cloud agents never collide and the same cloud agent always resolves to the
// same name (which lets us adopt a drifted-but-still-alive box by name).
const SANDBOX_NAME_MAX_LENGTH = 63;
const SANDBOX_NAME_CLOUD_AGENT_SUFFIX_LENGTH = 8;

export function buildStickySandboxName(input: {
  displayName: string;
  cloudAgentId: string;
}): string {
  const suffix = input.cloudAgentId
    .replace(/-/g, "")
    .slice(0, SANDBOX_NAME_CLOUD_AGENT_SUFFIX_LENGTH);
  const reservedForSuffix = suffix.length + 1; // "-" + suffix
  const baseMax = Math.max(1, SANDBOX_NAME_MAX_LENGTH - reservedForSuffix);
  // Daytona uses the name as a DNS-style resource identifier, so collapse any
  // run of non-alphanumeric characters (spaces, punctuation, ...) to a single
  // hyphen and trim stray hyphens. Without this a display name like
  // "My Agent!" would itself make `daytona.create` fail.
  const base = input.displayName
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, baseMax)
    .replace(/-+$/g, "") || "cloud-agent";
  return `${base}-${suffix}`;
}

type Auth = {
  userId: string;
  workspaceId: string;
  organizationId: string;
};

export type ProviderCredentialRow = {
  id: string;
  organizationId: string;
  workspaceId: string;
  userId: string;
  harness: string;
  modelProvider: string;
  authType: string;
  displayName: string;
  defaultModel: string | null;
  status: string;
  credentialExpiresAt: Date | string | null;
  refreshExhausted: boolean;
  lastError: string | null;
};

type SandboxRow = {
  id: string;
  status: string;
  brokerPort: number | null;
  error: string | null;
  expectedReadyBy: Date | string | null;
  keepaliveUntil?: Date | string | null;
};

type KeepaliveSandboxRow = {
  id: string;
  workspaceId: string;
  cloudAgentId: string;
  keepaliveUntil: Date | string;
};

export type DaytonaSandbox = {
  id: string;
  organizationId?: string;
  state?: string;
  toolboxProxyUrl?: string;
  getUserHomeDir?: () => Promise<string | undefined>;
  getSignedPreviewUrl?: (port: number, ttlSeconds: number) => Promise<{ url: string }>;
  start?: (timeout?: number) => Promise<void>;
  stop?: (timeout?: number) => Promise<void>;
  process: {
    executeCommand: (
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeoutSeconds?: number,
    ) => Promise<{ exitCode: number; result?: string; artifacts?: { stdout?: string; stderr?: string } }>;
  };
  fs: {
    uploadFile: (content: Buffer, destination: string) => Promise<void>;
  };
};

export type DaytonaClient = {
  create: (
    params: Record<string, unknown>,
    options?: { timeout?: number },
  ) => Promise<DaytonaSandbox>;
  get: (sandboxId: string) => Promise<DaytonaSandbox>;
  start?: (sandbox: DaytonaSandbox, timeout?: number) => Promise<void>;
  stop?: (sandbox: DaytonaSandbox) => Promise<void>;
  delete?: (sandbox: DaytonaSandbox) => Promise<void>;
};

type ProviderId = Parameters<typeof mountCliCredentials>[3];

type RelayfileMountHandle = {
  pid?: string;
};

type StartRelayfileMountInput = {
  sandbox: DaytonaSandbox;
  sandboxHome: string;
  config: RelayfileMountDaemonOptions;
};

type FlushRelayfileMountInput = {
  sandbox: DaytonaSandbox;
  sandboxHome: string;
  config: RelayfileMountShellOptions;
};

type RelayfileMountRuntimeConfig = {
  baseUrl: string;
  workspaceId: string;
  token: string;
  mountPaths: string[];
  localDir?: string;
};

export type CloudAgentBoxResponse = {
  sandboxId: string;
  relayfileToken: string;
  relayfileMountPath: string;
  status: "warming" | "ready" | "failed" | "stopping" | "stopped";
  execUrl?: string;
  filesUrl?: string;
  apiKey?: string;
  error?: string;
  expectedReadyBy?: string;
  /**
   * Last completed warm step, surfaced only on the queue-backed warm path
   * (issue #1384 slice 3b) so clients can observe progress while warming.
   * Optional/additive — the legacy scheduleBackgroundTask path never sets it.
   */
  currentStep?: string;
  phase?: CloudAgentBoxWarmPhase;
  etaMs?: number;
};

export type CloudAgentBoxWarmPhase =
  | "queued"
  | "pulling-image"
  | "starting"
  | "cloning"
  | "mounting"
  | "ready";

export type CloudAgentBoxWarmStartResult = {
  response: CloudAgentBoxResponse;
  status: 200 | 202;
};

export type ReapCloudAgentBoxKeepalivesResult = {
  found: number;
  stopped: number;
  vanished: number;
  failed: string[];
};

export class CloudAgentBoxError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function daytonaExecFailFastMs(): number {
  return readNonNegativeInteger(
    process.env[CLOUD_AGENT_DAYTONA_EXEC_FAIL_FAST_MS_ENV]?.trim(),
    DEFAULT_DAYTONA_EXEC_FAIL_FAST_MS,
  );
}

async function withDaytonaExecFailFast<T>(
  label: string,
  attempt: () => Promise<T>,
  timeoutMs = daytonaExecFailFastMs(),
): Promise<T> {
  if (timeoutMs <= 0) {
    return attempt();
  }

  const controller = new AbortController();
  const operation = Promise.resolve().then(attempt);
  let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    controller.abort(new CloudAgentBoxError(
      `Daytona exec ${label} exceeded ${Math.ceil(timeoutMs / 1000)}s client timeout`,
      "daytona_exec_timeout",
      504,
    ));
  }, timeoutMs);
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => {
      reject(controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new CloudAgentBoxError(
          `Daytona exec ${label} exceeded ${Math.ceil(timeoutMs / 1000)}s client timeout`,
          "daytona_exec_timeout",
          504,
        ));
    }, { once: true });
  });

  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
    operation.catch(() => undefined);
  }
}

/**
 * Detect Cloudflare's 524 "A timeout occurred" page (or generic gateway
 * timeouts) bubbling up from the Daytona SDK.
 *
 * The Daytona API sits behind Cloudflare. When the origin takes too long
 * (slow sandbox provisioning, transient capacity), Cloudflare returns a
 * 524 with an HTML page whose <title> contains `524: A timeout occurred`.
 * The Daytona SDK surfaces the HTML body in the thrown Error's message,
 * which is how we recognise it here.
 */
export function isDaytonaUpstreamTimeout(error: unknown): boolean {
  if (error instanceof CloudAgentBoxError && error.code === "daytona_exec_timeout") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (!message) return false;
  return (
    message.includes("524: A timeout occurred") ||
    message.includes("proxy.app.daytona.io") ||
    /\b52[02-4]\b.*timeout/i.test(message)
  );
}

/**
 * Narrow "is this a transient Daytona upstream timeout worth retrying" check
 * for the queue step-runner. Matches BOTH error shapes:
 *  - a RAW gateway error (524 / proxy.app.daytona.io / 52x-timeout) bubbling
 *    from an UNwrapped exec, and
 *  - the `CloudAgentBoxError` with code `daytona_upstream_timeout` that
 *    `retryOnDaytonaUpstreamTimeout` throws AFTER its in-step retries exhaust
 *    (its message — "Daytona is currently unresponsive…" — does NOT match the
 *    raw patterns, so it must be matched by code).
 *  - the `CloudAgentBoxError` with code `daytona_exec_timeout` from the
 *    shorter client-side fail-fast wrapper.
 * Stays narrow: genuine failures (bad snapshot, npm hard-fail, broker-binary
 * missing — `box_warm_failed`/`credential_unavailable`/etc.) are NOT matched
 * and keep their terminal behaviour.
 */
export function isRetryableDaytonaUpstreamError(error: unknown): boolean {
  if (error instanceof CloudAgentBoxError) {
    return error.code === "daytona_upstream_timeout" ||
      error.code === "daytona_exec_timeout";
  }
  return isDaytonaUpstreamTimeout(error);
}

/**
 * Detect Daytona's "name already taken" conflict thrown by `daytona.create`.
 * Daytona surfaces this as a `DaytonaConflictError` (HTTP 409) with a message
 * like `Sandbox with name <x> already exists`. We recover from it by adopting
 * the existing same-named sandbox rather than failing the attach.
 *
 * The SDK carries the HTTP status on `statusCode`, so we trust that first (it
 * survives message-wording changes) and fall back to matching the message for
 * any path that loses the structured error.
 */
function isDaytonaNameConflict(error: unknown): boolean {
  if (error && typeof error === "object") {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (statusCode === 409) {
      return true;
    }
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /sandbox with name .* already exists/i.test(message);
}

/**
 * True when Daytona reports the sandbox no longer exists — e.g. it was
 * destroyed/evicted/swept out-of-band while our sticky `sandboxes` DB row still
 * points at it. NOT-FOUND only: transient gateway 5xx/timeouts are handled by
 * `retryOnDaytonaUpstreamTimeout` and must NOT be misread as "gone" (else a
 * blip would orphan and re-provision a live box). The warm path treats this as
 * a stale row and re-provisions fresh instead of bricking the agent.
 */
function isDaytonaNotFound(error: unknown): boolean {
  if (error && typeof error === "object") {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (statusCode === 404) {
      return true;
    }
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /sandbox\b.*\bnot found\b/i.test(message);
}

/**
 * Fetch a Daytona sandbox by id, returning null when it no longer exists
 * (destroyed/evicted out-of-band) instead of throwing. Other errors (transient
 * upstream, etc.) propagate. Used by GET so an orphaned sticky row reports a
 * clean stopped/recreate-needed state rather than a masked 503.
 */
async function getSandboxOrNullIfGone(
  deps: CloudAgentBoxDeps,
  sandboxId: string,
): Promise<DaytonaSandbox | null> {
  try {
    return await deps.createDaytonaClient().get(sandboxId);
  } catch (error) {
    if (isDaytonaNotFound(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Retry a Daytona SDK call when it bubbles up as a Cloudflare gateway
 * timeout (524 most commonly, also 502/503/Cloudflare 5xx). These are
 * almost always transient — the next attempt usually succeeds within a
 * few seconds because the underlying Daytona origin recovers fast.
 *
 * - Up to 3 attempts total (initial + 2 retries).
 * - Linear backoff: 2s then 5s.
 * - Non-524/timeout errors short-circuit immediately (so input errors
 *   like invalid snapshot keep their fast-fail behaviour).
 * - On exhausted retries, rethrows a structured `CloudAgentBoxError`
 *   instead of the raw HTML page, so callers (and Pear, via
 *   `routeError`) see a clean actionable message rather than nested
 *   "Failed to warm cloud agent box: <html>..." gibberish.
 */
async function retryOnDaytonaUpstreamTimeout<T>(
  label: string,
  attempt: () => Promise<T>,
): Promise<T> {
  const delaysMs = [2_000, 5_000];
  let lastError: unknown;
  for (let i = 0; i <= delaysMs.length; i += 1) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      if (!isDaytonaUpstreamTimeout(error)) {
        throw error;
      }
      if (i === delaysMs.length) {
        logger.warn("[cloud-agent-box] daytona upstream timeout — retries exhausted", {
          label,
          attempts: i + 1,
        });
        throw new CloudAgentBoxError(
          "Daytona is currently unresponsive — please retry in a moment",
          "daytona_upstream_timeout",
          504,
        );
      }
      logger.warn("[cloud-agent-box] daytona upstream timeout — retrying", {
        label,
        nextAttempt: i + 2,
        retryDelayMs: delaysMs[i],
      });
      await sleep(delaysMs[i]);
    }
  }
  // Unreachable — the loop above either returns or throws.
  throw lastError;
}

function readCloudflareEnv(): Record<string, unknown> | undefined {
  const context = (globalThis as Record<symbol, unknown>)[cloudflareContextSymbol];
  if (!context || typeof context !== "object" || !("env" in context)) {
    return undefined;
  }
  const env = (context as { env?: unknown }).env;
  return env && typeof env === "object"
    ? env as Record<string, unknown>
    : undefined;
}

function readCloudflareWaitUntil(): ((promise: Promise<unknown>) => void) | undefined {
  const context = (globalThis as Record<symbol, unknown>)[cloudflareContextSymbol];
  if (!context || typeof context !== "object") {
    return undefined;
  }
  // `ExecutionContext.waitUntil` is a Cloudflare C++ binding that requires
  // its original receiver as `this`. Extracting the method into a local
  // variable and calling it bare (`waitUntil(promise)`) loses that `this`
  // and throws `Illegal invocation: function called with incorrect `this`
  // reference` — that lands in the async warm path's `routeError`
  // catch-all and surfaces to Pear as a generic 503 box_request_failed.
  // The closures below dispatch via property access on the receiver so
  // the native binding sees the correct `this`.
  const cloudflareContext = context as {
    waitUntil?: (promise: Promise<unknown>) => void;
    ctx?: { waitUntil?: (promise: Promise<unknown>) => void };
  };
  if (typeof cloudflareContext.waitUntil === "function") {
    return (promise: Promise<unknown>) => cloudflareContext.waitUntil!(promise);
  }
  if (cloudflareContext.ctx && typeof cloudflareContext.ctx.waitUntil === "function") {
    const ctx = cloudflareContext.ctx;
    return (promise: Promise<unknown>) => ctx.waitUntil!(promise);
  }
  return undefined;
}

// Minimal session-client shape shared by node-postgres `Client` and
// `@neondatabase/serverless` `Client` — both expose connect/query/end.
type BoxLockClient = {
  connect(): Promise<void>;
  query<T>(text: string, params: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
};

function isWorkerRuntime(): boolean {
  const ctx = (globalThis as Record<symbol, unknown>)[cloudflareContextSymbol];
  if (ctx && typeof ctx === "object") {
    return true;
  }
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
  return (
    typeof nav?.userAgent === "string" &&
    nav.userAgent.includes("Cloudflare-Workers")
  );
}

async function createCloudAgentBoxLockClient(): Promise<BoxLockClient> {
  // Session-pinned client for the advisory lock. `pg_advisory_lock` is
  // session-scoped, so this must be a single dedicated session on Neon's
  // DIRECT endpoint. The stage-wide NeonDatabaseUrl is usually pooled for app
  // traffic; transaction pooling does not pin the backend session.
  const pooled = getNeonDatabaseUrl();
  if (!pooled) {
    throw new CloudAgentBoxError(
      "No Postgres connection string configured for the cloud agent box advisory lock",
      "box_request_failed",
      500,
    );
  }
  const connectionString = toDirectNeonConnectionString(pooled);

  // Runtime-specific driver. On the Cloudflare Worker the only way to open a
  // socket is @neondatabase/serverless (WebSocket, global on workerd). On the
  // Node/Lambda runtime, use node-postgres over TCP — the neon-serverless
  // Client would need an explicit `webSocketConstructor` to work under Node.
  if (isWorkerRuntime()) {
    return new NeonClient(connectionString) as unknown as BoxLockClient;
  }
  const { Client: PgClient } = await import("pg");
  return new PgClient({
    connectionString,
    ...(isLocalConnectionString(connectionString)
      ? {}
      : { ssl: { rejectUnauthorized: false } }),
  }) as unknown as BoxLockClient;
}

async function withPgSessionAdvisoryLock<T>(input: {
  workspaceId: string;
  cloudAgentId: string;
}, fn: () => Promise<T>): Promise<T> {
  const lockClient = await createCloudAgentBoxLockClient();
  await lockClient.connect();
  let locked = false;

  try {
    const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
    while (!locked) {
      const result = await lockClient.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS locked",
        [input.workspaceId, input.cloudAgentId],
      );
      locked = result.rows[0]?.locked === true;
      if (locked) {
        break;
      }
      if (Date.now() >= deadline) {
        throw new CloudAgentBoxError(
          "Cloud agent box is already warming",
          "box_lock_timeout",
          423,
        );
      }
      await sleep(LOCK_RETRY_DELAY_MS);
    }

    return await fn();
  } finally {
    if (locked) {
      try {
        await lockClient.query(
          "SELECT pg_advisory_unlock(hashtext($1), hashtext($2))",
          [input.workspaceId, input.cloudAgentId],
        );
      } catch (error) {
        logger.warn("Failed to unlock cloud agent box advisory lock", {
          area: "cloud-agent-box",
          workspaceId: input.workspaceId,
          cloudAgentId: input.cloudAgentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await lockClient.end();
  }
}

export type CloudAgentBoxDeps = {
  findCredential: (input: {
    auth: Auth;
    cloudAgentId: string;
  }) => Promise<ProviderCredentialRow | null>;
  findStickySandbox: (input: {
    workspaceId: string;
    cloudAgentId: string;
  }) => Promise<SandboxRow | null>;
  insertSandbox: (input: {
    sandboxId: string;
    auth: Auth;
    workspaceId: string;
    cloudAgentId: string;
    brokerPort?: number | null;
    status: string;
    error?: string | null;
    expectedReadyBy?: Date | null;
    keepaliveUntil?: Date | null;
  }) => Promise<void>;
  updateSandbox: (input: {
    sandboxId: string;
    workspaceId: string;
    status?: string;
    brokerPort?: number | null;
    error?: string | null;
    expectedReadyBy?: Date | null;
    keepaliveUntil?: Date | null;
  }) => Promise<void>;
  replaceSandboxId: (input: {
    oldSandboxId: string;
    newSandboxId: string;
    workspaceId: string;
    status: string;
    brokerPort?: number | null;
    error?: string | null;
    expectedReadyBy?: Date | null;
    keepaliveUntil?: Date | null;
  }) => Promise<void>;
  listExpiredKeepaliveSandboxes: (input: {
    now: Date;
    limit: number;
  }) => Promise<KeepaliveSandboxRow[]>;
  scheduleBackgroundTask: (task: () => Promise<void>) => void;
  markCredentialUsed: (credentialId: string) => Promise<void>;
  createDaytonaClient: () => DaytonaClient;
  getSnapshotName: () => Promise<string>;
  getLiteSnapshotName: () => Promise<string>;
  getCredentialSecret: (input: {
    auth: Auth;
    credential: ProviderCredentialRow;
  }) => Promise<string | null>;
  mountCliCredentials: typeof mountCliCredentials;
  mintPathScopedRelayfileToken: typeof mintPathScopedRelayfileToken;
  mintRelayAuthWorkspaceToken: typeof mintRelayAuthWorkspaceToken;
  evictRelayAuthWorkspaceTokenCache: typeof evictRelayAuthWorkspaceTokenCache;
  getBrokerKeySecret: typeof getBrokerKeySecret;
  deriveBrokerApiKey: typeof deriveBrokerApiKey;
  resolveRelayAuthConfig: typeof resolveRelayAuthConfig;
  resolveRelayfileConfig: typeof resolveRelayfileConfig;
  startRelayfileMount: (input: StartRelayfileMountInput) => Promise<RelayfileMountHandle>;
  flushRelayfileMount: (input: FlushRelayfileMountInput) => Promise<void>;
  resolveGitCloneCredentials: typeof resolveGitCloneCredentials;
  withCloudAgentBoxLock: <T>(input: {
    workspaceId: string;
    cloudAgentId: string;
  }, fn: () => Promise<T>) => Promise<T>;
  now: () => Date;
};

export type CloudAgentBoxInput = {
  auth: Auth;
  urlWorkspaceId?: string;
  cloudAgentId: string;
  workspaceToken: string | null;
  mountPaths?: string[];
  workspaceSource?: CloudAgentWorkspaceSource;
  /**
   * Explicit relay workspace key + broker instance name (#125). Provision-time
   * only (POST /box): injected verbatim as AGENT_RELAY_WORKSPACE_KEY /
   * AGENT_RELAY_BROKER_NAME so the in-sandbox broker joins the caller's
   * workspace instead of creating an isolated one. PATCH never parses these;
   * updateCloudAgentBoxMountPaths preserves the existing values from the box
   * env file when it rewrites it.
   */
  workspaceKey?: string;
  brokerName?: string;
};

export type CloudAgentWorkspaceSource =
  | { kind: "relayfile" }
  | CloudAgentGitWorkspaceSource;

type CloudAgentGitWorkspaceSource = {
  kind: "git" | "git-overlay";
  remoteUrl: string;
  ref?: string;
  commit?: string;
  shallow?: boolean;
  targetDir?: string;
  largeReason?: string;
};

function resolveWorkflowStorageBucket(): string {
  try {
    const bucket = Resource.WorkflowStorage.bucketName?.trim();
    if (bucket) {
      return bucket;
    }
  } catch {
    // local dev/test fallback below
  }

  const fromEnv = optionalEnv("WORKFLOW_STORAGE_BUCKET");
  if (!fromEnv) {
    throw new Error("WorkflowStorage bucket is not configured");
  }
  return fromEnv;
}

function resolveCredentialEncryptionKey(): string {
  const resourceValue = tryResourceValue("CredentialEncryptionKey")?.trim();
  if (resourceValue) {
    return resourceValue;
  }
  const fromEnv = optionalEnv("CREDENTIAL_ENCRYPTION_KEY")?.trim();
  if (!fromEnv) {
    throw new Error("CredentialEncryptionKey is not configured");
  }
  return fromEnv;
}

async function readCredentialSecret(input: {
  auth: Auth;
  credential: ProviderCredentialRow;
}): Promise<string | null> {
  const s3 = await createCredentialStoreS3Client({ userId: input.auth.userId });
  const store = new CredentialStore({
    bucket: resolveWorkflowStorageBucket(),
    prefix: "credentials",
    encryptionKey: resolveCredentialEncryptionKey(),
    client: s3,
  });
  const key =
    input.credential.authType === "byo_api_key"
      ? input.credential.id
      : input.credential.modelProvider;
  return store.retrieve(input.auth.userId, key);
}

const defaultDeps: CloudAgentBoxDeps = {
  async findCredential(input) {
    const [row] = await getDb()
      .select({
        id: providerCredentials.id,
        organizationId: providerCredentials.organizationId,
        workspaceId: providerCredentials.workspaceId,
        userId: providerCredentials.userId,
        harness: providerCredentials.harness,
        modelProvider: providerCredentials.modelProvider,
        authType: providerCredentials.authType,
        displayName: providerCredentials.displayName,
        defaultModel: providerCredentials.defaultModel,
        status: providerCredentials.status,
        credentialExpiresAt: providerCredentials.credentialExpiresAt,
        refreshExhausted: providerCredentials.refreshExhausted,
        lastError: providerCredentials.lastError,
      })
      .from(providerCredentials)
      .where(
        and(
          eq(providerCredentials.id, input.cloudAgentId),
          eq(providerCredentials.userId, input.auth.userId),
          eq(providerCredentials.workspaceId, input.auth.workspaceId),
        ),
      )
      .limit(1);
    return row ?? null;
  },
  async findStickySandbox(input) {
    const [row] = await getDb()
      .select({
        id: sandboxes.id,
        status: sandboxes.status,
        brokerPort: sandboxes.brokerPort,
        error: sandboxes.error,
        expectedReadyBy: sandboxes.expectedReadyBy,
        keepaliveUntil: sandboxes.keepaliveUntil,
      })
      .from(sandboxes)
      .where(
        and(
          eq(sandboxes.workspaceId, input.workspaceId),
          eq(sandboxes.cloudAgentId, input.cloudAgentId),
          inArray(sandboxes.status, ["running", "warming", "failed", "stopped", "stopping"]),
        ),
      )
      .orderBy(desc(sandboxes.updatedAt))
      .limit(1);
    return row ?? null;
  },
  async insertSandbox(input) {
    const now = new Date();
    // Idempotent on the sandbox id (Daytona sandbox ID, the primary key). A
    // fresh create never conflicts, but adopting a drifted box can collide with
    // a stale row left behind in a non-active status ("deleted"/"archived"),
    // which `findStickySandbox` deliberately ignores — revive that row instead
    // of throwing a primary-key violation.
    await getDb()
      .insert(sandboxes)
      .values({
        id: input.sandboxId,
        userId: input.auth.userId,
        organizationId: input.auth.organizationId,
        workspaceId: input.workspaceId,
        source: "cloud-agent",
        runId: null,
        cloudAgentId: input.cloudAgentId,
        status: input.status,
        brokerPort: input.brokerPort ?? null,
        error: input.error ?? null,
        expectedReadyBy: input.expectedReadyBy ?? null,
        keepaliveUntil: input.keepaliveUntil ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: sandboxes.id,
        set: {
          // Re-stamp ownership too: a drifted row could have been written by a
          // different caller, so adopting it should make the current request
          // authoritative rather than leave stale owner columns behind.
          userId: input.auth.userId,
          organizationId: input.auth.organizationId,
          workspaceId: input.workspaceId,
          cloudAgentId: input.cloudAgentId,
          status: input.status,
          brokerPort: input.brokerPort ?? null,
          error: input.error ?? null,
          expectedReadyBy: input.expectedReadyBy ?? null,
          keepaliveUntil: input.keepaliveUntil ?? null,
          updatedAt: now,
        },
      });
  },
  async updateSandbox(input) {
    await getDb()
      .update(sandboxes)
      .set({
        ...(input.status ? { status: input.status } : {}),
        ...(input.brokerPort !== undefined ? { brokerPort: input.brokerPort } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
        ...(input.expectedReadyBy !== undefined ? { expectedReadyBy: input.expectedReadyBy } : {}),
        ...(input.keepaliveUntil !== undefined
          ? { keepaliveUntil: input.keepaliveUntil }
          : input.status
            ? { keepaliveUntil: null }
            : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sandboxes.id, input.sandboxId),
          eq(sandboxes.workspaceId, input.workspaceId),
        ),
      );
  },
  async replaceSandboxId(input) {
    await getDb()
      .update(sandboxes)
      .set({
        id: input.newSandboxId,
        status: input.status,
        ...(input.brokerPort !== undefined ? { brokerPort: input.brokerPort } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
        ...(input.expectedReadyBy !== undefined ? { expectedReadyBy: input.expectedReadyBy } : {}),
        keepaliveUntil: input.keepaliveUntil ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sandboxes.id, input.oldSandboxId),
          eq(sandboxes.workspaceId, input.workspaceId),
        ),
      );
  },
  async listExpiredKeepaliveSandboxes(input) {
    return getDb()
      .select({
        id: sandboxes.id,
        workspaceId: sandboxes.workspaceId,
        cloudAgentId: sandboxes.cloudAgentId,
        keepaliveUntil: sandboxes.keepaliveUntil,
      })
      .from(sandboxes)
      .where(
        and(
          eq(sandboxes.source, "cloud-agent"),
          eq(sandboxes.status, "running"),
          isNotNull(sandboxes.cloudAgentId),
          isNotNull(sandboxes.keepaliveUntil),
          lte(sandboxes.keepaliveUntil, input.now),
        ),
      )
      .orderBy(sandboxes.keepaliveUntil)
      .limit(input.limit) as Promise<KeepaliveSandboxRow[]>;
  },
  scheduleBackgroundTask(task) {
    const promise = Promise.resolve()
      .then(task)
      .catch((error) => {
        logger.error("[cloud-agent-box] background warm task failed", {
          area: "cloud-agent-box",
          error: error instanceof Error ? error.message : String(error),
        });
      });
    const waitUntil = readCloudflareWaitUntil();
    if (waitUntil) {
      waitUntil(promise);
    }
  },
  async markCredentialUsed(credentialId) {
    await getDb()
      .update(providerCredentials)
      .set({ lastUsedAt: new Date(), updatedAt: new Date() })
      .where(eq(providerCredentials.id, credentialId));
  },
  createDaytonaClient: () => createDaytonaClient() as unknown as DaytonaClient,
  getSnapshotName,
  getLiteSnapshotName,
  getCredentialSecret: readCredentialSecret,
  mountCliCredentials,
  mintPathScopedRelayfileToken,
  mintRelayAuthWorkspaceToken,
  evictRelayAuthWorkspaceTokenCache,
  getBrokerKeySecret,
  deriveBrokerApiKey,
  resolveRelayAuthConfig,
  resolveRelayfileConfig,
  resolveGitCloneCredentials,
  startRelayfileMount: startSandboxRelayfileMount,
  flushRelayfileMount: flushSandboxRelayfileMount,
  async withCloudAgentBoxLock(input, fn) {
    return withPgSessionAdvisoryLock(input, fn);
  },
  now: () => new Date(),
};

function workspaceSourceKind(
  source: CloudAgentWorkspaceSource | undefined,
): "relayfile" | "git" | "git-overlay" {
  if (source?.kind === "git" || source?.kind === "git-overlay") {
    return source.kind;
  }
  return "relayfile";
}

function isGitWorkspaceSource(
  source: CloudAgentWorkspaceSource | undefined,
): source is CloudAgentGitWorkspaceSource {
  return source?.kind === "git" || source?.kind === "git-overlay";
}

function isDirectGitWorkspaceSource(
  source: CloudAgentWorkspaceSource | undefined,
): source is CloudAgentGitWorkspaceSource & { kind: "git" } {
  return source?.kind === "git";
}

function normalizeWorkspaceSource(
  source: CloudAgentWorkspaceSource | undefined,
): CloudAgentWorkspaceSource | undefined {
  if (!isGitWorkspaceSource(source)) {
    return source;
  }
  const remoteUrl = normalizeHttpsGitRemote(source.remoteUrl);
  if (!remoteUrl) {
    throw new CloudAgentBoxError(
      "Git workspace source must use an HTTPS remote",
      "invalid_request",
      400,
    );
  }
  return { ...source, remoteUrl };
}

const workspaceSourceCache = new Map<string, CloudAgentWorkspaceSource>();

function workspaceSourceCacheKey(input: Pick<CloudAgentBoxInput, "auth" | "cloudAgentId">): string {
  return `${input.auth.workspaceId}:${input.cloudAgentId}`;
}

function rememberWorkspaceSource(input: CloudAgentBoxInput): void {
  input.workspaceSource = normalizeWorkspaceSource(input.workspaceSource);
  if (!input.workspaceSource) return;
  const key = workspaceSourceCacheKey(input);
  if (isGitWorkspaceSource(input.workspaceSource)) {
    workspaceSourceCache.set(key, input.workspaceSource);
  } else {
    workspaceSourceCache.delete(key);
  }
}

function withRememberedWorkspaceSource(input: CloudAgentBoxInput): CloudAgentBoxInput {
  rememberWorkspaceSource(input);
  return input.workspaceSource
    ? input
    : {
        ...input,
        workspaceSource: workspaceSourceCache.get(workspaceSourceCacheKey(input)),
      };
}

function withExplicitWorkspaceSource(input: CloudAgentBoxInput): CloudAgentBoxInput {
  input = { ...input, workspaceSource: normalizeWorkspaceSource(input.workspaceSource) };
  if (isGitWorkspaceSource(input.workspaceSource)) {
    workspaceSourceCache.set(workspaceSourceCacheKey(input), input.workspaceSource);
    return input;
  }
  workspaceSourceCache.delete(workspaceSourceCacheKey(input));
  return input.workspaceSource
    ? input
    : { ...input, workspaceSource: undefined };
}

function workspaceTargetDir(source: CloudAgentWorkspaceSource | undefined): string {
  if (!isGitWorkspaceSource(source)) {
    return DEFAULT_MOUNT_PATH;
  }
  const target = source.targetDir?.trim();
  return target && (target === DEFAULT_MOUNT_PATH || target.startsWith(`${DEFAULT_MOUNT_PATH}/`))
    ? target
    : DEFAULT_MOUNT_PATH;
}

export function normalizeMountPaths(
  paths: string[] | undefined,
  workspaceSource?: CloudAgentWorkspaceSource,
): string[] {
  const isDirectGit = isDirectGitWorkspaceSource(workspaceSource);
  const defaultPaths = isDirectGit
    ? [DIRECT_GIT_DEFAULT_MOUNT_PATH]
    : [DEFAULT_MOUNT_PATH];
  const normalized = [...new Set(
    (paths?.length ? paths : defaultPaths)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => entry.startsWith("/") ? entry : `/${entry}`),
  )].sort();

  if (normalized.length === 0) {
    throw new CloudAgentBoxError(
      "relayfileMountPaths must include at least one path",
      "invalid_request",
      400,
    );
  }
  if (isDirectGit) {
    const workspaceDir = workspaceTargetDir(workspaceSource);
    const overlapsWorkspace = normalized.some((path) =>
      path === workspaceDir ||
      path.startsWith(`${workspaceDir}/`) ||
      workspaceDir.startsWith(`${path.replace(/\/+$/u, "")}/`));
    const outsideIntegrations = normalized.some((path) =>
      path !== DIRECT_GIT_DEFAULT_MOUNT_PATH &&
      !path.startsWith(`${DIRECT_GIT_DEFAULT_MOUNT_PATH}/`));
    if (overlapsWorkspace || outsideIntegrations) {
      throw new CloudAgentBoxError(
        "Direct Git workspace mounts may only include /integrations paths",
        "invalid_request",
        400,
      );
    }
  }
  return normalized;
}

export function primaryMountPath(
  paths: string[],
  workspaceSource?: CloudAgentWorkspaceSource,
): string {
  if (isGitWorkspaceSource(workspaceSource)) {
    return workspaceTargetDir(workspaceSource);
  }
  return paths.includes(DEFAULT_MOUNT_PATH)
    ? DEFAULT_MOUNT_PATH
    : paths[0] ?? DEFAULT_MOUNT_PATH;
}

function warmingSandboxId(): string {
  return `${WARMING_SANDBOX_ID_PREFIX}${randomUUID()}`;
}

function isWarmingPlaceholderId(id: string): boolean {
  return id.startsWith(WARMING_SANDBOX_ID_PREFIX);
}

function phaseForWarmingSandboxId(sandboxId: string): CloudAgentBoxWarmPhase {
  return isWarmingPlaceholderId(sandboxId) ? "queued" : "starting";
}

function expectedReadyBy(deps: CloudAgentBoxDeps, durationMs = ASYNC_WARM_DEADLINE_MS): Date {
  return new Date(deps.now().getTime() + durationMs);
}

export function etaMsUntil(now: Date, expectedReadyBy?: Date | string | null): number | undefined {
  if (!expectedReadyBy) {
    return undefined;
  }
  const target = new Date(expectedReadyBy).getTime();
  if (!Number.isFinite(target)) {
    return undefined;
  }
  return Math.max(0, target - now.getTime());
}

function warmingExpired(row: SandboxRow, now: Date): boolean {
  if (row.status !== "warming" || !row.expectedReadyBy) {
    return false;
  }
  return new Date(row.expectedReadyBy).getTime() <= now.getTime();
}

function readKeepaliveTtlMs(): number {
  const raw = optionalEnv(CLOUD_AGENT_KEEPALIVE_TTL_MS_ENV)?.trim();
  if (!raw) {
    return DEFAULT_KEEPALIVE_TTL_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_KEEPALIVE_TTL_MS;
}

function keepaliveUntil(deps: CloudAgentBoxDeps): Date | null {
  const ttlMs = readKeepaliveTtlMs();
  if (ttlMs <= 0) {
    return null;
  }
  return new Date(deps.now().getTime() + ttlMs);
}

function keepaliveActive(row: SandboxRow, now: Date): boolean {
  if (row.status !== "running" || !row.keepaliveUntil) {
    return false;
  }
  const expiresAt = new Date(row.keepaliveUntil).getTime();
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

function sameMountPaths(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function sameWorkspaceSource(
  left: CloudAgentWorkspaceSource | undefined,
  right: CloudAgentWorkspaceSource | undefined,
): boolean {
  if (workspaceSourceKind(left) !== workspaceSourceKind(right)) {
    return false;
  }
  if (!isGitWorkspaceSource(left) || !isGitWorkspaceSource(right)) {
    return true;
  }
  return left.remoteUrl === right.remoteUrl &&
    (left.ref ?? "") === (right.ref ?? "") &&
    (left.commit ?? "") === (right.commit ?? "") &&
    workspaceTargetDir(left) === workspaceTargetDir(right);
}

function pendingBoxResponse(input: {
  sandboxId: string;
  relayfileToken: string;
  mountPaths: string[];
  workspaceSource?: CloudAgentWorkspaceSource;
  expectedReadyBy?: Date | string | null;
  phase?: CloudAgentBoxWarmPhase;
  now?: Date;
}): CloudAgentBoxResponse {
  const expected = input.expectedReadyBy
    ? new Date(input.expectedReadyBy).toISOString()
    : undefined;
  const etaMs = input.now ? etaMsUntil(input.now, input.expectedReadyBy) : undefined;
  return {
    sandboxId: input.sandboxId,
    status: "warming",
    relayfileToken: input.relayfileToken,
    relayfileMountPath: primaryMountPath(input.mountPaths, input.workspaceSource),
    ...(expected ? { expectedReadyBy: expected } : {}),
    ...(input.phase ? { phase: input.phase } : {}),
    ...(etaMs !== undefined ? { etaMs } : {}),
  };
}

function failedBoxResponse(input: {
  sandboxId: string;
  relayfileToken: string;
  mountPaths: string[];
  workspaceSource?: CloudAgentWorkspaceSource;
  error?: string | null;
}): CloudAgentBoxResponse {
  return {
    sandboxId: input.sandboxId,
    status: "failed",
    relayfileToken: input.relayfileToken,
    relayfileMountPath: primaryMountPath(input.mountPaths, input.workspaceSource),
    error: input.error || "Cloud agent box warm failed",
  };
}

function stoppedBoxResponse(input: {
  sandboxId: string;
  relayfileToken: string;
  mountPaths: string[];
  workspaceSource?: CloudAgentWorkspaceSource;
  status: "stopping" | "stopped";
}): CloudAgentBoxResponse {
  return {
    sandboxId: input.sandboxId,
    status: input.status,
    relayfileToken: input.relayfileToken,
    relayfileMountPath: primaryMountPath(input.mountPaths, input.workspaceSource),
  };
}

export function backgroundErrorMessage(error: unknown): string {
  if (error instanceof CloudAgentBoxError) {
    return error.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error || "Cloud agent box warm failed");
}

// Headroom the client-side fail-fast gives a server-side exec timeout before
// aborting — covers Daytona API/network overhead around the exec itself.
const DAYTONA_EXEC_FAIL_FAST_MARGIN_MS = 15_000;

function createBoxSandboxOrchestrator(sandbox: DaytonaSandbox): SandboxOrchestrator<DaytonaSandbox> {
  return new SandboxOrchestrator({
    runScript: async (handle, options) => {
      // The fail-fast must out-wait an explicit server-side exec timeout —
      // otherwise it kills legitimately long execs (e.g. a 120s flush) at the
      // 45s default. A 0 fail-fast (env override) stays disabled.
      const failFastMs = daytonaExecFailFastMs();
      const timeoutMs = options.timeoutMs === undefined || failFastMs <= 0
        ? failFastMs
        : Math.max(failFastMs, options.timeoutMs + DAYTONA_EXEC_FAIL_FAST_MARGIN_MS);
      const result = await withDaytonaExecFailFast(
        "relayfile-mount",
        () => handle.process.executeCommand(
          options.command,
          options.cwd,
          options.env,
          options.timeoutMs === undefined ? undefined : Math.ceil(options.timeoutMs / 1000),
        ),
        timeoutMs,
      );
      return {
        exitCode: result.exitCode,
        output: daytonaCommandOutput(result).trim(),
      };
    },
  });
}

async function startSandboxRelayfileMount(input: StartRelayfileMountInput): Promise<RelayfileMountHandle> {
  // Box warm restarts reuse long-lived sandboxes, so this wrapper keeps the
  // stale-daemon restart behavior local while workflow/proactive use their
  // own lifecycle sequences around the same orchestrator primitive.
  const config = {
    ...input.config,
    ...(input.config.paths ? { paths: [...input.config.paths] } : {}),
  };
  return createBoxSandboxOrchestrator(input.sandbox).startMount(input.sandbox, config, {
    cwd: input.sandboxHome,
    // The initial sync runs detached in the sandbox and is polled with short
    // execs, so it can outlive any single Daytona exec. The idle watchdog
    // cancels a *stalled* sync; the deadline bounds a still-progressing one
    // (a first materialization of real integration data can take minutes)
    // while staying inside the warm step's 5-minute lease.
    initialSyncIdleTimeoutMs: 90_000,
    initialSyncDeadlineMs: 240_000,
    killExisting: true,
  });
}

async function flushSandboxRelayfileMount(input: FlushRelayfileMountInput): Promise<void> {
  const config = {
    ...input.config,
    ...(input.config.paths ? { paths: [...input.config.paths] } : {}),
  };
  await createBoxSandboxOrchestrator(input.sandbox).flushMount(input.sandbox, config, {
    cwd: input.sandboxHome,
    timeoutMs: 120_000,
  });
}

function parseBoxEnvFile(value: string): Record<string, string> | null {
  if (!value.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const envVars: Record<string, string> = {};
    for (const [key, entry] of Object.entries(parsed)) {
      if (typeof entry === "string") {
        envVars[key] = entry;
      }
    }
    return envVars;
  } catch {
    return null;
  }
}

async function readBoxEnvFile(
  sandbox: DaytonaSandbox,
  home: string,
): Promise<Record<string, string> | null> {
  const result = await sandbox.process.executeCommand(
    `cat ${shellQuote(`${home}/.cloud-agent-box-env.json`)} 2>/dev/null`,
    home,
  );
  if (result.exitCode !== 0) {
    return null;
  }
  return parseBoxEnvFile(daytonaCommandOutput(result).trim());
}

function mountPathsFromEnv(envVars: Record<string, string>): string[] | null {
  try {
    const parsed = JSON.parse(envVars.RELAYFILE_MOUNT_PATHS ?? "");
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
      return null;
    }
    return normalizeMountPaths(parsed);
  } catch {
    return null;
  }
}

function workspaceSourceFromEnv(envVars: Record<string, string>): CloudAgentWorkspaceSource | undefined {
  const sourceKind = envVars.PEAR_WORKSPACE_SOURCE_KIND;
  if (sourceKind !== "git" && sourceKind !== "git-overlay") {
    return undefined;
  }
  const remoteUrl = normalizeHttpsGitRemote(envVars.PEAR_WORKSPACE_GIT_REMOTE ?? "");
  if (!remoteUrl) {
    return undefined;
  }
  const targetDir = envVars.PEAR_WORKSPACE_DIR?.trim();
  return {
    kind: sourceKind,
    remoteUrl,
    ...(envVars.PEAR_WORKSPACE_GIT_REF?.trim() ? { ref: envVars.PEAR_WORKSPACE_GIT_REF.trim() } : {}),
    ...(envVars.PEAR_WORKSPACE_GIT_COMMIT?.trim() ? { commit: envVars.PEAR_WORKSPACE_GIT_COMMIT.trim() } : {}),
    ...(targetDir && (targetDir === DEFAULT_MOUNT_PATH || targetDir.startsWith(`${DEFAULT_MOUNT_PATH}/`))
      ? { targetDir }
      : {}),
    ...(envVars.PEAR_WORKSPACE_GIT_REASON?.trim() ? { largeReason: envVars.PEAR_WORKSPACE_GIT_REASON.trim() } : {}),
  };
}

async function mintRelayfileTokenForPaths(input: {
  deps: CloudAgentBoxDeps;
  request: Pick<CloudAgentBoxInput, "auth" | "cloudAgentId" | "urlWorkspaceId">;
  credential: ProviderCredentialRow;
  mountPaths: string[];
}): Promise<string> {
  return mintRelayfileToken(input.deps, {
    ...input.request,
    workspaceToken: null,
    mountPaths: input.mountPaths,
  }, input.credential, input.mountPaths);
}

async function activeRelayfileMountRuntimeConfig(input: {
  deps: CloudAgentBoxDeps;
  sandbox: DaytonaSandbox;
  sandboxHome: string;
  request: Pick<CloudAgentBoxInput, "auth" | "cloudAgentId" | "urlWorkspaceId">;
  credential: ProviderCredentialRow;
}): Promise<RelayfileMountRuntimeConfig | null> {
  const existingEnv = await readBoxEnvFile(input.sandbox, input.sandboxHome);
  if (!existingEnv) {
    return null;
  }
  const mountPaths = mountPathsFromEnv(existingEnv);
  if (!mountPaths) {
    return null;
  }
  const token = await mintRelayfileTokenForPaths({
    deps: input.deps,
    request: input.request,
    credential: input.credential,
    mountPaths,
  });
  const relayfile = input.deps.resolveRelayfileConfig();
  const workspaceSource = workspaceSourceFromEnv(existingEnv);
  return {
    baseUrl: existingEnv.RELAYFILE_URL || relayfile.relayfileUrl,
    workspaceId: existingEnv.RELAYFILE_WORKSPACE_ID || input.request.auth.workspaceId,
    token,
    mountPaths,
    localDir: isDirectGitWorkspaceSource(workspaceSource) ? DIRECT_GIT_RELAYFILE_LOCAL_DIR : DEFAULT_MOUNT_LOCAL_DIR,
  };
}

async function flushActiveRelayfileMount(input: {
  deps: CloudAgentBoxDeps;
  sandbox: DaytonaSandbox;
  sandboxHome: string;
  request: Pick<CloudAgentBoxInput, "auth" | "cloudAgentId" | "urlWorkspaceId">;
  credential: ProviderCredentialRow;
}): Promise<boolean> {
  const config = await activeRelayfileMountRuntimeConfig(input);
  if (!config) {
    return false;
  }
  await input.deps.flushRelayfileMount({
    sandbox: input.sandbox,
    sandboxHome: input.sandboxHome,
    // credsFilePath lets a flush whose env-file token already expired heal
    // mid-run: the --once sync starts with the stale --token, gets a 401, and
    // re-reads the creds file the caller refreshed just before flushing.
    config: relayfileMountConfigFromParts({
      ...config,
      credsFilePath: boxMountCredsFilePath(input.sandboxHome),
    }),
  });
  return true;
}

function assertUsableCredential(credential: ProviderCredentialRow, now: Date): void {
  const expiresAtMs =
    credential.credentialExpiresAt instanceof Date
      ? credential.credentialExpiresAt.getTime()
      : credential.credentialExpiresAt
        ? Date.parse(credential.credentialExpiresAt)
        : Number.NaN;
  if (
    credential.status !== "connected" ||
    credential.refreshExhausted ||
    credential.lastError ||
    (Number.isFinite(expiresAtMs) && expiresAtMs <= now.getTime())
  ) {
    throw new CloudAgentBoxError(
      credential.lastError ?? "Cloud agent credential is unavailable",
      "credential_unavailable",
      409,
    );
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseByokCredential(value: string | null): { modelProvider?: string; key?: string } | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as { modelProvider?: unknown; key?: unknown };
    return {
      modelProvider: typeof parsed.modelProvider === "string" ? parsed.modelProvider : undefined,
      key: typeof parsed.key === "string" ? parsed.key : undefined,
    };
  } catch {
    return { key: value };
  }
}

function directCredentialEnv(modelProvider: string, secret: string | null): Record<string, string> {
  const parsed = parseByokCredential(secret);
  const key = parsed?.key?.trim();
  if (!key) {
    return {};
  }
  const provider = (parsed?.modelProvider ?? modelProvider).trim().toLowerCase();
  if (provider === "anthropic") {
    return { ANTHROPIC_API_KEY: key };
  }
  if (provider === "openai") {
    return { OPENAI_API_KEY: key };
  }
  if (provider === "google") {
    return { GOOGLE_API_KEY: key };
  }
  if (provider === "openrouter") {
    return { OPENROUTER_API_KEY: key };
  }
  return {};
}

function boxStatusFromState(state: string | undefined, rowStatus?: string): CloudAgentBoxResponse["status"] {
  if (rowStatus === "failed") {
    return "failed";
  }
  if (rowStatus === "stopping") {
    return "stopping";
  }
  if (rowStatus === "stopped") {
    return "stopped";
  }
  switch (state) {
    case "started":
    case undefined:
      return "ready";
    case "stopped":
    case "destroyed":
    case "archived":
      return "stopped";
    case "stopping":
    case "destroying":
    case "archiving":
      return "stopping";
    default:
      return "warming";
  }
}

export async function mintRelayfileToken(
  deps: CloudAgentBoxDeps,
  input: CloudAgentBoxInput,
  credential: ProviderCredentialRow,
  mountPaths: string[],
): Promise<string> {
  const { relayAuthUrl } = deps.resolveRelayAuthConfig();

  // /v1/tokens/path requires a workspace-scoped credential. The cloud's
  // org-level RELAYAUTH_API_KEY isn't itself one, so we first exchange it for
  // a `relay_ws_*` workspace key via /v1/tokens/workspace, then use that key
  // as the bearer for the path-token mint. The helper caches the workspace
  // key per (workspaceId, orgApiKeyHash) so repeated warms don't re-mint.
  const baseOptions: Omit<MintPathScopedRelayfileTokenOptions, "workspaceToken" | "relayAuthApiKey"> = {
    workspaceId: input.auth.workspaceId,
    relayAuthUrl,
    paths: mountPaths,
    ttlSeconds: DEFAULT_BOX_TIMEOUT_SECONDS,
    agentName: credential.displayName,
    agentId: credential.id,
    auditLogger: logger,
  };

  const workspaceToken = await deps.mintRelayAuthWorkspaceToken({
    workspaceId: input.auth.workspaceId,
    agentName: credential.displayName,
  });

  try {
    return await deps.mintPathScopedRelayfileToken({
      ...baseOptions,
      workspaceToken,
    });
  } catch (error) {
    const { relayAuthApiKey } = deps.resolveRelayAuthConfig();
    if (!relayAuthApiKey || !isRelayAuthPathTokenUnauthorizedError(error)) {
      throw error;
    }

    deps.evictRelayAuthWorkspaceTokenCache({
      relayAuthApiKey,
      workspaceId: input.auth.workspaceId,
    });
    const freshWorkspaceToken = await deps.mintRelayAuthWorkspaceToken({
      workspaceId: input.auth.workspaceId,
      agentName: credential.displayName,
    });
    return deps.mintPathScopedRelayfileToken({
      ...baseOptions,
      workspaceToken: freshWorkspaceToken,
    });
  }
}

async function getBrokerConnection(
  sandbox: DaytonaSandbox,
  apiKey: string,
): Promise<{ execUrl: string; filesUrl: string; apiKey: string }> {
  if (!sandbox.getSignedPreviewUrl) {
    const url = sandbox.toolboxProxyUrl?.replace(/\/$/, "");
    if (!url) {
      throw new CloudAgentBoxError("Sandbox preview URL is unavailable", "box_not_running", 409);
    }
    return { execUrl: url, filesUrl: url, apiKey };
  }
  const preview = await sandbox.getSignedPreviewUrl(BROKER_PORT, URL_TTL_SECONDS);
  const execUrl = preview.url.replace(/\/$/, "");
  return { execUrl, filesUrl: execUrl, apiKey };
}

export async function writeBoxEnvFile(
  sandbox: DaytonaSandbox,
  home: string,
  envVars: Record<string, string>,
): Promise<void> {
  await sandbox.fs.uploadFile(
    Buffer.from(JSON.stringify(envVars, null, 2), "utf8"),
    `${home}/.cloud-agent-box-env.json`,
  );
}

// =====================================================================
// Mount creds file — box mount tokens are minted with a 1h TTL
// (DEFAULT_BOX_TIMEOUT_SECONDS), so any sandbox alive longer than that has a
// dead mount token and writeback stalls on "401 token has expired". The
// relayfile-mount daemon (creds-file-aware builds) re-reads this JSON file on
// 401, so rewriting it with a fresh token heals the mount without a restart.
// Old daemon builds ignore the RELAYFILE_MOUNT_CREDS_FILE env entirely (same
// version-skew contract as RELAYFILE_MOUNT_LOCAL_LAYOUT) — for them this file
// is inert and the legacy restart-based healing still applies.
// =====================================================================

export function boxMountCredsFilePath(home: string): string {
  return `${home}/.relayfile-mount-creds.json`;
}

/** Rewrite when the last-written token is older than half its 1h TTL. */
const BOX_MOUNT_CREDS_REFRESH_MS = (DEFAULT_BOX_TIMEOUT_SECONDS * 1000) / 2;

// In-memory throttle for GET-path refreshes, keyed by sandbox id. Worker
// isolates recycle, so this is best-effort: after a restart the first GET
// rewrites once (one cheap exec) and re-seeds the clock. Durable token age
// lives in the creds file itself (`mintedAt`), but reading it back would cost
// the same exec the throttle exists to avoid.
const boxMountCredsWrittenAtMs = new Map<string, number>();

/**
 * Atomically (tmp + rename) write the mount creds file the daemon re-reads on
 * 401. Format is the cross-leg contract shared with pear/relayfile:
 * `{token, mintedAt, expiresAt}` — token required, timestamps advisory.
 */
export async function writeBoxMountCredsFile(
  deps: CloudAgentBoxDeps,
  sandbox: DaytonaSandbox,
  home: string,
  token: string,
): Promise<void> {
  const now = deps.now();
  const path = boxMountCredsFilePath(home);
  const tmpPath = `${path}.tmp`;
  const payload = {
    token,
    mintedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + DEFAULT_BOX_TIMEOUT_SECONDS * 1000).toISOString(),
  };
  await sandbox.fs.uploadFile(
    Buffer.from(JSON.stringify(payload, null, 2), "utf8"),
    tmpPath,
  );
  // Rename so the daemon never observes a partial write; the daemon side
  // tolerates a parse failure by keeping its current token, so even a lost
  // race here is self-healing on the next refresh.
  const rename = await sandbox.process.executeCommand(
    `mv -f ${shellQuote(tmpPath)} ${shellQuote(path)}`,
    home,
  );
  if (rename.exitCode !== 0) {
    const output = daytonaCommandOutput(rename).trim();
    throw new Error(output || `failed to rename ${tmpPath} to ${path}`);
  }
  boxMountCredsWrittenAtMs.set(sandbox.id, now.getTime());
}

/** Failed/skipped refresh attempts retry after a short backoff, not a full window. */
const BOX_MOUNT_CREDS_RETRY_MS = 5 * 60_000;

/**
 * GET-path refresh hook: when the last write is older than half the token
 * TTL, mint a token scoped to the daemon's ACTIVE mount paths (the box env's
 * RELAYFILE_MOUNT_PATHS — i.e. post-PATCH state) and rewrite the creds file.
 *
 * The active scope matters: GET requests have no body, so the request-level
 * token is usually minted for the default /workspace scope. Writing THAT
 * token here after a PATCH widened the mounts would silently narrow the
 * daemon's credential and strand the integration mounts — the creds file
 * must always be scoped to what the daemon is actually syncing.
 *
 * Never throws — a refresh failure must not break a read; it retries after a
 * short backoff so a transient failure can't push the next attempt past the
 * token's remaining lifetime.
 */
export async function maybeRefreshBoxMountCreds(
  deps: CloudAgentBoxDeps,
  sandbox: DaytonaSandbox,
  input: CloudAgentBoxInput,
  credential: ProviderCredentialRow,
): Promise<void> {
  const nowMs = deps.now().getTime();
  const last = boxMountCredsWrittenAtMs.get(sandbox.id);
  if (last !== undefined && nowMs - last < BOX_MOUNT_CREDS_REFRESH_MS) {
    return;
  }
  try {
    const home = (await sandbox.getUserHomeDir?.()) ?? "/home/daytona";
    const activePaths = mountPathsFromEnv(await readBoxEnvFile(sandbox, home) ?? {});
    const mountPaths = activePaths && activePaths.length > 0
      ? activePaths
      : normalizeMountPaths(input.mountPaths, input.workspaceSource);
    const token = await mintRelayfileToken(deps, input, credential, mountPaths);
    await writeBoxMountCredsFile(deps, sandbox, home, token);
  } catch (error) {
    // Back off briefly instead of waiting a full window: the throttle clock is
    // pushed forward so the next read retries in BOX_MOUNT_CREDS_RETRY_MS.
    boxMountCredsWrittenAtMs.set(
      sandbox.id,
      nowMs - BOX_MOUNT_CREDS_REFRESH_MS + BOX_MOUNT_CREDS_RETRY_MS,
    );
    logger.warn("[cloud-agent-box] mount creds refresh failed; will retry on a later read", {
      area: "cloud-agent-box",
      sandboxId: sandbox.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Test seam: reset the in-memory refresh throttle. */
export function resetBoxMountCredsThrottleForTesting(): void {
  boxMountCredsWrittenAtMs.clear();
}

async function syncGitWorkspaceSource(
  deps: CloudAgentBoxDeps,
  input: CloudAgentBoxInput,
  sandbox: DaytonaSandbox,
  home: string,
  source: CloudAgentGitWorkspaceSource,
): Promise<void> {
  const remoteUrl = normalizeHttpsGitRemote(source.remoteUrl);
  if (!remoteUrl) {
    throw new CloudAgentBoxError(
      "Git workspace source must use an HTTPS remote",
      "invalid_request",
      400,
    );
  }

  const targetDir = workspaceTargetDir(source);
  const gitCredentials = await deps.resolveGitCloneCredentials({
    userId: input.auth.userId,
    workspaceId: input.auth.workspaceId,
    remoteUrl,
  });
  const askpassPath = `${home}/.cloud-agent-git-askpass`;
  const command = buildGitWorkspaceSyncShell({
    source: {
      remoteUrl,
      targetDir,
      ref: source.ref,
      commit: source.commit,
      shallow: source.shallow,
    },
    credentials: gitCredentials
      ? { username: gitCredentials.username, tokenEnvKey: "GIT_CLONE_TOKEN" }
      : null,
    askpassPath,
  });
  const result = await sandbox.process.executeCommand(
    command,
    home,
    gitCredentials
      ? {
          GIT_CLONE_USERNAME: gitCredentials.username,
          GIT_CLONE_TOKEN: gitCredentials.token,
        }
      : undefined,
    300,
  );
  if (result.exitCode !== 0) {
    const output = daytonaCommandOutput(result).trim();
    logger.error("[cloud-agent-box] git workspace sync failed", {
      area: "cloud-agent-box",
      sandboxId: sandbox.id,
      targetDir,
      output: output.slice(-1200),
    });
    throw new CloudAgentBoxError(
      output
        ? `Cloud agent box git workspace sync failed: ${output.slice(-500)}`
        : "Cloud agent box git workspace sync failed",
      "box_warm_failed",
      503,
    );
  }
}

async function ensureDirectGitRelayfileMountRoots(
  sandbox: DaytonaSandbox,
  home: string,
  mountPaths: string[],
): Promise<void> {
  const roots = Array.from(new Set(
    mountPaths
      .map((path) => path.trim().replace(/\/+$/u, ""))
      .filter((path) => path.startsWith("/"))
      .map((path) => `/${path.slice(1).split("/")[0]}`)
      .filter((path) => path !== "/"),
  ));
  if (roots.length === 0) return;
  const quotedRoots = roots.map(shellQuote).join(" ");
  const command = [
    "set -euo pipefail",
    `for dir in ${quotedRoots}; do`,
    "  mkdir -p \"$dir\" 2>/dev/null || sudo mkdir -p \"$dir\"",
    "  chown \"$(id -u):$(id -g)\" \"$dir\" 2>/dev/null || sudo chown \"$(id -u):$(id -g)\" \"$dir\"",
    "done",
  ].join("\n");
  const result = await sandbox.process.executeCommand(command, home, undefined, 60);
  if (result.exitCode !== 0) {
    const output = daytonaCommandOutput(result).trim();
    throw new CloudAgentBoxError(
      output
        ? `Cloud agent box integration mount root setup failed: ${output.slice(-500)}`
        : "Cloud agent box integration mount root setup failed",
      "box_warm_failed",
      503,
    );
  }
}

export async function ensureBrokerReady(
  sandbox: DaytonaSandbox,
  home: string,
  envVars: Record<string, string>,
  apiKey: string,
): Promise<void> {
  // ensure-broker's exec calls go through the Daytona proxy (proxy.app.daytona.io),
  // whose 120s read timeout surfaces as a Cloudflare 524 if a single exec hangs
  // (observed on a contaminated/slow box). Put a short client-side timeout
  // around each exec so we fail fast instead of waiting for the proxy's 120s
  // timeout, then retry the idempotent execs in-step. The backgrounded
  // broker-start `nohup` below is fail-fast only, not retried; it is
  // non-idempotent, and a queue-level retry will hit the leading health check.
  const existing = await retryOnDaytonaUpstreamTimeout(
    "ensure-broker:health-precheck",
    () => withDaytonaExecFailFast(
      "ensure-broker:health-precheck",
      () => sandbox.process.executeCommand(
        `curl -sf http://127.0.0.1:${BROKER_PORT}/health 2>/dev/null`,
        home,
      ),
    ),
  );
  if (existing.exitCode === 0) {
    return;
  }

  const depsCheck = await retryOnDaytonaUpstreamTimeout(
    "ensure-broker:deps-check",
    () => withDaytonaExecFailFast(
      "ensure-broker:deps-check",
      () => sandbox.process.executeCommand(
        'node -e "require(\'@agent-relay/sdk\')" 2>/dev/null',
        home,
      ),
    ),
  );
  let npmInstallOutput = "";
  if (depsCheck.exitCode !== 0) {
    const install = await retryOnDaytonaUpstreamTimeout(
      "ensure-broker:npm-install",
      () => withDaytonaExecFailFast(
        "ensure-broker:npm-install",
        () => sandbox.process.executeCommand(
          `cd ${shellQuote(home)} && npm init -y 2>/dev/null && npm install @agent-relay/sdk 2>&1 | tail -3`,
          home,
          undefined,
          120,
        ),
      ),
    );
    npmInstallOutput = daytonaCommandOutput(install).trim();
    if (install.exitCode !== 0) {
      logger.error("[cloud-agent-box] npm install @agent-relay/sdk failed", {
        exitCode: install.exitCode,
        output: npmInstallOutput,
      });
      throw new CloudAgentBoxError(
        npmInstallOutput
          ? `Cloud agent box broker failed to install SDK: ${npmInstallOutput.slice(-400)}`
          : "Cloud agent box broker failed to install SDK",
        "box_warm_failed",
        503,
      );
    }
  }

  const exports = Object.entries({
    ...envVars,
    RELAY_BROKER_API_KEY: apiKey,
    TERM: "xterm-256color",
  })
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join(" && ");
  // The broker command is split into two executeCommand calls so the
  // BROKER resolution step's stderr is captured separately from the
  // backgrounded `nohup ... &`. Previously, a `node -e "...require.resolve..."`
  // failure (e.g. SDK not installed, missing platform binary in bin/)
  // would silently set `BROKER=""`, the `&&` chain would short-circuit,
  // `nohup` would never run, broker.log would never be created, and the
  // resulting error would be a bare "Cloud agent box broker failed to
  // start" with zero clue why.
  const resolveBroker = await retryOnDaytonaUpstreamTimeout(
    "ensure-broker:resolve-binary",
    () => withDaytonaExecFailFast(
      "ensure-broker:resolve-binary",
      () => sandbox.process.executeCommand(
        `node -e "const p=require('path');const r=require.resolve('@agent-relay/sdk');const suffix=process.platform+'-'+process.arch;const target=p.join(p.dirname(r),'..','bin','agent-relay-broker-'+suffix);const fs=require('fs');if(!fs.existsSync(target)){console.error('broker binary missing at '+target);process.exit(2);}console.log(target);" 2>&1`,
        home,
      ),
    ),
  );
  const resolveOutput = daytonaCommandOutput(resolveBroker).trim();
  if (resolveBroker.exitCode !== 0 || !resolveOutput) {
    logger.error("[cloud-agent-box] broker binary resolution failed", {
      exitCode: resolveBroker.exitCode,
      output: resolveOutput || "(no output)",
      npmInstallOutput: npmInstallOutput || "(skipped)",
    });
    throw new CloudAgentBoxError(
      resolveOutput
        ? `Cloud agent box broker failed to start: could not resolve broker binary: ${resolveOutput.slice(-400)}`
        : "Cloud agent box broker failed to start: could not resolve broker binary (no output from resolver)",
      "box_warm_failed",
      503,
    );
  }
  const brokerPath = resolveOutput.split("\n").pop()!.trim();

  // --persist disables the owner-lease auto-shutdown. Without it the broker
  // self-terminates 120s after start unless a client renews the lease, which
  // races every cloud-agent attach: the warm task starts the broker, the DB
  // row flips to "running", and Pear has < 120s to receive the ready response
  // and call /api/session/renew. If anything in between (background-task
  // wakeup, network, retries, Pear's own warm poll) eats too much time, the
  // broker is already dead by the time the client connects and the GET poll
  // keeps returning warming until Pear's own timeout fires. Persisting the
  // broker makes the cloud lifecycle owned by Daytona's autoStopInterval
  // (DEFAULT_BOX_TIMEOUT_SECONDS) instead of an owner-lease race.
  const brokerArgs = [
    "init",
    "--persist",
    "--api-port",
    String(BROKER_PORT),
    "--api-bind",
    "0.0.0.0",
    ...(envVars.AGENT_RELAY_BROKER_NAME
      ? ["--instance-name", envVars.AGENT_RELAY_BROKER_NAME]
      : []),
    "--name",
    envVars.RELAY_AGENT_NAME ?? "cloud-agent",
  ].map(shellQuote).join(" ");
  const brokerCmd = [
    exports,
    `nohup ${shellQuote(brokerPath)} ${brokerArgs} > ${shellQuote(`${home}/broker.log`)} 2>&1 &`,
  ].join(" && ");

  await withDaytonaExecFailFast(
    "ensure-broker:start",
    () => sandbox.process.executeCommand(brokerCmd, home),
  );

  // Health-check timeout extended to 60s (was 15s). Repeated
  // observation: the broker process IS running (broker.log contains
  // 60-90+ seconds of heartbeats) but `curl 127.0.0.1:${BROKER_PORT}/health`
  // never succeeds within the original 15s window. Either the broker
  // takes longer than 15s to fully bind the API port, or it's binding
  // to a different port than --api-port requested. The longer window
  // gives slow-startup cases a chance to succeed; the post-timeout
  // diagnostic below pinpoints port mismatches.
  for (let i = 0; i < 60; i++) {
    const check = await withDaytonaExecFailFast(
      "ensure-broker:health-poll",
      () => sandbox.process.executeCommand(
        `curl -sf http://127.0.0.1:${BROKER_PORT}/health 2>/dev/null`,
        home,
      ),
    );
    if (check.exitCode === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Health check timed out. Capture three things to disambiguate:
  //   1. broker.log content (startup section, not just tail — the
  //      "API listener bound on X.X.X.X:PORT" line tells us if the
  //      broker actually used --api-port).
  //   2. The bound-port line specifically, grepped from broker.log.
  //   3. A snapshot of what's listening on 0.0.0.0:* via `ss` so we
  //      can see whether the broker actually bound the expected port
  //      and whether something else is squatting on it.
  // Without these, a missing `/health` line and a generic timeout
  // tells us nothing — each previous round we had to guess.
  const logProbe = await withDaytonaExecFailFast(
    "ensure-broker:diagnostics",
    () => sandbox.process.executeCommand(
      `head -c 4096 ${shellQuote(`${home}/broker.log`)} 2>/dev/null; echo "--- ... ---"; tail -c 4096 ${shellQuote(`${home}/broker.log`)} 2>/dev/null; echo "--- bound-port lines ---"; grep -F "bound on" ${shellQuote(`${home}/broker.log`)} 2>/dev/null; echo "--- listening sockets ---"; ss -tlnp 2>/dev/null | head -30; true`,
      home,
    ),
  );
  const brokerLog = daytonaCommandOutput(logProbe).trim();
  logger.error("[cloud-agent-box] broker failed to start", {
    brokerLogTail: brokerLog || "(empty or unreadable)",
  });
  throw new CloudAgentBoxError(
    brokerLog
      ? `Cloud agent box broker failed to start: ${brokerLog.slice(-1400)}`
      : "Cloud agent box broker failed to start",
    "box_warm_failed",
    503,
  );
}

export async function buildRuntimeEnv(
  deps: CloudAgentBoxDeps,
  input: CloudAgentBoxInput,
  credential: ProviderCredentialRow,
  relayfileToken: string,
  mountPaths: string[],
): Promise<{ envVars: Record<string, string>; credentialSecret: string | null }> {
  const credentialSecret = await deps.getCredentialSecret({ auth: input.auth, credential });
  const relayfile = deps.resolveRelayfileConfig();
  const directEnv =
    credential.authType === "byo_api_key"
      ? directCredentialEnv(credential.modelProvider, credentialSecret)
      : {};
  if (
    (credential.authType === "byo_api_key" && Object.keys(directEnv).length === 0) ||
    (credential.authType !== "byo_api_key" && !credentialSecret)
  ) {
    throw new CloudAgentBoxError(
      "Cloud agent credential material is unavailable",
      "credential_unavailable",
      409,
    );
  }

  return {
    credentialSecret,
    envVars: {
      ...directEnv,
      RELAY_AGENT_HARNESS: credential.harness,
      RELAY_DEFAULT_MODEL: credential.defaultModel ?? "",
      RELAY_MODEL_PROVIDER: credential.modelProvider,
      RELAY_AGENT_NAME: credential.displayName,
      RELAY_DEFAULT_WORKSPACE: input.auth.workspaceId,
      RELAY_WORKSPACE_ID: input.auth.workspaceId,
      RELAYFILE_WORKSPACE: input.auth.workspaceId,
      RELAYFILE_WORKSPACE_ID: input.auth.workspaceId,
      RELAYFILE_URL: relayfile.relayfileUrl,
      RELAYFILE_TOKEN: relayfileToken,
      RELAYFILE_MOUNT_PATHS: JSON.stringify(mountPaths),
      // #125: verbatim pass-through — the caller (pear) is the naming
      // authority; cloud never derives or rewrites broker identity.
      ...(input.workspaceKey ? { AGENT_RELAY_WORKSPACE_KEY: input.workspaceKey } : {}),
      ...(input.brokerName ? { AGENT_RELAY_BROKER_NAME: input.brokerName } : {}),
      PEAR_WORKSPACE_SOURCE_KIND: workspaceSourceKind(input.workspaceSource),
      PEAR_WORKSPACE_DIR: primaryMountPath(mountPaths, input.workspaceSource),
      ...(isGitWorkspaceSource(input.workspaceSource)
        ? {
          PEAR_WORKSPACE_GIT_REMOTE: input.workspaceSource.remoteUrl,
          PEAR_WORKSPACE_GIT_REF: input.workspaceSource.ref ?? "",
          PEAR_WORKSPACE_GIT_COMMIT: input.workspaceSource.commit ?? "",
          PEAR_WORKSPACE_GIT_REASON: input.workspaceSource.largeReason ?? "",
        }
        : {}),
    },
  };
}

function relayfileMountConfig(
  envVars: Record<string, string>,
  mountPaths: string[],
  workspaceSource?: CloudAgentWorkspaceSource,
  credsFilePath?: string,
): RelayfileMountDaemonOptions {
  return relayfileMountConfigFromParts({
    baseUrl: envVars.RELAYFILE_URL,
    workspaceId: envVars.RELAYFILE_WORKSPACE_ID,
    token: envVars.RELAYFILE_TOKEN,
    mountPaths,
    localDir: isDirectGitWorkspaceSource(workspaceSource) ? DIRECT_GIT_RELAYFILE_LOCAL_DIR : DEFAULT_MOUNT_LOCAL_DIR,
    credsFilePath,
  });
}

function relayfileMountConfigFromParts(input: {
  baseUrl: string;
  workspaceId: string;
  token: string;
  mountPaths: string[];
  localDir?: string;
  credsFilePath?: string;
}): RelayfileMountDaemonOptions {
  return {
    baseUrl: input.baseUrl,
    workspaceId: input.workspaceId,
    localDir: input.localDir ?? DEFAULT_MOUNT_LOCAL_DIR,
    token: input.token,
    interval: "3s",
    paths: input.mountPaths,
    websocket: false,
    ...(input.credsFilePath ? { credsFilePath: input.credsFilePath } : {}),
  };
}

// =====================================================================
// Warm step functions — issue #1384 slice 1 (pure extraction, NO
// behaviour change).
//
// The async warm path (warmCloudAgentBoxToReady -> prepareSandbox) is the
// ordered sequence of effects that brings a cloud-agent box to "ready".
// Slice 2+ will drive these same steps from a queue-backed
// chunked-continuation consumer, so each step is extracted as an
// individually-callable, IDEMPOTENT function: re-running a step against an
// already-prepared sandbox produces the same outcome without throwing. The
// bodies are moved verbatim from prepareSandbox/warmCloudAgentBoxToReady —
// same order, same effects, same error policy. prepareSandbox is now the
// thin sequential composition of these steps.
// =====================================================================

/**
 * Warm step (ensure-sandbox helper): start the sandbox process if Daytona
 * reports it stopped. Idempotent — a no-op when the sandbox is not stopped,
 * so it is safe to rerun. Shared by the reuse and adopt paths.
 */
export async function ensureSandboxStarted(
  daytona: DaytonaClient,
  sandbox: DaytonaSandbox,
  rowStatus?: string,
): Promise<void> {
  if (boxStatusFromState(sandbox.state, rowStatus) !== "stopped") {
    return;
  }
  await retryOnDaytonaUpstreamTimeout("daytona.start", async () => {
    if (daytona.start) {
      await daytona.start(sandbox, MAX_CREATE_TIMEOUT_SECONDS);
    } else {
      await sandbox.start?.(MAX_CREATE_TIMEOUT_SECONDS);
    }
  });
}

/**
 * Warm step (ensure-sandbox): create the sticky sandbox, or adopt the
 * existing one when its name is already taken (a DB-drifted box), starting it
 * if stopped. Returns the sandbox plus the id of a freshly *created* sandbox
 * (null when adopted) so the caller rolls back only boxes this request
 * created. Idempotent by sandbox name: a rerun hits the name conflict and
 * adopts the same sandbox instead of creating a duplicate.
 */
export async function createOrAdoptStickySandbox(
  deps: CloudAgentBoxDeps,
  daytona: DaytonaClient,
  input: CloudAgentBoxInput,
  credential: ProviderCredentialRow,
  envVars: Record<string, string>,
): Promise<{ sandbox: DaytonaSandbox; createdSandboxId: string | null }> {
  const snapshot = await snapshotNameForCloudAgentBox(deps, credential);
  const sandboxName = buildStickySandboxName({
    displayName: credential.displayName,
    cloudAgentId: credential.id,
  });
  try {
    const sandbox = await retryOnDaytonaUpstreamTimeout(
      "daytona.create",
      () => daytona.create(
        {
          snapshot,
          language: "typescript",
          name: sandboxName,
          envVars,
          autoStopInterval: Math.ceil(DEFAULT_BOX_TIMEOUT_SECONDS / 60),
          labels: {
            source: "cloud-agent",
            workspaceId: input.auth.workspaceId,
            cloudAgentId: credential.id,
          },
        },
        { timeout: MAX_CREATE_TIMEOUT_SECONDS },
      ),
    );
    // Only freshly created sandboxes are eligible for rollback-on-failure —
    // an adopted box predates this request and must not be deleted.
    return { sandbox, createdSandboxId: sandbox.id };
  } catch (error) {
    if (!isDaytonaNameConflict(error)) throw error;
    // A Daytona sandbox already owns this name. Because the name encodes the
    // cloudAgentId, the owner can only be this same cloud agent's box that
    // drifted out of our DB (a swept row, or a detach that failed to delete
    // it). Adopt it by name instead of failing the attach.
    logger.warn("Cloud agent box name conflict — adopting existing sandbox", {
      area: "cloud-agent-box",
      workspaceId: input.auth.workspaceId,
      cloudAgentId: credential.id,
      sandboxName,
    });
    const adopted = await retryOnDaytonaUpstreamTimeout(
      "daytona.get(byName)",
      () => daytona.get(sandboxName),
    );
    await ensureSandboxStarted(daytona, adopted);
    return { sandbox: adopted, createdSandboxId: null };
  }
}

function usesLiteSnapshot(credential: ProviderCredentialRow): boolean {
  return credential.authType === "byo_api_key";
}

async function snapshotNameForCloudAgentBox(
  deps: CloudAgentBoxDeps,
  credential: ProviderCredentialRow,
): Promise<string> {
  return usesLiteSnapshot(credential)
    ? deps.getLiteSnapshotName()
    : deps.getSnapshotName();
}

/**
 * Warm step (mount-credentials): mount CLI credentials into the sandbox.
 * No-op for BYO-key credentials. Idempotent — re-uploading the same
 * credential material is harmless.
 */
export async function mountBoxCredentials(
  deps: CloudAgentBoxDeps,
  sandbox: DaytonaSandbox,
  home: string,
  credential: ProviderCredentialRow,
  credentialSecret: string | null,
): Promise<void> {
  if (credential.authType !== "byo_api_key" && credentialSecret) {
    await deps.mountCliCredentials(
      sandbox as never,
      home,
      credentialSecret,
      resolveCredentialProviderFromCli(credential.harness) as ProviderId,
    );
  }
}

/**
 * Warm step (flush-relayfile): flush any active relayfile mount before
 * (re)starting it. Best-effort and idempotent — a flush failure is logged and
 * swallowed.
 */
export async function flushBoxRelayfileMount(
  deps: CloudAgentBoxDeps,
  sandbox: DaytonaSandbox,
  home: string,
  input: CloudAgentBoxInput,
  credential: ProviderCredentialRow,
): Promise<void> {
  try {
    await flushActiveRelayfileMount({
      deps,
      sandbox,
      sandboxHome: home,
      request: input,
      credential,
    });
  } catch (error) {
    logger.warn("[cloud-agent-box] relayfile mount flush before warm restart failed; continuing", {
      area: "cloud-agent-box",
      workspaceId: input.auth.workspaceId,
      cloudAgentId: credential.id,
      sandboxId: sandbox.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Warm step (sync-git): clone/refresh the git workspace source into the
 * sandbox. No-op unless the request carries a git source. Idempotent — the
 * underlying sync re-points the remote and fetches/clones as needed.
 */
export async function syncBoxGitWorkspace(
  deps: CloudAgentBoxDeps,
  input: CloudAgentBoxInput,
  sandbox: DaytonaSandbox,
  home: string,
): Promise<void> {
  if (isGitWorkspaceSource(input.workspaceSource)) {
    await syncGitWorkspaceSource(deps, input, sandbox, home, input.workspaceSource);
  }
}

/**
 * Warm step (prepare-git-overlay-roots): pre-create integration mount roots
 * for a direct-git workspace source (kind "git", per
 * isDirectGitWorkspaceSource). No-op for git-overlay/relayfile sources.
 * Idempotent — mkdir -p / chown.
 */
export async function prepareBoxGitOverlayRoots(
  input: CloudAgentBoxInput,
  sandbox: DaytonaSandbox,
  home: string,
  mountPaths: string[],
): Promise<void> {
  if (isDirectGitWorkspaceSource(input.workspaceSource)) {
    await ensureDirectGitRelayfileMountRoots(sandbox, home, mountPaths);
  }
}

/**
 * Warm step (start-relayfile-mount): start the relayfile FUSE mount. For git /
 * git-overlay sources a startup failure is fatal; otherwise it is logged and
 * the box continues without FUSE. Idempotent — restarting the mount daemon
 * replaces the prior one.
 */
export async function startBoxRelayfileMount(
  deps: CloudAgentBoxDeps,
  input: CloudAgentBoxInput,
  sandbox: DaytonaSandbox,
  home: string,
  credential: ProviderCredentialRow,
  envVars: Record<string, string>,
  mountPaths: string[],
): Promise<void> {
  try {
    // Seed the creds file before the daemon starts so a creds-aware binary can
    // heal its first in-session token expiry without any cloud round-trip.
    await writeBoxMountCredsFile(deps, sandbox, home, envVars.RELAYFILE_TOKEN);
    await deps.startRelayfileMount({
      sandbox,
      sandboxHome: home,
      config: relayfileMountConfig(
        envVars,
        mountPaths,
        input.workspaceSource,
        boxMountCredsFilePath(home),
      ),
    });
  } catch (error) {
    if (input.workspaceSource?.kind === "git" && mountPaths.length > 0) {
      throw error;
    }
    if (input.workspaceSource?.kind === "git-overlay") {
      throw error;
    }
    logger.warn("[cloud-agent-box] relayfile mount startup failed; continuing without FUSE", {
      area: "cloud-agent-box",
      workspaceId: input.auth.workspaceId,
      cloudAgentId: credential.id,
      sandboxId: sandbox.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Warm step (finalize): resolve the broker connection and assemble the ready
 * response. Idempotent — getBrokerConnection only reads a signed preview URL.
 * apiKey is passed in so it is derived once and shared with ensure-broker.
 */
export async function finalizeBoxConnection(
  sandbox: DaytonaSandbox,
  apiKey: string,
  relayfileToken: string,
  mountPaths: string[],
  workspaceSource: CloudAgentWorkspaceSource | undefined,
): Promise<{ response: CloudAgentBoxResponse; status: string }> {
  const connection = await getBrokerConnection(sandbox, apiKey);
  return {
    status: "running",
    response: {
      sandboxId: sandbox.id,
      status: "ready",
      relayfileToken,
      relayfileMountPath: primaryMountPath(mountPaths, workspaceSource),
      phase: "ready",
      etaMs: 0,
      ...connection,
    },
  };
}

async function prepareSandbox(
  deps: CloudAgentBoxDeps,
  sandbox: DaytonaSandbox,
  input: CloudAgentBoxInput,
  credential: ProviderCredentialRow,
  relayfileToken: string,
  mountPaths: string[],
): Promise<{ response: CloudAgentBoxResponse; status: string }> {
  const home = (await sandbox.getUserHomeDir?.()) ?? "/home/daytona";
  // build-env
  const { envVars, credentialSecret } = await buildRuntimeEnv(
    deps,
    input,
    credential,
    relayfileToken,
    mountPaths,
  );
  await mountBoxCredentials(deps, sandbox, home, credential, credentialSecret);
  await flushBoxRelayfileMount(deps, sandbox, home, input, credential);
  await syncBoxGitWorkspace(deps, input, sandbox, home);
  await prepareBoxGitOverlayRoots(input, sandbox, home, mountPaths);
  await startBoxRelayfileMount(deps, input, sandbox, home, credential, envVars, mountPaths);
  await writeBoxEnvFile(sandbox, home, envVars);
  const apiKey = deps.deriveBrokerApiKey(deps.getBrokerKeySecret(), sandbox.id);
  await ensureBrokerReady(sandbox, home, envVars, apiKey);
  return finalizeBoxConnection(sandbox, apiKey, relayfileToken, mountPaths, input.workspaceSource);
}

export async function loadCredentialOrThrow(
  deps: CloudAgentBoxDeps,
  input: CloudAgentBoxInput,
  options: { requireUsable?: boolean } = { requireUsable: true },
): Promise<ProviderCredentialRow> {
  if (input.urlWorkspaceId && input.urlWorkspaceId !== input.auth.workspaceId) {
    logger.info("Cloud agent box route ignored advisory workspaceId", {
      route: "/api/v1/workspaces/[workspaceId]/cloud-agents/[cloudAgentId]/box",
      advisoryWorkspaceId: input.urlWorkspaceId,
      effectiveWorkspaceId: input.auth.workspaceId,
      cloudAgentId: input.cloudAgentId,
    });
  }

  const credential = await deps.findCredential({
    auth: input.auth,
    cloudAgentId: input.cloudAgentId,
  });
  if (!credential) {
    throw new CloudAgentBoxError("Cloud agent not found", "cloud_agent_not_found", 404);
  }
  if (options.requireUsable !== false) {
    assertUsableCredential(credential, deps.now());
  }
  return credential;
}

export async function warmCloudAgentBox(
  deps: CloudAgentBoxDeps,
  input: CloudAgentBoxInput,
): Promise<CloudAgentBoxResponse> {
  return deps.withCloudAgentBoxLock({
    workspaceId: input.auth.workspaceId,
    cloudAgentId: input.cloudAgentId,
  }, async () => warmCloudAgentBoxToReady(deps, input));
}

async function warmCloudAgentBoxToReady(
  deps: CloudAgentBoxDeps,
  input: CloudAgentBoxInput,
  options: { placeholderSandboxId?: string; allowExistingWarming?: boolean } = {},
): Promise<CloudAgentBoxResponse> {
  input = withExplicitWorkspaceSource(input);
  const mountPaths = normalizeMountPaths(input.mountPaths, input.workspaceSource);
  const credential = await loadCredentialOrThrow(deps, input);
  let relayfileToken = await mintRelayfileToken(deps, input, credential, mountPaths);
  const daytona = deps.createDaytonaClient();

  const existing = await deps.findStickySandbox({
    workspaceId: input.auth.workspaceId,
    cloudAgentId: credential.id,
  });
  if (
    existing &&
    existing.status === "warming" &&
    !options.placeholderSandboxId &&
    !options.allowExistingWarming
  ) {
    throw new CloudAgentBoxError(
      "Cloud agent box is already warming",
      "box_already_warming",
      423,
    );
  }

  // When the sticky Daytona box has vanished out-of-band (destroyed/evicted),
  // the row is stale: re-provision fresh and re-point this row at the new
  // sandbox id rather than bricking the agent.
  let staleStickyId: string | null = null;
  if (existing && !isWarmingPlaceholderId(existing.id)) {
    try {
      const sandbox = await retryOnDaytonaUpstreamTimeout(
        "daytona.get(existing)",
        () => daytona.get(existing.id),
      );
      await ensureSandboxStarted(daytona, sandbox, existing.status);
      if (keepaliveActive(existing, deps.now())) {
        const home = (await sandbox.getUserHomeDir?.()) ?? "/home/daytona";
        const existingEnv = await readBoxEnvFile(sandbox, home);
        if (!input.workspaceSource && existingEnv) {
          const envSource = workspaceSourceFromEnv(existingEnv);
          if (envSource) {
            input = { ...input, workspaceSource: envSource };
            rememberWorkspaceSource(input);
          }
        }
        const desiredMountPaths = normalizeMountPaths(input.mountPaths, input.workspaceSource);
        const existingMountPaths = existingEnv ? mountPathsFromEnv(existingEnv) : null;
        const existingWorkspaceSource = existingEnv ? workspaceSourceFromEnv(existingEnv) : undefined;
        if (
          existingMountPaths &&
          sameMountPaths(existingMountPaths, desiredMountPaths) &&
          sameWorkspaceSource(existingWorkspaceSource, input.workspaceSource)
        ) {
          if (!sameMountPaths(mountPaths, desiredMountPaths)) {
            relayfileToken = await mintRelayfileToken(deps, input, credential, desiredMountPaths);
          }
          const apiKey = deps.deriveBrokerApiKey(deps.getBrokerKeySecret(), sandbox.id);
          const finalized = await finalizeBoxConnection(
            sandbox,
            apiKey,
            relayfileToken,
            desiredMountPaths,
            input.workspaceSource,
          );
          await deps.updateSandbox({
            sandboxId: sandbox.id,
            workspaceId: input.auth.workspaceId,
            status: finalized.status,
            brokerPort: BROKER_PORT,
            error: null,
            expectedReadyBy: null,
            keepaliveUntil: null,
          });
          await deps.markCredentialUsed(credential.id);
          return finalized.response;
        }
      }
      const prepared = await prepareSandbox(
        deps,
        sandbox,
        input,
        credential,
        relayfileToken,
        mountPaths,
      );
      await deps.updateSandbox({
        sandboxId: sandbox.id,
        workspaceId: input.auth.workspaceId,
        status: prepared.status,
        brokerPort: BROKER_PORT,
        error: null,
        expectedReadyBy: null,
      });
      await deps.markCredentialUsed(credential.id);
      return prepared.response;
    } catch (error) {
      if (isDaytonaNotFound(error)) {
        // The Daytona sandbox is gone but the sticky row survived. Treat the
        // row as stale and fall through to provision a fresh sandbox (the row
        // is re-pointed at the new id below), instead of marking it failed and
        // permanently bricking the agent. NOT-FOUND only — transient upstream
        // errors already retried via retryOnDaytonaUpstreamTimeout and rethrow.
        logger.warn("[cloud-agent-box] sticky sandbox vanished; re-provisioning fresh", {
          area: "cloud-agent-box",
          workspaceId: input.auth.workspaceId,
          cloudAgentId: credential.id,
          staleSandboxId: existing.id,
        });
        staleStickyId = existing.id;
      } else {
        await deps.updateSandbox({
          sandboxId: existing.id,
          workspaceId: input.auth.workspaceId,
          status: "failed",
          error: backgroundErrorMessage(error),
          expectedReadyBy: null,
        });
        throw error;
      }
    }
  }

  let createdSandboxId: string | null = null;
  let persistedSandboxId: string | null = null;
  try {
    const { envVars } = await buildRuntimeEnv(deps, input, credential, relayfileToken, mountPaths);
    const { sandbox, createdSandboxId: created } = await createOrAdoptStickySandbox(
      deps,
      daytona,
      input,
      credential,
      envVars,
    );
    createdSandboxId = created;
    if (options.placeholderSandboxId) {
      await deps.replaceSandboxId({
        oldSandboxId: options.placeholderSandboxId,
        newSandboxId: sandbox.id,
        workspaceId: input.auth.workspaceId,
        status: "warming",
        brokerPort: null,
        error: null,
        expectedReadyBy: expectedReadyBy(deps, REAL_SANDBOX_WARM_DEADLINE_MS),
      });
      persistedSandboxId = sandbox.id;
    } else if (staleStickyId && staleStickyId !== sandbox.id) {
      // Re-point the stale sticky row (whose Daytona box vanished) at the
      // freshly provisioned sandbox so subsequent GET/stop/start reuse it.
      await deps.replaceSandboxId({
        oldSandboxId: staleStickyId,
        newSandboxId: sandbox.id,
        workspaceId: input.auth.workspaceId,
        status: "warming",
        brokerPort: null,
        error: null,
        expectedReadyBy: expectedReadyBy(deps, REAL_SANDBOX_WARM_DEADLINE_MS),
      });
      persistedSandboxId = sandbox.id;
    }
    const prepared = await prepareSandbox(
      deps,
      sandbox,
      input,
      credential,
      relayfileToken,
      mountPaths,
    );
    if (persistedSandboxId) {
      await deps.updateSandbox({
        sandboxId: persistedSandboxId,
        workspaceId: input.auth.workspaceId,
        status: prepared.status,
        brokerPort: BROKER_PORT,
        error: null,
        expectedReadyBy: null,
      });
    } else {
      await deps.insertSandbox({
        sandboxId: sandbox.id,
        auth: input.auth,
        workspaceId: input.auth.workspaceId,
        cloudAgentId: credential.id,
        brokerPort: BROKER_PORT,
        status: prepared.status,
        error: null,
        expectedReadyBy: null,
      });
    }
    await deps.markCredentialUsed(credential.id);
    logger.info("Cloud agent box warmed", {
      area: "cloud-agent-box",
      workspaceId: input.auth.workspaceId,
      cloudAgentId: credential.id,
      sandboxId: sandbox.id,
    });
    return prepared.response;
  } catch (error) {
    if (createdSandboxId) {
      try {
        const sandbox = await daytona.get(createdSandboxId);
        await daytona.delete?.(sandbox);
      } catch (cleanupError) {
        logger.warn("Failed to roll back cloud agent box sandbox", {
          area: "cloud-agent-box",
          sandboxId: createdSandboxId,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
    }
    if (persistedSandboxId || options.placeholderSandboxId) {
      await deps.updateSandbox({
        sandboxId: persistedSandboxId ?? options.placeholderSandboxId!,
        workspaceId: input.auth.workspaceId,
        status: "failed",
        error: backgroundErrorMessage(error),
        expectedReadyBy: null,
      });
    }
    throw error;
  }
}

export async function startCloudAgentBoxWarm(
  deps: CloudAgentBoxDeps,
  input: CloudAgentBoxInput,
): Promise<CloudAgentBoxWarmStartResult> {
  input = withExplicitWorkspaceSource(input);
  const mountPaths = normalizeMountPaths(input.mountPaths, input.workspaceSource);
  const credential = await loadCredentialOrThrow(deps, input);
  const relayfileToken = await mintRelayfileToken(deps, input, credential, mountPaths);
  return deps.withCloudAgentBoxLock({
    workspaceId: input.auth.workspaceId,
    cloudAgentId: credential.id,
  }, async () => {
    const existing = await deps.findStickySandbox({
      workspaceId: input.auth.workspaceId,
      cloudAgentId: credential.id,
    });

    if (existing?.status === "running") {
      const daytona = deps.createDaytonaClient();
      try {
        const sandbox = await retryOnDaytonaUpstreamTimeout(
          "daytona.get(existing-async-warm)",
          () => daytona.get(existing.id),
        );
        if (boxStatusFromState(sandbox.state, existing.status) === "ready") {
          return {
            response: await readCloudAgentBox(deps, input),
            status: 200 as const,
          };
        }
      } catch (error) {
        logger.warn("[cloud-agent-box] async warm could not verify running sandbox; scheduling restart", {
          area: "cloud-agent-box",
          workspaceId: input.auth.workspaceId,
          cloudAgentId: credential.id,
          sandboxId: existing.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const readyBy = expectedReadyBy(deps);
      await deps.updateSandbox({
        sandboxId: existing.id,
        workspaceId: input.auth.workspaceId,
        status: "warming",
        brokerPort: null,
        error: null,
        expectedReadyBy: readyBy,
      });
      deps.scheduleBackgroundTask(async () => {
        await completeCloudAgentBoxWarm(deps, {
          ...input,
          mountPaths,
        }, existing.id);
      });
      return {
        response: pendingBoxResponse({
          sandboxId: existing.id,
          relayfileToken,
          mountPaths,
          workspaceSource: input.workspaceSource,
          expectedReadyBy: readyBy,
          phase: "starting",
          now: deps.now(),
        }),
        status: 202 as const,
      };
    }

    if (existing?.status === "warming" && !warmingExpired(existing, deps.now())) {
      return {
        response: pendingBoxResponse({
          sandboxId: existing.id,
          relayfileToken,
          mountPaths,
          workspaceSource: input.workspaceSource,
          expectedReadyBy: existing.expectedReadyBy,
          phase: "starting",
          now: deps.now(),
        }),
        status: 202 as const,
      };
    }

    const sandboxId = existing?.id ?? warmingSandboxId();
    const readyBy = expectedReadyBy(deps);
    if (existing) {
      await deps.updateSandbox({
        sandboxId,
        workspaceId: input.auth.workspaceId,
        status: "warming",
        brokerPort: null,
        error: null,
        expectedReadyBy: readyBy,
      });
    } else {
      await deps.insertSandbox({
        sandboxId,
        auth: input.auth,
        workspaceId: input.auth.workspaceId,
        cloudAgentId: credential.id,
        status: "warming",
        brokerPort: null,
        error: null,
        expectedReadyBy: readyBy,
      });
    }

    deps.scheduleBackgroundTask(async () => {
      await completeCloudAgentBoxWarm(deps, {
        ...input,
        mountPaths,
      }, sandboxId);
    });

    return {
      response: pendingBoxResponse({
        sandboxId,
        relayfileToken,
        mountPaths,
        workspaceSource: input.workspaceSource,
        expectedReadyBy: readyBy,
        phase: phaseForWarmingSandboxId(sandboxId),
        now: deps.now(),
      }),
      status: 202 as const,
    };
  });
}

async function completeCloudAgentBoxWarm(
  deps: CloudAgentBoxDeps,
  input: CloudAgentBoxInput,
  sandboxId: string,
): Promise<void> {
  try {
    await warmCloudAgentBoxToReady(deps, input, {
      placeholderSandboxId: isWarmingPlaceholderId(sandboxId) ? sandboxId : undefined,
      allowExistingWarming: true,
    });
  } catch (error) {
    logger.warn("[cloud-agent-box] async warm failed", {
      area: "cloud-agent-box",
      workspaceId: input.auth.workspaceId,
      cloudAgentId: input.cloudAgentId,
      sandboxId,
      error: backgroundErrorMessage(error),
    });
    await deps.updateSandbox({
      sandboxId,
      workspaceId: input.auth.workspaceId,
      status: "failed",
      error: backgroundErrorMessage(error),
      expectedReadyBy: null,
    });
  }
}

export async function readCloudAgentBox(
  deps: CloudAgentBoxDeps,
  input: CloudAgentBoxInput,
  options: { enforceWarmDeadline?: boolean } = {},
): Promise<CloudAgentBoxResponse> {
  input = withRememberedWorkspaceSource(input);
  const credential = await loadCredentialOrThrow(deps, input);
  const existing = await deps.findStickySandbox({
    workspaceId: input.auth.workspaceId,
    cloudAgentId: credential.id,
  });
  if (!existing) {
    throw new CloudAgentBoxError("Cloud agent box not found", "box_not_found", 404);
  }
  let sandbox: DaytonaSandbox | null = null;
  // A stopped/stopping box has no live sandbox, so reading the box env file
  // (which execs inside the sandbox) throws and gets masked as a 503. Skip the
  // pre-read for these states; the stopped early-return below re-fetches the
  // sandbox and answers with `stoppedBoxResponse`.
  if (
    !input.workspaceSource &&
    existing.status !== "failed" &&
    existing.status !== "stopping" &&
    existing.status !== "stopped" &&
    !isWarmingPlaceholderId(existing.id)
  ) {
    sandbox = await getSandboxOrNullIfGone(deps, existing.id);
    if (sandbox) {
      const home = (await sandbox.getUserHomeDir?.()) ?? "/home/daytona";
      const envSource = workspaceSourceFromEnv(await readBoxEnvFile(sandbox, home) ?? {});
      if (envSource) {
        input = { ...input, workspaceSource: envSource };
        rememberWorkspaceSource(input);
      }
    }
  }
  const mountPaths = normalizeMountPaths(input.mountPaths, input.workspaceSource);
  const relayfileToken = await mintRelayfileToken(deps, input, credential, mountPaths);
  if (existing.status === "warming") {
    // `enforceWarmDeadline: false` (queue path, #1384) suppresses the legacy
    // wall-clock `warmingExpired`/ASYNC_WARM_DEADLINE_MS heuristic: when warm
    // execution runs through the CF Queue, the job state + DLQ own failure
    // detection, so a long-but-still-progressing warm (e.g. a cold git clone
    // that legitimately exceeds 300s) must NOT be flipped to "timed out" by a
    // GET. The flag-OFF inline path keeps the deadline (default true).
    if (options.enforceWarmDeadline !== false && warmingExpired(existing, deps.now())) {
      if (!isWarmingPlaceholderId(existing.id)) {
        await deps.updateSandbox({
          sandboxId: existing.id,
          workspaceId: input.auth.workspaceId,
          status: "failed",
          error: "Cloud agent box warm timed out",
          expectedReadyBy: null,
        });
        return failedBoxResponse({
          sandboxId: existing.id,
          relayfileToken,
          mountPaths,
          workspaceSource: input.workspaceSource,
          error: "Cloud agent box warm timed out",
        });
      }
      await deps.updateSandbox({
        sandboxId: existing.id,
        workspaceId: input.auth.workspaceId,
        status: "failed",
        error: "Cloud agent box warm timed out",
        expectedReadyBy: null,
      });
      return failedBoxResponse({
        sandboxId: existing.id,
        relayfileToken,
        mountPaths,
        workspaceSource: input.workspaceSource,
        error: "Cloud agent box warm timed out",
      });
    }
    return pendingBoxResponse({
      sandboxId: existing.id,
      relayfileToken,
      mountPaths,
      workspaceSource: input.workspaceSource,
      expectedReadyBy: existing.expectedReadyBy,
      phase: phaseForWarmingSandboxId(existing.id),
      now: deps.now(),
    });
  }
  if (existing.status === "failed") {
    return failedBoxResponse({
      sandboxId: existing.id,
      relayfileToken,
      mountPaths,
      workspaceSource: input.workspaceSource,
      error: existing.error,
    });
  }
  sandbox ??= await getSandboxOrNullIfGone(deps, existing.id);
  if (!sandbox) {
    // The sticky Daytona box was destroyed/evicted out-of-band. Report stopped
    // (recreate-needed) instead of a masked 503 so the client re-warms — the
    // warm path then self-heals the stale row to a fresh sandbox.
    return stoppedBoxResponse({
      sandboxId: existing.id,
      status: "stopped",
      relayfileToken,
      mountPaths,
      workspaceSource: input.workspaceSource,
    });
  }
  const apiKey = deps.deriveBrokerApiKey(deps.getBrokerKeySecret(), sandbox.id);
  const status = boxStatusFromState(sandbox.state, existing.status);
  if (status === "stopping" || status === "stopped") {
    return stoppedBoxResponse({
      sandboxId: sandbox.id,
      status,
      relayfileToken,
      mountPaths,
      workspaceSource: input.workspaceSource,
    });
  }
  const connection = await getBrokerConnection(sandbox, apiKey);
  if (status === "ready") {
    // Keep the in-sandbox mount creds file ahead of the 1h token TTL: mints a
    // token scoped to the ACTIVE env mount paths (not this GET's body-less
    // default scope). Throttled to ~TTL/2; never throws.
    await maybeRefreshBoxMountCreds(deps, sandbox, input, credential);
  }
  return {
    sandboxId: sandbox.id,
    status,
    relayfileToken,
    relayfileMountPath: primaryMountPath(mountPaths, input.workspaceSource),
    ...(status === "ready" ? { phase: "ready" as const, etaMs: 0 } : {}),
    ...connection,
  };
}

export async function updateCloudAgentBoxMountPaths(
  deps: CloudAgentBoxDeps,
  input: CloudAgentBoxInput,
): Promise<CloudAgentBoxResponse> {
  const credential = await loadCredentialOrThrow(deps, input);
  const existing = await deps.findStickySandbox({
    workspaceId: input.auth.workspaceId,
    cloudAgentId: credential.id,
  });
  if (!existing || existing.status !== "running") {
    throw new CloudAgentBoxError("Cloud agent box is not running", "box_not_running", 409);
  }
  const sandbox = await deps.createDaytonaClient().get(existing.id);
  if (boxStatusFromState(sandbox.state, existing.status) !== "ready") {
    throw new CloudAgentBoxError("Cloud agent box is not running", "box_not_running", 409);
  }
  const home = (await sandbox.getUserHomeDir?.()) ?? "/home/daytona";
  const existingEnv = await readBoxEnvFile(sandbox, home) ?? {};
  input = withRememberedWorkspaceSource(input);
  if (!input.workspaceSource) {
    const envSource = workspaceSourceFromEnv(existingEnv);
    if (envSource) {
      input = { ...input, workspaceSource: envSource };
      rememberWorkspaceSource(input);
    }
  }
  // #125: broker identity is provision-time only — PATCH never carries it, but
  // this flow rewrites the box env file below, so carry the existing values
  // forward or the rewrite would silently wipe the broker's workspace join.
  input = {
    ...input,
    workspaceKey: input.workspaceKey ?? existingEnv.AGENT_RELAY_WORKSPACE_KEY,
    brokerName: input.brokerName ?? existingEnv.AGENT_RELAY_BROKER_NAME,
  };
  const mountPaths = normalizeMountPaths(input.mountPaths, input.workspaceSource);
  const relayfileToken = await mintRelayfileToken(deps, input, credential, mountPaths);
  // Refresh the creds file BEFORE the pre-re-scope flush: the flush reuses the
  // env file's launch-time token, which may already be past its 1h TTL — a
  // creds-aware daemon 401s on the stale token, re-reads this file, and the
  // flush completes instead of dropping queued writeback.
  try {
    await writeBoxMountCredsFile(deps, sandbox, home, relayfileToken);
  } catch (error) {
    logger.warn("[cloud-agent-box] mount creds refresh before re-scope failed; continuing", {
      area: "cloud-agent-box",
      workspaceId: input.auth.workspaceId,
      cloudAgentId: credential.id,
      sandboxId: sandbox.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    await flushActiveRelayfileMount({
      deps,
      sandbox,
      sandboxHome: home,
      request: input,
      credential,
    });
  } catch (error) {
    logger.warn("[cloud-agent-box] relayfile mount flush before re-scope failed; continuing", {
      area: "cloud-agent-box",
      workspaceId: input.auth.workspaceId,
      cloudAgentId: credential.id,
      sandboxId: sandbox.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const { envVars } = await buildRuntimeEnv(deps, input, credential, relayfileToken, mountPaths);
  const mountConfig = relayfileMountConfig(
    envVars,
    mountPaths,
    input.workspaceSource,
    boxMountCredsFilePath(home),
  );
  if (isGitWorkspaceSource(input.workspaceSource)) {
    await syncGitWorkspaceSource(deps, input, sandbox, home, input.workspaceSource);
  }
  if (isDirectGitWorkspaceSource(input.workspaceSource)) {
    await ensureDirectGitRelayfileMountRoots(sandbox, home, mountPaths);
  }
  await writeBoxEnvFile(sandbox, home, envVars);
  try {
    await deps.startRelayfileMount({
      sandbox,
      sandboxHome: home,
      config: mountConfig,
    });
  } catch (error) {
    if (isGitWorkspaceSource(input.workspaceSource)) {
      throw error;
    }
    logger.warn("[cloud-agent-box] relayfile mount restart failed after re-scope; continuing", {
      area: "cloud-agent-box",
      workspaceId: input.auth.workspaceId,
      cloudAgentId: credential.id,
      sandboxId: sandbox.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const apiKey = deps.deriveBrokerApiKey(deps.getBrokerKeySecret(), sandbox.id);
  const connection = await getBrokerConnection(sandbox, apiKey);
  return {
    sandboxId: sandbox.id,
    status: "ready",
    relayfileToken,
    relayfileMountPath: primaryMountPath(mountPaths, input.workspaceSource),
    phase: "ready",
    etaMs: 0,
    ...connection,
  };
}

export async function reapExpiredCloudAgentBoxKeepalives(
  deps: CloudAgentBoxDeps = defaultDeps,
  input: { limit?: number } = {},
): Promise<ReapCloudAgentBoxKeepalivesResult> {
  const limit = Math.max(1, Math.floor(input.limit ?? KEEPALIVE_REAPER_DEFAULT_LIMIT));
  const now = deps.now();
  const rows = await deps.listExpiredKeepaliveSandboxes({
    now,
    limit,
  });
  const daytona = deps.createDaytonaClient();
  let stopped = 0;
  let vanished = 0;
  const failed: string[] = [];

  for (const row of rows) {
    try {
      await deps.withCloudAgentBoxLock({
        workspaceId: row.workspaceId,
        cloudAgentId: row.cloudAgentId,
      }, async () => {
        const current = await deps.findStickySandbox({
          workspaceId: row.workspaceId,
          cloudAgentId: row.cloudAgentId,
        });
        const currentKeepaliveUntil = current?.keepaliveUntil
          ? new Date(current.keepaliveUntil).getTime()
          : Number.NaN;
        if (
          !current ||
          current.id !== row.id ||
          current.status !== "running" ||
          !Number.isFinite(currentKeepaliveUntil) ||
          currentKeepaliveUntil > now.getTime()
        ) {
          return;
        }

        try {
          const sandbox = await retryOnDaytonaUpstreamTimeout(
            "daytona.get(expired-keepalive)",
            () => daytona.get(row.id),
          );
          if (daytona.stop) {
            await daytona.stop(sandbox);
          } else {
            await sandbox.stop?.();
          }
        } catch (error) {
          if (!isDaytonaNotFound(error)) {
            throw error;
          }
          await deps.updateSandbox({
            sandboxId: row.id,
            workspaceId: row.workspaceId,
            status: "stopped",
            brokerPort: null,
            error: null,
            expectedReadyBy: null,
            keepaliveUntil: null,
          });
          vanished += 1;
          return;
        }
        await deps.updateSandbox({
          sandboxId: row.id,
          workspaceId: row.workspaceId,
          status: "stopping",
          brokerPort: BROKER_PORT,
          error: null,
          expectedReadyBy: null,
          keepaliveUntil: null,
        });
        stopped += 1;
      });
    } catch (error) {
      failed.push(row.id);
      logger.warn("[cloud-agent-box] keepalive reaper failed to stop idle box", {
        area: "cloud-agent-box",
        workspaceId: row.workspaceId,
        cloudAgentId: row.cloudAgentId,
        sandboxId: row.id,
        keepaliveUntil: new Date(row.keepaliveUntil).toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    found: rows.length,
    stopped,
    vanished,
    failed,
  };
}

export async function stopCloudAgentBox(
  deps: CloudAgentBoxDeps,
  input: Pick<CloudAgentBoxInput, "auth" | "urlWorkspaceId" | "cloudAgentId">,
): Promise<{ sandboxId: string; status: "stopping"; keepaliveUntil?: string }> {
  const credential = await loadCredentialOrThrow(deps, {
    ...input,
    workspaceToken: null,
  }, { requireUsable: false });
  const existing = await deps.findStickySandbox({
    workspaceId: input.auth.workspaceId,
    cloudAgentId: credential.id,
  });
  if (!existing) {
    throw new CloudAgentBoxError("Cloud agent box not found", "box_not_found", 404);
  }

  const daytona = deps.createDaytonaClient();
  try {
    const sandbox = await daytona.get(existing.id);
    try {
      const home = (await sandbox.getUserHomeDir?.()) ?? "/home/daytona";
      const flushed = await flushActiveRelayfileMount({
        deps,
        sandbox,
        sandboxHome: home,
        request: input,
        credential,
      });
      if (!flushed) {
        const mountPaths = normalizeMountPaths(undefined);
        const relayfileToken = await mintRelayfileTokenForPaths({
          deps,
          request: input,
          credential,
          mountPaths,
        });
        const relayfile = deps.resolveRelayfileConfig();
        await deps.flushRelayfileMount({
          sandbox,
          sandboxHome: home,
          config: relayfileMountConfigFromParts({
            baseUrl: relayfile.relayfileUrl,
            workspaceId: input.auth.workspaceId,
            token: relayfileToken,
            mountPaths,
            credsFilePath: boxMountCredsFilePath(home),
          }),
        });
      }
    } catch (error) {
      logger.warn("[cloud-agent-box] relayfile mount flush on stop failed; continuing", {
        area: "cloud-agent-box",
        workspaceId: input.auth.workspaceId,
        cloudAgentId: credential.id,
        sandboxId: sandbox.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const idleUntil = keepaliveUntil(deps);
    if (idleUntil) {
      await deps.updateSandbox({
        sandboxId: existing.id,
        workspaceId: input.auth.workspaceId,
        status: "running",
        brokerPort: BROKER_PORT,
        error: null,
        expectedReadyBy: null,
        keepaliveUntil: idleUntil,
      });
      workspaceSourceCache.delete(workspaceSourceCacheKey(input));
      return {
        sandboxId: existing.id,
        status: "stopping",
        keepaliveUntil: idleUntil.toISOString(),
      };
    }
    if (daytona.stop) {
      await daytona.stop(sandbox);
    } else {
      await sandbox.stop?.();
    }
  } catch (error) {
    logger.warn("Cloud agent box stop was non-fatal", {
      area: "cloud-agent-box",
      sandboxId: existing.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  await deps.updateSandbox({
    sandboxId: existing.id,
    workspaceId: input.auth.workspaceId,
    status: "stopping",
    brokerPort: BROKER_PORT,
    keepaliveUntil: null,
  });
  workspaceSourceCache.delete(workspaceSourceCacheKey(input));
  return { sandboxId: existing.id, status: "stopping" };
}

export function defaultCloudAgentBoxDeps(): CloudAgentBoxDeps {
  return defaultDeps;
}
