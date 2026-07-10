import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { Resource } from "sst";
import { mintRelayfileToken } from "@cloud/core/relayfile/client.js";
import {
  buildCredentialBundle,
  launchOrchestratorSandbox,
  getCliCredentials,
  listConnectedProviders,
  resolveCredentialProxyConfig,
  workflowNeedsCliCredentials,
  getAllProviders,
  workflowStore,
  type WorkflowFileType,
  type WorkflowSourceFileType,
} from "@/lib/workflows";
import { mintScopedS3Credentials } from "@/lib/aws/sts-credentials";
import { BrokerClientError } from "@/lib/aws/broker-client";
import { isWorkerRuntime } from "@/lib/aws/runtime";
import { optionalEnv } from "@/lib/env";
import { requireAuthScope, requireSessionAuth, resolveRequestAuth, type RequestAuth } from "@/lib/auth/request-auth";
import { getBrokerKeySecret } from "@/lib/auth/secrets";
import { resolveServerDaytonaAuthParams } from "@/lib/daytona-auth";
import {
  attachSandboxToApiTokenSession,
  createApiTokenSession,
  revokeApiTokenSessionById,
} from "@/lib/auth/api-token-store";
import { getConfiguredAppOrigin } from "@/lib/app-origin";
import { toAbsoluteAppUrl, toAppPath } from "@/lib/app-path";
import { getCloudflareContext } from "@/lib/cloudflare-context";
import { getDb } from "@/lib/db";
import { deriveInteractive } from "@cloud/core/bootstrap/launcher.js";
import {
  mintCredentialProxyToken,
  resolveProxyProviderFromCredentialProvider,
} from "@cloud/core/auth/proxy-token.js";
import { agents, sandboxes, workspaces } from "@/lib/db/schema";
import { resolveRelayfileConfig } from "@/lib/relayfile";
import { ensureRelayWorkspace } from "@/lib/relay-workspaces";
import { resolveRepoAllowlistOrRelaxed } from "@/lib/integrations/workflow-repository-allowlists";
import {
  mintWorkflowGithubWriteToken,
  WorkflowGithubWriteTokenError,
} from "@/lib/integrations/github-workflow-write-token";
import { createWorkflowLaunchJob, markWorkflowLaunchJobFailed } from "@cloud/core/workflow-launch/job-store.js";
import { enqueueForWorker, runWorkerAssignmentMaintenance } from "@/lib/workers/assignments";
import { WorkerRegistry } from "@/lib/workers/registry";
import { packageWorkflowRef } from "@/lib/workers/workflow-ref";
import type { WorkerSelection } from "@/lib/workers/types";
import { resolveWorkflowGithubWriteGrant } from "@/lib/workflows/invocation-registry";
import {
  encryptWorkflowLaunchEnvelopeAsync,
  type WorkflowLaunchEnvelope,
} from "@/lib/workflows/launch-job-envelope";
import { enqueueWorkflowLaunchJob } from "@/lib/workflows/durable-launch-queue";
import { resolveOrProvisionRelayWorkspace } from "@/lib/workflows/relay-workspace";
import { resolveRelaycastUrl } from "@/lib/workspace-registry";
import {
  buildCloudApiWorkflowStorageCredentials,
  getWorkflowStorageBackend,
} from "@/lib/storage";

type PathSubmission = {
  name: string;
  s3CodeKey: string;
  repoOwner?: string;
  repoName?: string;
  pushBranch?: string;
  pushBase?: string;
  pushPrBody?: string;
};

type AssetsBinding = {
  fetch: (request: Request | URL) => Promise<Response>;
};

type RunRequestBody = {
  workflow: string;
  fileType: WorkflowFileType;
  sourceFileType?: WorkflowSourceFileType;
  runId?: string;
  s3CodeKey?: string;
  resume?: string;
  startFrom?: string;
  previousRunId?: string;
  paths?: PathSubmission[];
  /**
   * Path to the workflow file inside the synced tarball, relative to the
   * tarball root (e.g. `workflows/security-runtime/01-broker-runtime-execution.ts`).
   * When present AND `s3CodeKey` is also present, the sandbox points
   * WORKFLOW_FILE directly at `${codeMountPath}/${workflowPath}` and skips
   * the $HOME upload dance — so relative imports like `../shared/models.ts`
   * resolve naturally against the repo layout.
   *
   * Absent for non-sync-code runs or for older CLIs that pre-date the
   * field. Validated to be a forward-slash relative path with no `..`
   * segments to prevent directory traversal against `/project`.
   */
  workflowPath?: string;
  envSecrets?: Record<string, string>;
  metadata?: unknown;
  workspaceId?: string;
  inputs?: unknown;
  runtime?: {
    id?: string;
    kind?: string;
    config?: unknown;
  };
};

type WorkflowExecutionMode = "per-step-sandbox" | "shared-sandbox";

export const WORKSPACE_WORKFLOW_INVOCATION_DELEGATION_HEADER =
  "x-agentworkforce-workspace-workflow-invocation";
export const WORKSPACE_WORKFLOW_INVOCATION_DELEGATION_TOKEN = crypto.randomUUID();

const PATH_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const GITHUB_REPO_PART_RE = /^[A-Za-z0-9][A-Za-z0-9-_.]{0,99}$/;
const GIT_BRANCH_RE = /^[A-Za-z0-9._/-]{1,255}$/;
const PUSH_PR_BODY_MAX_BYTES = 65_536;

function isValidS3CodeKey(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 512) return false;
  if (trimmed.startsWith("/") || trimmed.includes("\\")) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(trimmed)) return false;
  return !trimmed.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function isValidGitBranchName(value: string): boolean {
  const trimmed = value.trim();
  if (!GIT_BRANCH_RE.test(trimmed)) return false;
  if (trimmed.startsWith("-") || trimmed.startsWith("/")) return false;
  if (trimmed.includes("..")) return false;
  return trimmed !== "HEAD";
}

function normalizePushOptions(record: Record<string, unknown>): Pick<
  PathSubmission,
  "pushBranch" | "pushBase" | "pushPrBody"
> | null {
  const options: Pick<PathSubmission, "pushBranch" | "pushBase" | "pushPrBody"> = {};

  for (const key of ["pushBranch", "pushBase"] as const) {
    const raw = record[key];
    if (raw === undefined) continue;
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    if (!isValidGitBranchName(trimmed)) return null;
    options[key] = trimmed;
  }

  if (record.pushPrBody !== undefined) {
    if (typeof record.pushPrBody !== "string") return null;
    const byteLength = new TextEncoder().encode(record.pushPrBody).byteLength;
    if (byteLength > PUSH_PR_BODY_MAX_BYTES) return null;
    options.pushPrBody = record.pushPrBody;
  }

  return options;
}

function normalizePathSubmission(value: unknown): PathSubmission | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || typeof record.s3CodeKey !== "string") {
    return null;
  }

  const name = record.name.trim();
  const s3CodeKey = record.s3CodeKey.trim();
  if (!PATH_NAME_RE.test(name) || !isValidS3CodeKey(s3CodeKey)) {
    return null;
  }

  const pushOptions = normalizePushOptions(record);
  if (!pushOptions) {
    return null;
  }

  const hasOwner = record.repoOwner !== undefined;
  const hasName = record.repoName !== undefined;
  if (hasOwner !== hasName) {
    return null;
  }
  if (!hasOwner && !hasName) {
    return { name, s3CodeKey, ...pushOptions };
  }

  if (typeof record.repoOwner !== "string" || typeof record.repoName !== "string") {
    return null;
  }
  const repoOwner = record.repoOwner.trim();
  const repoName = record.repoName.trim();
  if (!GITHUB_REPO_PART_RE.test(repoOwner) || !GITHUB_REPO_PART_RE.test(repoName)) {
    return null;
  }

  return { name, s3CodeKey, repoOwner, repoName, ...pushOptions };
}

function normalizePathSubmissions(value: unknown): PathSubmission[] | null {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 16) {
    return null;
  }
  if (value.length === 0) {
    return [];
  }

  const normalized: PathSubmission[] = [];
  const names = new Set<string>();
  for (const entry of value) {
    const normalizedEntry = normalizePathSubmission(entry);
    if (!normalizedEntry || names.has(normalizedEntry.name)) {
      return null;
    }
    names.add(normalizedEntry.name);
    normalized.push(normalizedEntry);
  }

  return normalized;
}

/**
 * Validates a workflow path from the request body as a forward-slash
 * relative path inside the synced tarball. Returns the trimmed,
 * normalized value on success, or `null` if the input would escape
 * `/project` (absolute prefix, embedded `..` segment, or untrimmed
 * whitespace that would smuggle either of the above past the initial
 * `startsWith` check).
 */
function normalizeWorkflowPathParam(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  // Reject backslashes outright — the CLI always sends forward slashes,
  // so a `\` in the payload is either a buggy or malicious client and
  // would resolve to an invalid literal path on the Linux sandbox.
  if (trimmed.includes("\\")) return null;
  if (trimmed.startsWith("/")) return null;
  // Block any segment of exactly ".." — after trim, split on forward
  // slashes (backslashes already rejected above).
  const segments = trimmed.split("/");
  if (segments.some((s) => s.trim() === "..")) return null;
  return trimmed;
}

type RuntimeDescriptor = {
  id: string;
  config?: unknown;
  executionMode: WorkflowExecutionMode;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeWorkflowExecutionMode(value: unknown): WorkflowExecutionMode | null {
  if (value === undefined) {
    return "per-step-sandbox";
  }
  return value === "per-step-sandbox" || value === "shared-sandbox" ? value : null;
}

function readRuntimeConfig(runtime: RunRequestBody["runtime"]): Record<string, unknown> | undefined {
  return isRecord(runtime?.config) ? runtime.config : undefined;
}

function resolveRuntimeId(runtime: RunRequestBody["runtime"]): string | undefined {
  const explicitId = runtime?.id?.trim();
  if (explicitId) {
    return explicitId;
  }

  const kind = runtime?.kind?.trim();
  if (kind === "relay-workflow") {
    const config = readRuntimeConfig(runtime);
    const provider = typeof config?.sandboxProvider === "string"
      ? config.sandboxProvider.trim()
      : "";
    return provider || "daytona";
  }

  return kind;
}

function runtimeConfigHasValidExecutionMode(runtime: RunRequestBody["runtime"]): boolean {
  const config = readRuntimeConfig(runtime);
  return normalizeWorkflowExecutionMode(config?.executionMode) !== null;
}

function supportsSharedSandbox(runtime: RuntimeDescriptor): boolean {
  const config = isRecord(runtime.config) ? runtime.config : {};
  const provider = typeof config.sandboxProvider === "string"
    ? config.sandboxProvider.trim()
    : "";
  return runtime.id !== "worker" && (!provider || provider === "daytona");
}

/**
 * Shared-sandbox is gated to MSD review-shaped requests. The spec defines this
 * mode for relay-backed PR review only — other surfaces still go through the
 * default per-step-sandbox path. Look for the canonical MSD review markers:
 *   - runtime.config.source === "msd-review", OR
 *   - inputs.repository.fullName + inputs.pullRequest.number (the MSD payload
 *     shape from the runtime contract)
 */
// Whitelist for runtime.config values forwarded into the shared sandbox. Anything
// outside this list — including provider credentials, GitHub tokens, or
// arbitrary caller-supplied keys — is dropped before we serialize into
// MSD_REVIEW_INPUT_JSON. The shared-sandbox boundary is supposed to enforce
// that the sandbox cannot reach outbound credentials it doesn't already get
// through AgentWorkforce-owned credential handling.
const ALLOWED_RUNTIME_CONFIG_KEYS = new Set([
  "executionMode",
  "sandboxProvider",
  "ttlMinutes",
  "source",
  "version",
]);

const ALLOWED_INPUT_KEYS = new Set([
  "repository",
  "pullRequest",
  "profilePlan",
  "gateSnapshot",
  "callback",
]);

const ALLOWED_REPOSITORY_KEYS = new Set(["owner", "name", "fullName"]);
const ALLOWED_PULL_REQUEST_KEYS = new Set(["number", "baseSha", "headSha"]);
const ALLOWED_CALLBACK_KEYS = new Set(["completionUrl"]);

function pickAllowed(
  source: Record<string, unknown>,
  allowed: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (allowed.has(key)) out[key] = source[key];
  }
  return out;
}

function sanitizeRuntimeConfig(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return pickAllowed(value, ALLOWED_RUNTIME_CONFIG_KEYS);
}

function sanitizeRunInputs(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const root = pickAllowed(value, ALLOWED_INPUT_KEYS);
  if (isRecord(root.repository)) {
    root.repository = pickAllowed(root.repository, ALLOWED_REPOSITORY_KEYS);
  }
  if (isRecord(root.pullRequest)) {
    root.pullRequest = pickAllowed(root.pullRequest, ALLOWED_PULL_REQUEST_KEYS);
  }
  if (isRecord(root.callback)) {
    root.callback = pickAllowed(root.callback, ALLOWED_CALLBACK_KEYS);
  }
  // profilePlan and gateSnapshot are forwarded as opaque records but not
  // recursively whitelisted — they're contract-shape-only and are validated
  // by MSD on the receiving end. Reject obviously dangerous keys at the top
  // level (anything containing 'token', 'secret', 'key', 'password').
  for (const fieldName of ["profilePlan", "gateSnapshot"] as const) {
    const field = root[fieldName];
    if (isRecord(field)) {
      const cleaned: Record<string, unknown> = {};
      for (const k of Object.keys(field)) {
        if (/token|secret|password|api[-_]?key/i.test(k)) continue;
        cleaned[k] = field[k];
      }
      root[fieldName] = cleaned;
    }
  }
  return root;
}

function readLaunchFailureIssueNumber(inputs: unknown): number | null {
  if (!isRecord(inputs)) return null;
  const value = inputs.issueNumber;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function buildWorkflowLaunchFailureNotification(input: {
  inputs: unknown;
  githubWriteGrant: ReturnType<typeof resolveWorkflowGithubWriteGrant>;
}): WorkflowLaunchEnvelope["failureNotification"] | undefined {
  if (!input.githubWriteGrant) return undefined;
  const issueNumber = readLaunchFailureIssueNumber(input.inputs);
  if (!issueNumber) return undefined;
  return {
    githubIssue: {
      owner: input.githubWriteGrant.owner,
      repo: input.githubWriteGrant.repo,
      issueNumber,
    },
  };
}

function isMsdReviewShapedRequest(
  runtime: RuntimeDescriptor,
  inputs: unknown,
): boolean {
  const config = isRecord(runtime.config) ? runtime.config : {};
  const declaredSource = typeof config.source === "string"
    ? config.source.trim()
    : "";
  if (declaredSource === "msd-review") {
    return true;
  }
  if (!isRecord(inputs)) {
    return false;
  }
  const repository = isRecord(inputs.repository) ? inputs.repository : null;
  const pullRequest = isRecord(inputs.pullRequest) ? inputs.pullRequest : null;
  const repoFullName = repository && typeof repository.fullName === "string"
    ? repository.fullName.trim()
    : "";
  const prNumber = pullRequest && typeof pullRequest.number === "number"
    ? pullRequest.number
    : NaN;
  return repoFullName.length > 0 && Number.isFinite(prNumber);
}

function normalizeFileType(raw: WorkflowFileType): "yaml" | "typescript" | "python" {
  switch (raw) {
    case "ts":
      return "typescript";
    case "py":
      return "python";
    case "yaml":
      return "yaml";
  }
}

function extractAgentClisFromScript(source: string): string[] {
  const cliPattern = /cli:\s*["']([a-z]+)["']/g;
  const clis = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = cliPattern.exec(source)) !== null) {
    clis.add(match[1]);
  }

  return [...clis];
}

function describeErrorCauseChain(error: unknown): Array<Record<string, string>> {
  const chain: Array<Record<string, string>> = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current != null; depth += 1) {
    if (typeof current !== "object") {
      chain.push({ value: String(current) });
      break;
    }
    const record = current as Record<string, unknown>;
    const link: Record<string, string> = {};
    for (const field of [
      "name",
      "code",
      "severity",
      "message",
      "detail",
      "hint",
      "constraint",
      "table",
      "column",
      "schema",
      "routine",
    ] as const) {
      const value = record[field];
      if (typeof value === "string" && value.length > 0) {
        link[field] = value.slice(0, 500);
      }
    }
    if (Object.keys(link).length > 0) {
      chain.push(link);
    }
    if (!("cause" in record) || record.cause === current) {
      break;
    }
    current = record.cause;
  }
  return chain;
}

type WorkflowOwnerIdentity = {
  userId: string;
  organizationId: string;
};

async function resolveWorkflowOwnerIdentity(auth: RequestAuth): Promise<WorkflowOwnerIdentity> {
  if (auth.source !== "relayfile" || !auth.relayfileSponsorId) {
    return { userId: auth.userId, organizationId: auth.organizationId };
  }

  const rows = await getDb()
    .select({
      deployedByUserId: agents.deployedByUserId,
      organizationId: workspaces.organizationId,
    })
    .from(agents)
    .innerJoin(workspaces, eq(workspaces.id, agents.workspaceId))
    .where(
      and(
        eq(agents.id, auth.relayfileSponsorId),
        eq(agents.workspaceId, auth.workspaceId),
        eq(workspaces.id, auth.workspaceId),
      ),
    )
    .limit(1);
  const row = rows[0];
  const deployedByUserId = row?.deployedByUserId;
  const organizationId = row?.organizationId;
  if (
    typeof deployedByUserId === "string" &&
    deployedByUserId.length > 0 &&
    typeof organizationId === "string" &&
    organizationId.length > 0
  ) {
    return { userId: deployedByUserId, organizationId };
  }

  console.warn("Delegated workflow owner lookup could not resolve deploying identity", {
    workspaceId: auth.workspaceId,
    relayfileSponsorId: auth.relayfileSponsorId,
    authUserId: auth.userId,
    authOrganizationId: auth.organizationId,
  });
  throw new Error("Delegated workflow owner identity could not be resolved");
}

const RESERVED_ENV_KEYS = new Set([
  "RUN_ID", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_SESSION_TOKEN",
  "S3_BUCKET", "S3_PREFIX", "S3_CODE_KEY", "S3_PATHS", "RELAY_API_KEY", "RELAY_WORKSPACE_ID",
  "USER_ID", "CLOUD_API_URL", "CLOUD_API_ACCESS_TOKEN", "CLOUD_API_REFRESH_TOKEN",
  "CLOUD_API_ACCESS_TOKEN_EXPIRES_AT", "AWS_REGION", "CALLBACK_URL", "CALLBACK_TOKEN",
  "WORKFLOW_CONFIG", "CLI_CREDENTIALS", "WORKFLOW_FILE", "INTERACTIVE",
  "WORKFLOW_EXECUTION_MODE", "WORKFLOW_OBSERVER_URL", "MSD_REVIEW_INPUT_JSON",
  "MSD_REVIEW_INPUT_PATH", "AGENT_WORKFORCE_SHARED_SANDBOX_ID", "AGENT_WORKFORCE_SHARED_WORKDIR",
  "RESUME_RUN_ID", "START_FROM", "PREVIOUS_RUN_ID",
  "RELAY_BROKER_API_KEY", "RELAY_BROKER_API_PORT",
  "RELAYFILE_URL", "RELAYFILE_TOKEN", "RELAYFILE_WORKSPACE", "RELAYFILE_WORKSPACE_ID",
  "RELAY_LLM_PROXY", "RELAY_LLM_PROXY_URL", "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL",
  "GOOGLE_API_BASE", "OPENAI_API_BASE", "CREDENTIAL_PROXY_TOKEN", "RELAY_LLM_PROXY_TOKEN",
  "DAYTONA_API_KEY", "DAYTONA_JWT_TOKEN", "DAYTONA_ORGANIZATION_ID", "SANDBOX_ID",
  "CREDENTIAL_PROXY_URL", "CREDENTIAL_PROXY_TOKENS",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE",
  "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL",
  "OPENROUTER_API_KEY",
  "GOOGLE_API_KEY", "GOOGLE_API_BASE",
  "WORKFORCE_WORKSPACE_TOKEN",
]);

// SST's Resource proxy throws synchronously when accessing an unlinked
// resource, so optional chaining alone won't gate the fallback. Use this for
// values that are wired through `link:` in infra (real sst.Secret / Linkable
// resources) and may also be supplied via env in local dev.
function resolveLinkedSecret(name: string, fallbackEnvVar: string): string | undefined {
  let linked: string | undefined;
  try {
    linked = (Resource as unknown as Record<string, { value?: string } | undefined>)[name]?.value;
  } catch {
    linked = undefined;
  }
  return linked && linked.length > 0 ? linked : optionalEnv(fallbackEnvVar);
}

function normalizeMetadataEnv(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const metadata: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (
      typeof rawValue !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
      RESERVED_ENV_KEYS.has(key)
    ) {
      continue;
    }
    metadata[key] = rawValue;
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function readWorkflowInvocationIssueNumber(
  metadata: Record<string, string> | undefined,
): number | null {
  const raw = metadata?.invocationArgs;
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as { issueNumber?: unknown };
    if (
      typeof parsed.issueNumber === "number" &&
      Number.isSafeInteger(parsed.issueNumber) &&
      parsed.issueNumber > 0
    ) {
      return parsed.issueNumber;
    }
    if (
      typeof parsed.issueNumber === "string" &&
      /^\d+$/.test(parsed.issueNumber.trim())
    ) {
      const issueNumber = Number(parsed.issueNumber);
      return Number.isSafeInteger(issueNumber) && issueNumber > 0
        ? issueNumber
        : null;
    }
    return null;
  } catch {
    return null;
  }
}

function withWorkflowGithubWriteToken(
  envSecrets: Record<string, string> | undefined,
  token: string,
  envTokenNames: readonly string[],
): Record<string, string> {
  const merged = { ...(envSecrets ?? {}) };
  for (const envName of envTokenNames) {
    if (!RESERVED_ENV_KEYS.has(envName)) {
      merged[envName] = token;
    }
  }
  return merged;
}

async function resolveRelayfileSponsorDeployedName(auth: RequestAuth): Promise<string | null> {
  if (auth.source !== "relayfile" || !auth.relayfileSponsorId) {
    return null;
  }

  try {
    const rows = await getDb()
      .select({
        deployedName: agents.deployedName,
      })
      .from(agents)
      .innerJoin(workspaces, eq(workspaces.id, agents.workspaceId))
      .where(
        and(
          eq(agents.id, auth.relayfileSponsorId),
          eq(agents.workspaceId, auth.workspaceId),
          eq(workspaces.id, auth.workspaceId),
        ),
      )
      .limit(1);

    const deployedName = rows[0]?.deployedName;
    return typeof deployedName === "string" && deployedName.length > 0
      ? deployedName
      : null;
  } catch (error) {
    console.warn("[workflows/run] could not resolve relayfile sponsor deployedName for GitHub write grant", {
      workspaceId: auth.workspaceId,
      relayfileSponsorId: auth.relayfileSponsorId,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function isRunRequestBody(payload: unknown): payload is RunRequestBody {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const body = payload as Partial<RunRequestBody> & { fileType?: unknown };
  return (
    typeof body.workflow === "string" &&
    body.workflow.trim().length > 0 &&
    typeof body.fileType === "string" &&
    ["yaml", "ts", "py"].includes(body.fileType) &&
    (body.sourceFileType === undefined ||
      (typeof body.sourceFileType === "string" &&
        ["yaml", "ts", "py", "workflow"].includes(body.sourceFileType))) &&
    (body.runId === undefined || typeof body.runId === "string") &&
    (body.s3CodeKey === undefined || typeof body.s3CodeKey === "string") &&
    (body.resume === undefined || typeof body.resume === "string") &&
    (body.startFrom === undefined || typeof body.startFrom === "string") &&
    (body.previousRunId === undefined || typeof body.previousRunId === "string") &&
    (body.workspaceId === undefined || typeof body.workspaceId === "string") &&
    normalizePathSubmissions(body.paths) !== null &&
    // normalizeWorkflowPathParam trims + validates; we only need a
    // presence/absence test here, the call site re-normalizes before use.
    (body.workflowPath === undefined ||
      normalizeWorkflowPathParam(body.workflowPath) !== null) &&
    (body.runtime === undefined ||
      (!!body.runtime &&
        typeof body.runtime === "object" &&
        !Array.isArray(body.runtime) &&
        (body.runtime.id === undefined || typeof body.runtime.id === "string") &&
        (body.runtime.kind === undefined || typeof body.runtime.kind === "string") &&
        !!resolveRuntimeId(body.runtime) &&
        runtimeConfigHasValidExecutionMode(body.runtime))) &&
    (body.envSecrets === undefined ||
      (typeof body.envSecrets === "object" &&
        body.envSecrets !== null &&
        !Array.isArray(body.envSecrets) &&
        Object.values(body.envSecrets).every((v) => typeof v === "string") &&
        Object.keys(body.envSecrets).every(
          (k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !RESERVED_ENV_KEYS.has(k),
        )))
  );
}

// Runtime ids the route knows how to honor. Anything else is rejected at
// resolve time rather than silently falling through to the Daytona launch
// path — a request like `runtime: { id: "foo" }` should fail with a clear
// error, not provision a sandbox the caller did not ask for.
const SUPPORTED_RUNTIME_IDS = new Set(["daytona", "worker"]);

function resolveRequestedRuntime(body: RunRequestBody): RuntimeDescriptor | null {
  const runtimeId = resolveRuntimeId(body.runtime);
  const config = body.runtime?.config;
  const executionMode = normalizeWorkflowExecutionMode(readRuntimeConfig(body.runtime)?.executionMode) ?? "per-step-sandbox";

  // No runtime field at all → workspace-default daytona launch.
  if (!body.runtime) {
    return { id: "daytona", executionMode };
  }

  // Runtime supplied but not resolvable to an id we honor → reject.
  if (!runtimeId || !SUPPORTED_RUNTIME_IDS.has(runtimeId)) {
    return null;
  }

  return {
    id: runtimeId,
    config,
    executionMode,
  };
}

function resolveWorkerSelection(config: unknown): WorkerSelection | undefined {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return undefined;
  }

  const candidate = config as Record<string, unknown>;
  const workerId = typeof candidate.workerId === "string" ? candidate.workerId.trim() : "";
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const tags = Array.isArray(candidate.tags)
    ? candidate.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean)
    : [];

  if (!workerId && !name && tags.length === 0) {
    return undefined;
  }

  return {
    ...(workerId ? { workerId } : {}),
    ...(name ? { name } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

function resolveWorkflowFileName(fileType: WorkflowFileType): string {
  switch (fileType) {
    case "ts":
      return "workflow.ts";
    case "py":
      return "workflow.py";
    case "yaml":
      return "workflow.yaml";
  }
}

// Carries a pre-built HTTP response out of performLaunch for pre-launch
// validation/misconfig cases (no CLI creds, missing storage role, bad Daytona
// auth). The synchronous shared-sandbox gate awaits performLaunch and the
// outer catch unwraps `.response`; the backgrounded per-step path treats it as
// any other launch failure (logs + marks the run failed). `super(runErrorMessage)`
// sets `.message` to the real human text (not a sentinel) so the per-step
// background catch records the actual failure reason on the run row.
class LaunchResponseError extends Error {
  constructor(readonly response: NextResponse, runErrorMessage: string) {
    super(runErrorMessage);
    this.name = "LaunchResponseError";
  }
}

const cloudflareContextSymbol = Symbol.for("__cloudflare-context__");

function readCloudflareWaitUntil(): ((promise: Promise<unknown>) => void) | undefined {
  const context = (globalThis as Record<symbol, unknown>)[cloudflareContextSymbol];
  if (!context || typeof context !== "object") {
    return undefined;
  }
  // `ExecutionContext.waitUntil` is a Cloudflare C++ binding that requires
  // its original receiver as `this`. Extracting the method into a local
  // variable and calling it bare (`waitUntil(promise)`) loses that `this`
  // and throws `Illegal invocation`. The closures below dispatch via
  // property access on the receiver so the native binding sees the
  // correct `this`.
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

function isDurableWorkflowLaunchEnabled(): boolean {
  const raw = optionalEnv("WORKFLOW_LAUNCH_QUEUE_ENABLED")?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export async function POST(request: NextRequest) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!isRunRequestBody(body)) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const isDelegatedWorkspaceInvocation =
    request.headers.get(WORKSPACE_WORKFLOW_INVOCATION_DELEGATION_HEADER) ===
    WORKSPACE_WORKFLOW_INVOCATION_DELEGATION_TOKEN;
  const requestedWorkspaceId = body.workspaceId?.trim();
  if (requestedWorkspaceId && requestedWorkspaceId !== auth.workspaceId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // Allow browser sessions, legacy CLI auth, the existing same-process
  // workspace wrapper nonce, or a verified workspace token scoped for
  // workflow invocation. Direct scoped-token calls run in auth.workspaceId.
  if (
    !requireSessionAuth(auth) &&
    !requireAuthScope(auth, "cli:auth") &&
    !isDelegatedWorkspaceInvocation &&
    !requireAuthScope(auth, "workflow:invoke:write")
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const runId = body.runId?.trim() || crypto.randomUUID();
  const callbackToken = crypto.randomUUID();
  const { relayfileUrl, relayAuthUrl, relayAuthApiKey } = resolveRelayfileConfig();
  const rawWorkflow = body.workflow.trim();
  const fileType = body.fileType;
  const storedSourceFileType = body.sourceFileType ?? fileType;
  const normalizedFileType = normalizeFileType(fileType);
  const runtimeDesc = resolveRequestedRuntime(body);
  if (!runtimeDesc) {
    return NextResponse.json(
      {
        error: "unsupported_runtime",
        message: "runtime.id (or runtime.kind) does not resolve to a supported runtime; supported: daytona, worker.",
      },
      { status: 400 },
    );
  }
  if (runtimeDesc.executionMode === "shared-sandbox") {
    if (!supportsSharedSandbox(runtimeDesc)) {
      return NextResponse.json(
        { error: "shared_sandbox_unsupported", runtime: runtimeDesc.id },
        { status: 400 },
      );
    }
    if (!isMsdReviewShapedRequest(runtimeDesc, body.inputs)) {
      return NextResponse.json(
        {
          error: "shared_sandbox_source_unsupported",
          message:
            "shared-sandbox is only available for MSD review runs (runtime.config.source='msd-review' or MSD-shaped inputs)",
        },
        { status: 400 },
      );
    }
  }
  const resumeRunId = body.resume?.trim() || undefined;
  const startFrom = body.startFrom?.trim() || undefined;
  const previousRunId = body.previousRunId?.trim() || undefined;
  const metadata = normalizeMetadataEnv(body.metadata);
  const submittedPaths = normalizePathSubmissions(body.paths) ?? [];
  const appOrigin = getConfiguredAppOrigin();
  let effectiveEnvSecrets = body.envSecrets;
  const durableLaunchEnabled =
    runtimeDesc.id !== "worker" &&
    runtimeDesc.executionMode === "per-step-sandbox" &&
    isDurableWorkflowLaunchEnabled();
  let workflowOwnerUserId = auth.userId;
  let workflowOwnerOrganizationId = auth.organizationId;
  let workflowOwnerIdentityResolved = false;
  const resolveWorkflowOwnerForRun = async (): Promise<WorkflowOwnerIdentity> => {
    if (!workflowOwnerIdentityResolved) {
      const workflowOwner = await resolveWorkflowOwnerIdentity(auth);
      workflowOwnerUserId = workflowOwner.userId;
      workflowOwnerOrganizationId = workflowOwner.organizationId;
      workflowOwnerIdentityResolved = true;
    }
    return { userId: workflowOwnerUserId, organizationId: workflowOwnerOrganizationId };
  };

  const githubWriteGrant = resolveWorkflowGithubWriteGrant(metadata?.invocationSlug);
  if (githubWriteGrant) {
    const githubWriteEnvTokenNames = githubWriteGrant.envTokenNames ?? [];
    // Repo-write authority comes only from the server-side registry and the
    // deployed persona identity bound to the relayfile sponsor. A
    // caller-controlled metadata slug is not enough to mint a token for
    // browser sessions, generic API tokens, or another delegated agent.
    if (
      auth.source !== "relayfile" ||
      !auth.relayfileSponsorId ||
      !requireAuthScope(auth, "workflow:invoke:write")
    ) {
      return NextResponse.json(
        {
          error: "github_write_forbidden",
          message: "Registered GitHub-write workflows require a relayfile persona invocation.",
        },
        { status: 403 },
      );
    }

    const sponsorDeployedName = await resolveRelayfileSponsorDeployedName(auth);
    if (sponsorDeployedName !== githubWriteGrant.slug) {
      return NextResponse.json(
        {
          error: "github_write_forbidden",
          message: "Registered GitHub-write workflows require the matching deployed persona sponsor.",
        },
        { status: 403 },
      );
    }

    if (auth.bearerToken?.trim()) {
      effectiveEnvSecrets = {
        ...(effectiveEnvSecrets ?? {}),
        WORKFORCE_WORKSPACE_TOKEN: auth.bearerToken,
      };
      console.log("[workflows/run] forwarded relayfile persona token for registered GitHub write workflow", {
        runId,
        workspaceId: auth.workspaceId,
        invocationSlug: githubWriteGrant.slug,
        relayfileSponsorId: auth.relayfileSponsorId,
      });
    } else {
      console.warn("[workflows/run] registered GitHub write workflow had no relayfile bearer token to forward", {
        runId,
        workspaceId: auth.workspaceId,
        invocationSlug: githubWriteGrant.slug,
        relayfileSponsorId: auth.relayfileSponsorId,
      });
    }

    if (durableLaunchEnabled) {
      console.log("[workflows/run] deferring registered GitHub write token handling to workflow launch consumer", {
        runId,
        workspaceId: auth.workspaceId,
        invocationSlug: githubWriteGrant.slug,
        repo: `${githubWriteGrant.owner}/${githubWriteGrant.repo}`,
        injectSandboxToken: githubWriteEnvTokenNames.length > 0,
      });
    } else if (githubWriteEnvTokenNames.length === 0) {
      console.log("[workflows/run] registered GitHub write grant does not request sandbox token injection", {
        runId,
        workspaceId: auth.workspaceId,
        invocationSlug: githubWriteGrant.slug,
        repo: `${githubWriteGrant.owner}/${githubWriteGrant.repo}`,
      });
    } else {
      try {
        const workflowOwner = await resolveWorkflowOwnerForRun();
        const minted = await mintWorkflowGithubWriteToken({
          userId: workflowOwner.userId,
          workspaceId: auth.workspaceId,
          repoOwner: githubWriteGrant.owner,
          repoName: githubWriteGrant.repo,
        });
        effectiveEnvSecrets = withWorkflowGithubWriteToken(
          effectiveEnvSecrets,
          minted.token,
          githubWriteEnvTokenNames,
        );
        console.log("[workflows/run] minted GitHub write token for registered workflow", {
          runId,
          workspaceId: auth.workspaceId,
          invocationSlug: githubWriteGrant.slug,
          repo: `${githubWriteGrant.owner}/${githubWriteGrant.repo}`,
          installationId: minted.installationId,
          repositoryScoped: minted.repositoryScoped,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[workflows/run] GitHub write token mint failed", {
          runId,
          workspaceId: auth.workspaceId,
          invocationSlug: githubWriteGrant.slug,
          repo: `${githubWriteGrant.owner}/${githubWriteGrant.repo}`,
          code: error instanceof WorkflowGithubWriteTokenError ? error.code : "unexpected",
          message,
        });
        if (error instanceof WorkflowGithubWriteTokenError) {
          return NextResponse.json(
            {
              error: error.code,
              message,
              repoOwner: githubWriteGrant.owner,
              repoName: githubWriteGrant.repo,
            },
            { status: error.status },
          );
        }
        return NextResponse.json(
          {
            error: "github_write_token_unavailable",
            message: "Could not mint a GitHub write token for this workflow.",
          },
          { status: 503 },
        );
      }
    }
  }

  for (const entry of submittedPaths) {
    if (!entry.repoOwner || !entry.repoName) {
      // Non-git/unresolved remotes are read-only mounts in Phase B; no
      // allowlist lookup is needed because no push-back can happen.
      continue;
    }

    // Validate via the relaxed-mode resolver. After cloud#439, the
    // resolver throws on infrastructure misconfiguration (e.g. missing
    // Nango secret binding) instead of silently treating it as "App
    // can't reach repo". Translate those throws into a clear 503 for
    // the operator instead of a 500 stack trace, and reserve the 400
    // `repo_not_allowlisted` for the legitimate "no install reachable
    // / no install at all" case (resolver returns null cleanly).
    let allow;
    try {
      allow = await resolveRepoAllowlistOrRelaxed(
        auth.workspaceId,
        entry.repoOwner,
        entry.repoName,
      );
    } catch (resolverErr) {
      const message = resolverErr instanceof Error ? resolverErr.message : String(resolverErr);
      console.error("[workflows/run] allowlist resolver threw — likely infra misconfig", {
        runId,
        workspaceId: auth.workspaceId,
        repoOwner: entry.repoOwner,
        repoName: entry.repoName,
        message,
      });
      return NextResponse.json(
        {
          error: "allowlist_resolver_unavailable",
          repoOwner: entry.repoOwner,
          repoName: entry.repoName,
          message,
        },
        { status: 503 },
      );
    }
    if (!allow) {
      return NextResponse.json(
        {
          error: "repo_not_allowlisted",
          repoOwner: entry.repoOwner,
          repoName: entry.repoName,
          manageUrl: toAbsoluteAppUrl(
            appOrigin,
            "/integrations/github/repos",
          ).toString(),
        },
        { status: 400 },
      );
    }
    // Phase B deliberately ignores allow.pushAllowed and installationId.
    // The sandbox receives only read-only mount coordinates; Phase C owns
    // all GitHub token and push-back plumbing.
  }

  // For YAML workflows, parse to JSON so the bootstrap can JSON.parse() it
  let workflow: string;
  if (fileType === "yaml") {
    try {
      const { parse: parseYaml } = await import("yaml");
      const parsed = parseYaml(rawWorkflow);
      workflow = JSON.stringify(parsed);
    } catch (err) {
      return NextResponse.json(
        { error: `Invalid YAML: ${err instanceof Error ? err.message : String(err)}` },
        { status: 400 }
      );
    }
  } else {
    workflow = rawWorkflow;
  }
  // CREDENTIAL_PROXY_URL is a plain Worker URL set via infra `environment:`,
  // not an SST Linkable — read it from env directly.
  const credentialProxyUrl = optionalEnv("CREDENTIAL_PROXY_URL");
  const credentialProxyJwtSecret = resolveLinkedSecret(
    "CredentialProxyJwtSecret",
    "CREDENTIAL_PROXY_JWT_SECRET",
  );
  const credentialProxyEnabled = Boolean(credentialProxyUrl && credentialProxyJwtSecret);
  try {
    const t0 = Date.now();
    const elapsed = () => `${Date.now() - t0}ms`;
    console.log(`[run] Starting workflow ${runId}`);
    await resolveWorkflowOwnerForRun();

    if (runtimeDesc.id === "worker") {
      await runWorkerAssignmentMaintenance();

      if (!relayfileUrl || !relayAuthApiKey) {
        console.error("Worker dispatch requested without relayfile configuration");
        return NextResponse.json(
          { error: "internal" },
          { status: 500 },
        );
      }

      const registry = new WorkerRegistry();
      const selection = resolveWorkerSelection(runtimeDesc.config);
      let worker: Awaited<ReturnType<WorkerRegistry["select"]>>;
      try {
        worker = await registry.select(auth.workspaceId, selection);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Worker unavailable";
        const status = message.includes("not found") ? 404 : 409;
        return NextResponse.json({ error: message }, { status });
      }

      // Let errors bubble to the outer catch, which owns token-session
      // and workflow-row cleanup. A dedicated 500 here would bypass that.
      const resolvedRelayWorkspace = await resolveOrProvisionRelayWorkspace({
        userId: workflowOwnerUserId,
        appWorkspaceId: auth.workspaceId,
      });
      const relayWorkspaceId = resolvedRelayWorkspace.id;
      const relaycastApiKey = resolvedRelayWorkspace.relaycastApiKey;
      if (resolvedRelayWorkspace.provisioned) {
        console.log(
          `[run] Auto-provisioned relay workspace ${relayWorkspaceId} for user ${workflowOwnerUserId}`,
        );
      }
      await ensureRelayWorkspace(relayWorkspaceId, { ignored: [], readonly: [] });
      const relayfileToken = await mintRelayfileToken({
        workspaceId: relayWorkspaceId,
        relayAuthUrl,
        relayAuthApiKey,
      });
      // TODO: Worker log and step-metadata parity still needs a dedicated worker ingest path or a different credential model.
      const workflowRef = packageWorkflowRef({
        runId,
        workspaceId: auth.workspaceId,
        relayWorkspaceId,
        relaycastApiKey,
        relaycastBaseUrl: resolveRelaycastUrl(),
        relayfileUrl,
        relayfileToken,
        workflow: rawWorkflow,
        fileType,
        sourceFileType: storedSourceFileType,
        workflowFileName: resolveWorkflowFileName(fileType),
        envSecrets: effectiveEnvSecrets,
        metadata,
        s3CodeKey: body.s3CodeKey?.trim() || undefined,
        // Multi-repo: forward `paths` so the worker can mount per-repo dirs
        // alongside (or instead of) the legacy single-mount s3CodeKey path.
        // Without this, a multi-path submit dispatched to a worker has no
        // way to discover the per-path tarballs it should download.
        paths: submittedPaths.length > 0 ? submittedPaths : undefined,
        resumeRunId,
        startFrom,
        previousRunId,
      });

      try {
        await workflowStore.create({
          runId,
          sandboxId: null,
          dispatchType: "worker",
          userId: workflowOwnerUserId,
          workspaceId: auth.workspaceId,
          relayWorkspaceId,
          workflow,
          fileType,
          callbackToken,
          status: "pending",
          paths: submittedPaths.length > 0 ? submittedPaths : undefined,
        });

        const assignment = await enqueueForWorker({
          worker,
          workspaceId: auth.workspaceId,
          runId,
          workflowRef,
          maxQueueWaitMs: 10 * 60 * 1000,
        });

        return NextResponse.json({
          runId,
          dispatchedTo: worker.name,
          assignmentId: assignment.id,
          status: "pending",
        });
      } catch (error) {
        try {
          await workflowStore.update(runId, {
            status: "failed",
            error: error instanceof Error ? error.message : "worker-dispatch-failed",
          });
        } catch {
          // best-effort cleanup for a partially-created worker run
        }
        throw error;
      }
    }

    // Daytona path. The requested execution mode decides whether the run row
    // is created up front: per-step backgrounds the launch and needs the row
    // to exist so status polls (GET /workflows/runs/{runId}) resolve
    // immediately; shared-sandbox awaits the launch synchronously and creates
    // the row on success inside performLaunch (create-after-success), so a
    // failed shared launch leaves no stuck "pending" row.
    const isSharedSandbox = runtimeDesc.executionMode === "shared-sandbox";
    if (!isSharedSandbox) {
      // Per-step: create up front. sandboxId/relayWorkspaceId are filled in by
      // performLaunch once the launch completes (via workflowStore.update).
      await workflowStore.create({
        runId,
        sandboxId: null,
        dispatchType: "sandbox",
        userId: workflowOwnerUserId,
        workspaceId: auth.workspaceId,
        workflow,
        fileType,
        callbackToken,
        status: "pending",
        paths: submittedPaths.length > 0 ? submittedPaths : undefined,
      });
    }

    if (durableLaunchEnabled) {
      let launchJobId: string | null = null;
      try {
        const launchEnvelope: WorkflowLaunchEnvelope = {
          runId,
          callbackToken,
          appOrigin,
          workflowOwnerUserId,
          workflowOwnerOrganizationId,
          workspaceId: auth.workspaceId,
          rawWorkflow,
          workflow,
          fileType,
          sourceFileType: storedSourceFileType,
          normalizedFileType,
          runtime: {
            id: runtimeDesc.id,
            executionMode: runtimeDesc.executionMode,
            config: sanitizeRuntimeConfig(runtimeDesc.config),
          },
          s3CodeKey: body.s3CodeKey?.trim() || undefined,
          workflowPath: normalizeWorkflowPathParam(body.workflowPath) ?? undefined,
          envSecrets: effectiveEnvSecrets,
          metadata,
          paths: submittedPaths,
          resumeRunId,
          startFrom,
          previousRunId,
          runInputs: sanitizeRunInputs(body.inputs),
          failureNotification: buildWorkflowLaunchFailureNotification({
            inputs: body.inputs,
            githubWriteGrant,
          }),
          githubWrite: githubWriteGrant && auth.relayfileSponsorId
            ? {
                slug: githubWriteGrant.slug,
                owner: githubWriteGrant.owner,
                repo: githubWriteGrant.repo,
                envTokenNames: [...(githubWriteGrant.envTokenNames ?? [])],
                relayfileSponsorId: auth.relayfileSponsorId,
              }
            : undefined,
        };
        const job = await createWorkflowLaunchJob({
          runId,
          userId: workflowOwnerUserId,
          workspaceId: auth.workspaceId,
          organizationId: workflowOwnerOrganizationId,
          requestEnvelope: await encryptWorkflowLaunchEnvelopeAsync(
            launchEnvelope,
            Resource.CredentialEncryptionKey.value,
          ),
        });
        launchJobId = job.id;
        await enqueueWorkflowLaunchJob({ jobId: job.id, runId });
        console.log("[run] Durable workflow launch enqueued", {
          runId,
          launchJobId: job.id,
        });
        console.log("[gate-b-resolver-diag] workflow-launch-enqueued", {
          runId,
          launchJobId: job.id,
          workspaceId: auth.workspaceId,
          invocationSlug: metadata?.invocationSlug ?? null,
          issueNumber: readWorkflowInvocationIssueNumber(metadata),
          runtimeId: runtimeDesc.id,
          executionMode: runtimeDesc.executionMode,
        });
        return NextResponse.json({ runId, status: "pending", launchJobId: job.id });
      } catch (error) {
        const message = error instanceof Error ? error.message : "workflow-launch-enqueue-failed";
        console.error("[run] Durable workflow launch enqueue failed", {
          runId,
          launchJobId,
          message,
        });
        console.error("[gate-b-resolver-diag] workflow-launch-enqueue-failed", {
          runId,
          launchJobId,
          workspaceId: auth.workspaceId,
          invocationSlug: metadata?.invocationSlug ?? null,
          issueNumber: readWorkflowInvocationIssueNumber(metadata),
          runtimeId: runtimeDesc.id,
          executionMode: runtimeDesc.executionMode,
        });
        if (launchJobId) {
          try {
            await markWorkflowLaunchJobFailed(getDb(), launchJobId, message);
          } catch {
            // best-effort job failure marker
          }
        }
        try {
          await workflowStore.update(runId, {
            status: "failed",
            error: message,
          });
        } catch {
          // best-effort run failure marker
        }
        return NextResponse.json(
          {
            error: "workflow_launch_enqueue_failed",
            message,
          },
          { status: 503 },
        );
      }
    }

    // The credential resolution + sandbox launch is expensive (>15s). It is
    // wrapped in a closure so the per-step-sandbox path can run it in the
    // background (via waitUntil) and respond immediately, while the
    // shared-sandbox path awaits it for the observerUrl/workdir response.
    // performLaunch OWNS its own token-session cleanup on failure because the
    // backgrounded version's throw never reaches the outer catch.
    const performLaunch = async (): Promise<{
      sandboxId: string;
      launchedExecutionMode: WorkflowExecutionMode;
      launchedObserverUrl: string;
      launchedWorkdir: string;
      relayWorkspaceId: string;
    }> => {
    let tokenSessionId: string | null = null;
    try {
    const apiUrl = toAbsoluteAppUrl(appOrigin, "/").toString();
    const observerUrl = toAbsoluteAppUrl(appOrigin, `/runs/${runId}`).toString();
    const orchestratorLibUrl = toAbsoluteAppUrl(appOrigin, "/orchestrator-lib.tar.gz").toString();
    let orchestratorLibTarball: Uint8Array | undefined;
    try {
      const env = getCloudflareContext({ async: false }).env as
        | { ASSETS?: AssetsBinding }
        | undefined;
      if (env?.ASSETS) {
        const assetUrl = new URL(toAppPath("/orchestrator-lib.tar.gz"), request.url);
        const res = await env.ASSETS.fetch(assetUrl);
        if (res.ok) {
          const buf = new Uint8Array(await res.arrayBuffer());
          if (buf.byteLength > 0 && buf[0] === 0x1f && buf[1] === 0x8b) {
            orchestratorLibTarball = buf;
            console.log("[run] Loaded orchestrator-lib.tar.gz from ASSETS binding", {
              path: assetUrl.pathname,
              sizeBytes: buf.byteLength,
            });
          } else {
            console.warn("[run] ASSETS orchestrator-lib body not a valid gzip; falling back", {
              sizeBytes: buf.byteLength,
            });
          }
        } else {
          console.warn("[run] ASSETS orchestrator-lib fetch not ok", {
            status: res.status,
          });
        }
      }
    } catch (error) {
      console.warn("[run] ASSETS orchestrator-lib load failed (will fall back)", {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    // Determine which credential providers are needed from the workflow config.
    // For YAML workflows, parse the config to check which agent CLIs are used.
    // For TS/PY workflows (source code), load all connected providers.
    // Bundle all providers into a JSON object { anthropic: "...", openai: "..." }
    // so DaytonaStepExecutor can mount the right credentials per agent step.
    let cliCredentials = "";
    const credentialProxyTokens: Record<string, string> = {};
    const isConfigWorkflow = fileType === "yaml";
    const needsCli = isConfigWorkflow ? workflowNeedsCliCredentials(workflow) : true;
    if (needsCli) {
      const providers = isConfigWorkflow
        ? getAllProviders(workflow)
        : await listConnectedProviders(
            workflowOwnerUserId,
            Resource.CredentialEncryptionKey.value,
          );

      if (!isConfigWorkflow && providers.length === 0) {
        throw new LaunchResponseError(
          NextResponse.json(
            { error: "No CLI credentials connected. Run 'agent-relay cloud connect <provider>' first." },
            { status: 400 }
          ),
          "No CLI credentials connected. Run 'agent-relay cloud connect <provider>' first.",
        );
      }

      const rawCredentialBundle: Record<string, string> = {};
      for (const provider of providers) {
        const proxyProvider = credentialProxyEnabled
          ? resolveProxyProviderFromCredentialProvider(provider)
          : undefined;

        if (proxyProvider && credentialProxyJwtSecret) {
          credentialProxyTokens[proxyProvider] ??= await mintCredentialProxyToken({
            subject: auth.workspaceId,
            provider: proxyProvider,
            credentialId: workflowOwnerUserId,
            secret: credentialProxyJwtSecret,
            ttlSeconds: 2 * 60 * 60,
          });
          continue;
        }

        try {
          rawCredentialBundle[provider] = await getCliCredentials(
            workflowOwnerUserId,
            provider,
            Resource.CredentialEncryptionKey.value
          );
        } catch {
          // Provider credentials not found — skip (step will fail if needed)
        }
      }

      const rawProviders = Object.keys(rawCredentialBundle);
      if (rawProviders.length === 1) {
        cliCredentials = rawCredentialBundle[rawProviders[0]];
      } else if (rawProviders.length > 1) {
        cliCredentials = JSON.stringify(rawCredentialBundle);
      }
    }

    const storageBackend = getWorkflowStorageBackend();
    const roleArn = storageBackend === "s3" ? safeWorkflowStorageResource("stsRoleArn") : undefined;
    const bucket = storageBackend === "s3" ? safeWorkflowStorageResource("bucketName") : undefined;
    if (storageBackend === "s3" && !isWorkerRuntime() && (!roleArn || !bucket)) {
      console.error("Workflow launch misconfigured: missing workflow storage role or bucket");
      throw new LaunchResponseError(
        NextResponse.json(
          { error: "internal" },
          { status: 500 }
        ),
        "Workflow launch misconfigured: missing workflow storage role or bucket.",
      );
    }

    let daytonaAuth: ReturnType<typeof resolveServerDaytonaAuthParams>;
    try {
      daytonaAuth = resolveServerDaytonaAuthParams();
    } catch (err) {
      console.error(
        "Workflow launch misconfigured: invalid Daytona server auth params:",
        err instanceof Error ? err.message : String(err),
      );
      throw new LaunchResponseError(
        NextResponse.json(
          { error: "internal" },
          { status: 500 }
        ),
        "Workflow launch misconfigured: invalid Daytona server auth params.",
      );
    }

    const tokenSession = await createApiTokenSession({
      subjectType: "sandbox",
      userId: workflowOwnerUserId,
      workspaceId: auth.workspaceId,
      organizationId: workflowOwnerOrganizationId,
      runId,
      accessTokenTtlSeconds: 4 * 3600,
      scopes: [
        "auth:token:refresh",
        "auth:token:revoke",
        "workflow:invoke:write",
        "workflow:invoke:read",
        "workflow:runs:read",
        "workflow:logs:read",
        "workflow:runs:events:write",
      ],
    });
    tokenSessionId = tokenSession.sessionId;

    const s3Credentials = storageBackend === "r2"
      ? buildCloudApiWorkflowStorageCredentials({
          userId: workflowOwnerUserId,
          runId,
          apiUrl,
          accessToken: tokenSession.accessToken,
          refreshToken: tokenSession.refreshToken,
        })
      : await mintScopedS3Credentials({
          userId: workflowOwnerUserId,
          runId,
          roleArn,
          bucket,
        });
    // Let errors bubble to the outer catch, which owns tokenSession
    // revocation (created above at L410). A dedicated 500 here would
    // bypass that and leak token-session rows on provisioning failures.
    const resolvedRelayWorkspace = await resolveOrProvisionRelayWorkspace({
      userId: workflowOwnerUserId,
      appWorkspaceId: auth.workspaceId,
    });
    const relayWorkspaceId = resolvedRelayWorkspace.id;
    const relayApiKey = resolvedRelayWorkspace.relaycastApiKey;
    if (resolvedRelayWorkspace.provisioned) {
      console.log(
        `[run] Auto-provisioned relay workspace ${relayWorkspaceId} for user ${workflowOwnerUserId}`,
      );
    }
    await ensureRelayWorkspace(relayWorkspaceId, { ignored: [], readonly: [] });

    const credentialBundle = buildCredentialBundle({
      s3Credentials,
      cliCredentials,
      workspaceId: relayWorkspaceId,
      relayApiKey,
      // The relaycast backend the API key was minted against. Must match
      // the URL the broker targets when calling `mcp-args --register`;
      // otherwise the minted key is rejected by the wrong backend.
      relayBaseUrl: resolveRelaycastUrl(),
      runId,
      userId: workflowOwnerUserId,
      cloudApiUrl: apiUrl,
      cloudApiAccessToken: tokenSession.accessToken,
      cloudApiRefreshToken: tokenSession.refreshToken,
      cloudApiAccessTokenExpiresAt: tokenSession.accessTokenExpiresAt,
      credentialProxyUrl: Object.keys(credentialProxyTokens).length > 0
        ? credentialProxyUrl
        : undefined,
      credentialProxyTokens: Object.keys(credentialProxyTokens).length > 0
        ? credentialProxyTokens
        : undefined,
      ...daytonaAuth,
      s3CodeKey: body.s3CodeKey?.trim() || undefined,
      workflowConfig: workflow,
    });

    const callbackUrl = toAbsoluteAppUrl(appOrigin, "/api/v1/workflows/callback").toString();

    console.log(`[run] Credentials ready (${elapsed()}), launching sandbox for ${runId}`);
    const credentialProxy = resolveCredentialProxyConfig();
    const isScriptWorkflow = fileType === "ts" || fileType === "py";
    const workflowFileName = isScriptWorkflow
      ? `workflow.${fileType === "ts" ? "ts" : "py"}`
      : undefined;
    const launchOptions = {
      credentialBundle,
      callbackUrl,
      callbackToken,
      runId,
      ...credentialProxy,
      ...(relayfileUrl ? { relayfileUrl, relayAuthUrl, relayAuthApiKey } : {}),
      s3CodeKey: body.s3CodeKey?.trim() || undefined,
      paths: submittedPaths,
      // Re-normalize at the use site so any future code path that skips
      // isRunRequestBody still has a traversal-safe value. Returns null
      // on failure — paired with `?? undefined` this falls back to the
      // legacy $HOME upload path instead of forwarding an unsafe value.
      workflowPath:
        normalizeWorkflowPathParam(body.workflowPath) ?? undefined,
      fileType: normalizedFileType,
      workflowConfig: isScriptWorkflow ? undefined : workflow,
      agentClis: isScriptWorkflow ? extractAgentClisFromScript(rawWorkflow) : undefined,
      workflowFileContent: isScriptWorkflow ? rawWorkflow : undefined,
      workflowFileName,
      envSecrets: effectiveEnvSecrets,
      metadata,
      resumeRunId,
      startFrom,
      previousRunId,
      brokerSecret: getBrokerKeySecret(),
      executionMode: runtimeDesc.executionMode,
      runtimeConfig: sanitizeRuntimeConfig(runtimeDesc.config),
      runInputs: sanitizeRunInputs(body.inputs),
      observerUrl,
      orchestratorLibTarball,
      orchestratorLibUrl,
    };
    const launchResult = await launchOrchestratorSandbox(launchOptions);
    const sandboxId = launchResult.sandboxId;
    const launchedExecutionMode =
      launchResult.executionMode ?? runtimeDesc.executionMode;
    const launchedObserverUrl = launchResult.observerUrl ?? observerUrl;
    const launchedWorkdir = launchResult.workdir ?? "/project";

    await attachSandboxToApiTokenSession(tokenSession.sessionId, sandboxId);

    const brokerPort = normalizedFileType === "yaml" && deriveInteractive(workflow) ? 9800 : null;

    // Register sandbox so it's accessible independent of the workflow
    const now = new Date();
    await getDb().insert(sandboxes).values({
      id: sandboxId,
      userId: workflowOwnerUserId,
      organizationId: workflowOwnerOrganizationId,
      workspaceId: auth.workspaceId,
      source: "workflow",
      runId,
      status: "running",
      brokerPort,
      createdAt: now,
      updatedAt: now,
    });

    if (isSharedSandbox) {
      // Shared-sandbox: the row was NOT pre-created (create-after-success), so a
      // failed launch above already returned without leaving a stuck row.
      // Create it now that the launch succeeded.
      await workflowStore.create({
        runId,
        sandboxId,
        dispatchType: "sandbox",
        userId: workflowOwnerUserId,
        workspaceId: auth.workspaceId,
        relayWorkspaceId,
        workflow,
        fileType,
        callbackToken,
        status: "pending",
        paths: submittedPaths.length > 0 ? submittedPaths : undefined,
      });
    } else {
      // Per-step: the row was created up front (status polls resolve
      // immediately). Fill in the launch outcome; status stays "pending".
      await workflowStore.update(runId, { sandboxId, relayWorkspaceId });
    }

    // Durably persist shared-sandbox runtime metadata via the session_events
    // table. Schema additions (executionMode/workdir/observerUrl columns) are
    // out of scope for this slice; the events table is the existing durable
    // record reviewers and MSD already consume.
    if (launchedExecutionMode === "shared-sandbox") {
      try {
        const { createDbEventClient } = await import("@cloud/core/session/events.js");
        const schema = await import("@/lib/db/schema");
        const eventClient = createDbEventClient({ db: getDb(), schema });
        await eventClient.emit({
          runId,
          eventType: "sandbox_created",
          sandboxId,
          payload: {
            runId,
            executionMode: "shared-sandbox",
            type: "sandbox.created",
            createdAt: new Date().toISOString(),
            sandboxId,
            workdir: launchedWorkdir,
            observerUrl: launchedObserverUrl,
          },
        });
      } catch (eventErr) {
        // Persistence is best-effort at this layer — the bootstrap also
        // emits sandbox.created from inside the sandbox. Logging the failure
        // (without crashing the launch) preserves the audit trail.
        console.warn(
          "[run] failed to persist shared-sandbox metadata event (non-fatal):",
          eventErr instanceof Error ? eventErr.message : String(eventErr),
        );
      }
    }

    return {
      sandboxId,
      launchedExecutionMode,
      launchedObserverUrl,
      launchedWorkdir,
      relayWorkspaceId,
    };
    } catch (launchErr) {
      // performLaunch OWNS its token-session cleanup: the backgrounded
      // (per-step-sandbox) version's throw never reaches the outer catch.
      if (tokenSessionId) {
        try {
          await revokeApiTokenSessionById(tokenSessionId, "launch_failed");
        } catch {
          // best-effort
        }
      }
      throw launchErr;
    }
    };

    if (isSharedSandbox) {
      const r = await performLaunch();
      console.log(`[run] Sandbox ${r.sandboxId} launched for ${runId} (${elapsed()})`);
      return NextResponse.json({
        runId,
        relayWorkspaceId: r.relayWorkspaceId,
        sandboxId: r.sandboxId,
        observerUrl: r.launchedObserverUrl,
        executionMode: r.launchedExecutionMode,
        workdir: r.launchedWorkdir,
        status: "pending",
      });
    }

    // per-step-sandbox: return the runId now; finish the launch in the background.
    const launchPromise = performLaunch()
      .then(() => {
        console.log(`[run] Background launch complete for ${runId} (${elapsed()})`);
      })
      .catch(async (err) => {
        console.error("[run] Background launch failed:", {
          error: err instanceof Error ? err.message : String(err),
          errorCauseChain: describeErrorCauseChain(err),
          runId,
        });
        try {
          await workflowStore.update(runId, {
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
          });
        } catch {
          // best-effort: the run row failure update is non-fatal
        }
      });
    const waitUntil = readCloudflareWaitUntil();
    if (waitUntil) {
      waitUntil(launchPromise);
    }
    return NextResponse.json({ runId, status: "pending" });
  } catch (err) {
    if (err instanceof LaunchResponseError) {
      return err.response;
    }
    if (err instanceof BrokerClientError) {
      const code = err.status === 429
        ? "workflow_storage_throttled"
        : "workflow_storage_unavailable";
      const message = err.status === 429
        ? "Workflow storage is temporarily throttled. Retry after current launches finish."
        : "Workflow storage is temporarily unavailable.";
      console.error("Workflow launch storage broker failure:", {
        status: err.status,
        message: err.message,
      });
      return NextResponse.json({ error: message, code }, { status: 503 });
    }
    console.error("Workflow launch failed:", {
      error: err instanceof Error ? err.message : String(err),
      errorCauseChain: describeErrorCauseChain(err),
      runId,
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      workflowOwnerUserId,
      workflowOwnerOrganizationId,
      authSource: auth.source,
      sourceFileType: storedSourceFileType,
      fileType,
      runtimeId: runtimeDesc.id,
    });
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

function safeWorkflowStorageResource(prop: "bucketName" | "stsRoleArn"): string | undefined {
  try {
    const resource = Resource.WorkflowStorage as unknown as Record<string, unknown>;
    const value = resource[prop];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
