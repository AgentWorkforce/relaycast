/**
 * Lambda STS broker handler.
 *
 * The Cloudflare Worker (cloud-web) cannot call AWS STS directly because it
 * has no IAM identity. This Lambda receives HMAC-signed requests from the
 * Worker, calls `STSClient.AssumeRole` against the existing
 * `Resource.WorkflowStorage.stsRoleArn`, and returns scoped temporary
 * credentials. The Lambda's IAM role is intentionally narrow: it can call
 * `sts:AssumeRole` on that one role ARN and nothing else.
 *
 * Security boundary the broker enforces:
 *   1. HMAC-SHA256 over (method, path, body, timestamp). Without the
 *      `BROKER_HMAC_SECRET` value, an attacker on the public Function URL
 *      cannot mint credentials.
 *   2. Timestamp must be within `DEFAULT_SIGNATURE_MAX_SKEW_SECONDS` of the
 *      Lambda's wall clock — bounds replay attacks.
 *   3. The session policy attached to the AssumeRole call restricts the
 *      returned credentials to `s3://<bucket>/<userId>/<runId>/*`. Even if
 *      an attacker tampers with the body (which would fail signature check
 *      first), the worst case is access to their own scoped prefix.
 *
 * Out of scope (intentionally — see PR description for design defaults):
 *   - Workspace scoping (current scope is userId/runId only).
 *   - HMAC secret auto-rotation (requires CI redeploy).
 *   - KV-backed credential cache (Worker keeps its own in-memory cache).
 */

import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { verifyRequest } from "./hmac-node.js";

/**
 * Broker scopes:
 *
 * - "workflow-run": classic per-run scope. Issues creds valid for
 *   `s3://<bucket>/<userId>/<runId>/*`. This is the original mintS3Credentials
 *   contract — used by /workflows/{prepare,run} and the runs/[runId] read
 *   routes. Requires `runId`.
 *
 * - "credential-store": per-user credential storage scope. Issues creds
 *   valid for `s3://<bucket>/credentials/<userId>/*`. Used by
 *   /credentials/refresh and /workspaces/[id]/provider-credentials/byok
 *   on the Worker path. Requires only `userId`.
 *
 * Adding a new scope is a deliberate broker-contract change: bump the broker
 * Lambda, update the docs in `docs/architecture/sts-broker.md`, and route
 * the new call sites through this same handler. Don't add ad-hoc S3 paths
 * to either scope's session policy without updating the docs and tests.
 */
export type BrokerScope = "workflow-run" | "credential-store";

type BrokerRequestBody = {
  scope: BrokerScope;
  userId: string;
  runId?: string;
  durationSeconds?: number;
};

type BrokerResponseBody = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  bucket: string;
  prefix: string;
  expiresAt: string;
};

type EnvSnapshot = {
  hmacSecret: string;
  roleArn: string;
  bucket: string;
  region: string;
};

/**
 * Lazy STS client. Lambda warm reuse: build it once per container, not per
 * request. Region falls back through the same chain `mintS3Credentials`
 * uses so the broker behaves identically to the existing direct-STS path.
 */
let cachedStsClient: STSClient | null = null;
function getStsClient(region: string): STSClient {
  if (cachedStsClient) {
    return cachedStsClient;
  }
  cachedStsClient = new STSClient({ region });
  return cachedStsClient;
}

/** Reset for tests so each test injects its own STS mock. */
export function resetStsClientForTesting(): void {
  cachedStsClient = null;
}

/**
 * STSClient injection seam for tests. Production code never calls this — it
 * exists so test files can install an in-memory fake without going through
 * AWS SDK transport interceptors.
 */
let stsClientOverride: STSClient | null = null;
export function setStsClientForTesting(client: STSClient | null): void {
  stsClientOverride = client;
}

function jsonResponse(status: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode: status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function readEnv(): EnvSnapshot | { error: string } {
  const hmacSecret = process.env.BROKER_HMAC_SECRET;
  const roleArn =
    process.env.WORKFLOW_STORAGE_STS_ROLE_ARN ??
    // SST link materialises the WorkflowStorage Linkable's `stsRoleArn`
    // property as `SST_RESOURCE_WorkflowStorage` JSON. Reading the
    // explicit env var first lets tests / local dev override without an
    // SST runtime, but production reads from the SST-emitted variable.
    readSstResourceProperty("WorkflowStorage", "stsRoleArn");
  const bucket =
    process.env.WORKFLOW_STORAGE_BUCKET ??
    readSstResourceProperty("WorkflowStorage", "bucketName");
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";

  if (!hmacSecret) {
    return { error: "BROKER_HMAC_SECRET is not configured" };
  }
  if (!roleArn) {
    return { error: "WorkflowStorage.stsRoleArn is not configured" };
  }
  if (!bucket) {
    return { error: "WorkflowStorage.bucketName is not configured" };
  }

  return { hmacSecret, roleArn, bucket, region };
}

function readSstResourceProperty(name: string, property: string): string | undefined {
  const raw = process.env[`SST_RESOURCE_${name}`];
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = parsed[property];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseBody(raw: string | undefined): BrokerRequestBody | { error: string } {
  if (!raw) {
    return { error: "Request body is required" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "Request body is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { error: "Request body must be a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  // `scope` defaults to "workflow-run" so existing call sites don't need to
  // be updated atomically with the broker rollout. Any unknown scope is
  // rejected explicitly (no silent fallback) — that prevents typos in the
  // caller from silently downgrading the credential surface area.
  const scopeRaw = typeof obj.scope === "string" ? obj.scope : "workflow-run";
  if (scopeRaw !== "workflow-run" && scopeRaw !== "credential-store") {
    return { error: `unknown scope: ${scopeRaw}` };
  }
  const scope = scopeRaw as BrokerScope;
  const userId = typeof obj.userId === "string" ? obj.userId : "";
  if (!userId) {
    return { error: "userId is required" };
  }
  const runId = typeof obj.runId === "string" ? obj.runId : "";
  if (scope === "workflow-run" && !runId) {
    return { error: "runId is required for workflow-run scope" };
  }
  const durationRaw = obj.durationSeconds;
  let durationSeconds: number | undefined;
  if (durationRaw !== undefined) {
    if (typeof durationRaw !== "number" || !Number.isFinite(durationRaw) || durationRaw <= 0) {
      return { error: "durationSeconds must be a positive number" };
    }
    durationSeconds = Math.min(Math.floor(durationRaw), 3600);
  }
  return { scope, userId, runId: runId || undefined, durationSeconds };
}

/**
 * Build the same scoped session policy the existing `mintS3Credentials`
 * helper applies. Kept inline (rather than importing from `@cloud/core`)
 * because the broker Lambda is intentionally a leaf module — pulling in
 * the rest of `@cloud/core` would balloon the deploy bundle and re-introduce
 * Cloudflare-incompatible imports through transitive deps.
 */
function buildSessionPolicy(bucket: string, prefix: string): string {
  const objectArn = `arn:aws:s3:::${bucket}/${prefix}/*`;
  const bucketArn = `arn:aws:s3:::${bucket}`;
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject",
          "s3:CreateMultipartUpload",
          "s3:UploadPart",
          "s3:CompleteMultipartUpload",
          "s3:AbortMultipartUpload",
        ],
        Resource: objectArn,
      },
      {
        Effect: "Allow",
        Action: "s3:ListBucket",
        Resource: bucketArn,
        Condition: {
          StringLike: { "s3:prefix": [`${prefix}/*`] },
        },
      },
    ],
  });
}

export type AssumeRoleViaStsInput = {
  scope: BrokerScope;
  userId: string;
  runId?: string;
  durationSeconds?: number;
  env: EnvSnapshot;
};

function resolvePrefix(scope: BrokerScope, userId: string, runId?: string): string {
  if (scope === "credential-store") {
    return `credentials/${userId}`;
  }
  // workflow-run — runId is asserted at parse time
  return `${userId}/${runId}`;
}

function resolveSessionName(scope: BrokerScope, userId: string, runId?: string): string {
  // STS RoleSessionName is capped at 64 chars and restricted to
  // [\w+=,.@-]. userId / runId in our system are UUIDs, so we just
  // concat with a prefix and truncate.
  const base =
    scope === "credential-store"
      ? `worker-broker-credstore-${userId}`
      : `worker-broker-${runId ?? userId}`;
  return base.slice(0, 64);
}

export async function assumeRoleViaSts(
  input: AssumeRoleViaStsInput,
): Promise<BrokerResponseBody> {
  const prefix = resolvePrefix(input.scope, input.userId, input.runId);
  const sts = stsClientOverride ?? getStsClient(input.env.region);
  const command = new AssumeRoleCommand({
    RoleArn: input.env.roleArn,
    RoleSessionName: resolveSessionName(input.scope, input.userId, input.runId),
    DurationSeconds: input.durationSeconds ?? 900,
    Policy: buildSessionPolicy(input.env.bucket, prefix),
  });
  const response = await sts.send(command);
  const credentials = response.Credentials;
  if (
    !credentials?.AccessKeyId ||
    !credentials.SecretAccessKey ||
    !credentials.SessionToken ||
    !credentials.Expiration
  ) {
    throw new Error("STS AssumeRole response missing temporary credentials");
  }
  return {
    accessKeyId: credentials.AccessKeyId,
    secretAccessKey: credentials.SecretAccessKey,
    sessionToken: credentials.SessionToken,
    bucket: input.env.bucket,
    prefix,
    expiresAt: credentials.Expiration.toISOString(),
  };
}

/**
 * Lambda Function URL handler. Function URLs deliver
 * `APIGatewayProxyEventV2` shape regardless of the underlying request type,
 * which is why we type against that.
 */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const env = readEnv();
  if ("error" in env) {
    console.error("[sts-broker] misconfigured", { error: env.error });
    return jsonResponse(500, { error: "broker_misconfigured" });
  }

  const method = event.requestContext?.http?.method ?? "GET";
  const path = event.requestContext?.http?.path ?? event.rawPath ?? "/";
  if (method !== "POST" || path !== "/broker/sts/assume-role") {
    return jsonResponse(404, { error: "not_found" });
  }

  // API Gateway / Function URL deliver the body base64-encoded when the
  // client sends a binary content-type. JSON requests come through as
  // plaintext, but defensively decode if the flag is set.
  const rawBody = event.isBase64Encoded && event.body
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body ?? "";

  const verification = verifyRequest({
    method,
    path,
    body: rawBody,
    headers: event.headers as Record<string, string | undefined>,
    secret: env.hmacSecret,
  });
  if (!verification.ok) {
    // Don't leak which field failed to the caller — same opaque 403 for
    // any auth failure. Log the precise reason for ops debugging.
    console.warn("[sts-broker] auth failed", { reason: verification.reason });
    return jsonResponse(403, { error: "forbidden" });
  }

  const parsed = parseBody(rawBody);
  if ("error" in parsed) {
    return jsonResponse(400, { error: parsed.error });
  }

  try {
    const credentials = await assumeRoleViaSts({
      scope: parsed.scope,
      userId: parsed.userId,
      runId: parsed.runId,
      durationSeconds: parsed.durationSeconds,
      env,
    });
    return jsonResponse(200, credentials);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[sts-broker] sts call failed", {
      scope: parsed.scope,
      userId: parsed.userId,
      runId: parsed.runId,
      message,
    });
    // 503 lets the Worker's exponential-backoff retry kick in. The
    // Worker treats 5xx as retriable; 4xx as terminal. STS call failure
    // is genuinely transient most of the time (throttling, brief
    // service blip), so 503 is the correct shape.
    return jsonResponse(503, { error: "sts_unavailable" });
  }
}
