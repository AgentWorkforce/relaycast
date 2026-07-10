import { Buffer } from "node:buffer";
import { sql } from "drizzle-orm";
import { Resource } from "sst";
import { RelayFileClient } from "@relayfile/sdk";
import {
  ContinuationAlreadyTerminalError,
  ContinuationNotFoundError,
  createContinuationRuntime,
  type ContinuationRecord,
  type ContinuationResumeTrigger,
  type ContinuationResumedTurnInput,
  type HarnessResult,
} from "@agent-assistant/continuation";
import { getSnapshotName } from "@cloud/core/config/snapshot.js";
import {
  buildRelayfileMountCleanupInvocationShell,
  buildRelayfileMountLifecycleShell,
  SandboxOrchestrator,
  type SandboxCapturedOutput,
} from "@cloud/core/executor/sandbox-orchestrator.js";
import {
  WORKFORCE_RUNTIME_AWS_SMITHY_REQUIRE_CHECK,
  WORKFORCE_RUNTIME_AWS_SMITHY_SPECS,
  WORKFORCE_RUNTIME_PACKAGE,
  WORKFORCE_RUNTIME_SMITHY_DIAGNOSTIC,
  WORKFORCE_RUNTIME_SMITHY_LOAD_CHECK,
  WORKFORCE_RUNTIME_SPEC,
  WORKFORCE_RUNTIME_VERSION,
} from "@cloud/core/proactive-runtime/runtime-package.js";
import {
  isConflictAutofixPersona,
  isConversationalPersona,
  isPullRequestReviewerPersona,
  personaWantsPullRequestWriteback,
} from "@cloud/core/proactive-runtime/capabilities.js";
import { isConflictResolvePersona } from "@/lib/proactive-runtime/conflict-resolve-capability";
import {
  CLI_TO_PROVIDER,
  mountCliCredentials,
} from "@cloud/core/auth/cli-credentials.js";
import { CredentialStore } from "@cloud/core/auth/credential-store.js";
import {
  HarnessCredentialExpiredError,
  refreshHarnessCliCredentialIfStale,
} from "@/lib/proactive-runtime/harness-credential-refresh";
import type { RuntimeHandle } from "@cloud/core/runtime/daytona.js";
import {
  mintWorkspaceScopedRelayfileTokenPair,
  mintRelayfileToken,
} from "@cloud/core/relayfile/client.js";
import { eventScopedSyncPaths } from "@cloud/core/relayfile/event-scopes.js";
import {
  normalizeRelayfilePath,
  relayfilePathsForIntegrations,
} from "@cloud/core/relayfile/path-scopes.js";
import {
  githubMaterializeOwnerRootsForMountPaths,
} from "@cloud/core/relayfile/github-materialize.js";
import {
  relayfileTriggerIntegrationsFromAgentOrLegacy,
  deploymentAgentSpec,
  deploymentPersonaSpec,
  relayfileTriggerIntegrationsFromDeploymentSpec,
  type DeploymentAgentSpec,
} from "@cloud/core/proactive-runtime/agent-spec.js";
import { cleanupIndicatesWritebackUndelivered } from "@/lib/proactive-runtime/deployment-run-failure-class";
import { getDb } from "@/lib/db";
// TEMPORARY (instrument-dont-guess, #1516): scrub secrets from the persona-run
// output tail before it reaches the tail/CloudWatch diagnostic. Remove with the
// diagnostic once the in-sandbox failure cause is found.
import { loadBundle } from "@/lib/proactive-runtime/bundle-store";
import {
  createInitialAgentDeployment,
  deriveRelayfileMountPaths,
  getAgentDeploymentTickTarget,
} from "@/lib/proactive-runtime/persona-deploy";
import { PostgresContinuationStore } from "@/lib/proactive-runtime/continuation-adapters";
import { slackUserReplyCorrelationKeyFromPayload } from "@/lib/proactive-runtime/continuation-correlation";
import { isProactiveContinuationResumeEnabled } from "@/lib/proactive-runtime/continuation-flags";
import {
  PR_REVIEWER_BOT_COMMIT_EMAIL,
  PR_REVIEWER_BOT_COMMIT_NAME,
} from "@/lib/proactive-runtime/pr-reviewer-bot-identity";
import {
  createDeploymentSandboxRuntime,
  type DeploymentSandboxRuntime,
} from "@/lib/proactive-runtime/sandbox-runtime";
import {
  acquirePrSandbox,
  releasePrSandboxSlot,
} from "@/lib/proactive-runtime/pr-sandbox-lease";
import {
  acquireConversationSandbox,
  buildSlackConversationKey,
  ConversationSandboxLeaseBusyError,
  markConversationSandboxLeaseAvailable,
  releaseConversationSandboxLease,
} from "@/lib/proactive-runtime/conversation-sandbox-lease";
import {
  deriveCtxLlmEnvFromHarnessCredential,
  resolveDaytonaCredentialRuntimeEnv,
  resolveProviderCredentialRuntimeEnv,
  resolveSubscriptionFallbackEnv,
} from "@/lib/billing/provider-credential-runtime";
import {
  createGithubProxyIssueComment,
  GithubProxyPullRequestError,
  readGithubProxyCommitCheckRuns,
  readGithubProxyPullRequest,
} from "@/lib/integrations/github-proxy-pull-request";
import { mintWorkflowGithubWriteToken } from "@/lib/integrations/github-workflow-write-token";
import {
  buildConflictAutofixComment,
  buildConflictAutofixSandboxScript,
  CONFLICT_AUTOFIX_GIT_TOKEN_ENV,
  conflictAutofixOutcomeIsSuccess,
  matchesConflictResolveDirective,
  parseConflictAutofixOutcome,
  resolveConflictAutofixPlan,
  type ConflictAutofixPlan,
} from "@/lib/proactive-runtime/pull-request-conflict-autofix-dispatch";
import { classifyPullRequestMergeState } from "@/lib/proactive-runtime/pull-request-conflict-autofix";
import { resolveRelayAuthConfig, resolveRelayfileConfig } from "@/lib/relayfile";
import {
  mintPathScopedRelayfileTokenWithWorkspaceCache,
  mintRelayAuthWorkspaceToken,
} from "@/lib/relay-workspaces";
import { resolveGitCloneCredentials } from "@/lib/integrations/github-clone-token";
import {
  buildGitWorkspaceSyncShell,
  normalizeHttpsGitRemote,
} from "@/lib/integrations/git-workspace-sync-script";
import { createCredentialStoreS3Client } from "@/lib/storage";
import { resolveRelayWorkspaceIdForRuntime } from "@/lib/workspaces/workspace-integration-identity-core";
import {
  postLinearAgentSessionTerminalWriteback,
} from "@/lib/integrations/linear-agent-activity-writeback";
import {
  redactRunOutputForDiagnostics,
  runOutputTailForDiagnostics,
} from "@/lib/proactive-runtime/run-output-redaction";
import {
  postSlackConversationTerminalReply,
} from "@/lib/proactive-runtime/slack-conversation-terminal-reply";
import { normalizeSlackChannelId } from "@/lib/integrations/slack-channel-id";
import {
  deploymentRunnerStructuredLogEntries,
  type DeploymentRunnerStructuredLogEntry,
} from "@/lib/proactive-runtime/deployment-run-structured-logs";
export { redactRunOutputForDiagnostics } from "@/lib/proactive-runtime/run-output-redaction";

type DeploymentTriggerPayload = {
  workspaceId: string;
  agentId: string;
  payload: unknown;
  deliveryId?: string;
  target?: NonNullable<Awaited<ReturnType<typeof getAgentDeploymentTickTarget>>>;
  options?: DeploymentTriggerDeliveryOptions;
  provisioningSandboxId?: string | null;
};

type DeploymentResumeContext = {
  continuationId: string;
  resumedTurnId: string;
  triggerType: ContinuationResumeTrigger["type"];
  priorState: {
    status: ContinuationRecord["status"];
    originTurnId: string;
    sessionId?: string;
    threadId?: string;
    userId?: string;
    waitFor: ContinuationRecord["waitFor"];
    resumeAttempts: number;
    continuation: ContinuationRecord["continuation"];
  };
};

type DeploymentHarnessSession = {
  id: string;
  resume: boolean;
};

export type DeploymentTriggerDeliveryOptions = {
  sandboxCreateTimeoutSeconds?: number;
  sandboxProvisionPollIntervalMs?: number;
  sandboxProvisionWaitTimeoutMs?: number;
  runScriptTimeoutMs?: number;
  runScriptMaxSeconds?: number;
  asyncRunScript?: boolean;
  exit137RetryAttempt?: number;
  // Set ONLY by the deployment_tick_deliveries drain, which catches
  // DeploymentSandboxProvisioningPendingError and persists provisioning_sandbox_id
  // so the next drain resumes the same sandbox. Enables provisionOnDemandSandbox
  // to yield (throw Pending) while the box boots instead of blocking in-process.
  // It must NOT be set by callers that can't persist the sandbox id (e.g. the
  // direct inbox/vfs deliver routes) — they'd lose the id on the 503 and a retry
  // would leak/duplicate the booting sandbox.
  provisioningYieldEnabled?: boolean;
};

type DeploymentSandboxOrchestrator = SandboxOrchestrator<RuntimeHandle>;

export type DeploymentTriggerDeliveryResult = {
  agentId: string;
  workspaceId: string;
  deploymentId: string;
  status: "starting";
};

class HarnessCliCredentialMissingError extends Error {
  constructor(
    readonly provider: string,
    readonly userId: string,
  ) {
    super(`No ${provider} credentials found for user ${userId}`);
    this.name = "HarnessCliCredentialMissingError";
  }
}

type HarnessCliCredentialMountResult = {
  provider: string | null;
  mounted: boolean;
  ambientEnvKeysToUnset: readonly string[];
  /** Env vars the credential needs at runtime. Setup-token anthropic blobs
   *  authenticate via CLAUDE_CODE_OAUTH_TOKEN — mountCliCredentials skips
   *  the .credentials.json file for that shape, and (unlike the workflow
   *  launcher, launcher.ts applyAnthropicOauthTokenEnv) the persona path
   *  never injected the env: boxes ended up with neither file nor env while
   *  reporting a successful mount. */
  env: Readonly<Record<string, string>>;
};

const EMPTY_HARNESS_CLI_CREDENTIAL_MOUNT: HarnessCliCredentialMountResult = {
  provider: null,
  mounted: false,
  ambientEnvKeysToUnset: [],
  env: {},
};

// Deferred runtime-bundle contract: harnessSession.resume=false maps to
// `claude --session-id <uuid>`; resume=true maps to `claude --resume <uuid>`.
const WORKFORCE_HARNESS_RESUME_SESSION_ID_ENV = "WORKFORCE_HARNESS_RESUME_SESSION_ID";
const WORKFORCE_HARNESS_RESUME_SESSION_RESUME_ENV = "WORKFORCE_HARNESS_RESUME_SESSION_RESUME";
// The scheduled tick's stable delivery id, exported into the run env so
// relay-helpers can stamp a per-message idempotency token (`tick:<id>:<ordinal>`)
// on Slack writebacks. A re-run of the same tick reuses this id, so the cloud
// writeback engine dedups the repeated post. Set for clock (scheduled) deliveries
// only — one runner.mjs process per delivery, so the relay-helpers ordinal resets
// per run and aligns across the original and any duplicate run.
const WORKFORCE_TICK_DELIVERY_ID_ENV = "WORKFORCE_TICK_DELIVERY_ID";

const HARNESS_PROVIDER_AMBIENT_ENV_KEYS: Record<string, readonly string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  opencode: ["ANTHROPIC_API_KEY"],
};

const HARNESS_PROVIDER_CREDENTIAL_PATHS: Record<string, readonly string[]> = {
  anthropic: [
    "/home/daytona/.claude/.credentials.json",
    "/home/daytona/.claude.json",
  ],
  openai: ["/home/daytona/.codex/auth.json"],
  google: ["/home/daytona/.config/gemini/credentials.json"],
  opencode: [
    "/home/daytona/.claude/.credentials.json",
    "/home/daytona/.local/share/opencode/auth.json",
  ],
  cursor: ["/home/daytona/.cursor/auth.json"],
  copilot: ["/home/daytona/.config/gh/hosts.yml"],
};

export class DeploymentTriggerDeliveryError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = "DeploymentTriggerDeliveryError";
    if (options && "cause" in options) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export class DeploymentSandboxProvisioningPendingError extends DeploymentTriggerDeliveryError {
  constructor(readonly sandboxId: string, state?: string | null) {
    super(
      `Sandbox ${sandboxId} is still provisioning${state ? ` (${state})` : ""}`,
      "sandbox_provisioning_pending",
      503,
    );
    this.name = "DeploymentSandboxProvisioningPendingError";
  }
}

export class DeploymentSandboxProvisioningTerminalError extends DeploymentTriggerDeliveryError {
  constructor(readonly sandboxId: string, state?: string | null) {
    super(
      `Sandbox ${sandboxId} entered terminal provisioning state${state ? ` (${state})` : ""}`,
      "sandbox_provisioning_terminal",
      502,
    );
    this.name = "DeploymentSandboxProvisioningTerminalError";
  }
}

export type DeploymentTriggerRunState = {
  deploymentId: string;
  sandboxId: string;
  sessionId: string;
  commandId: string;
  startedAt: string;
  sandboxName?: string | null;
  mountConfigured?: boolean;
  /**
   * Byte-exact envelope JSON delivered to runner.mjs (cloud#1841). Carried
   * on the pending-run state so the async poll path can persist it on the
   * run row — rebuilding from payload at record time would NOT reproduce
   * the delivered bytes (buildEnvelope's id/occurredAt fallbacks are
   * non-deterministic).
   */
  envelopeJson?: string | null;
};

export class DeploymentTriggerRunPendingError extends DeploymentTriggerDeliveryError {
  constructor(readonly run: DeploymentTriggerRunState) {
    super(
      `Deployment run ${run.commandId} is still running`,
      "deployment_run_pending",
      202,
    );
    this.name = "DeploymentTriggerRunPendingError";
  }
}

export class DeploymentTriggerRunTimedOutError extends DeploymentTriggerDeliveryError {
  constructor(readonly run: DeploymentTriggerRunState, readonly maxAgeSeconds: number) {
    super(
      `Deployment run ${run.commandId} exceeded ${maxAgeSeconds}s runtime cap`,
      "deployment_run_timeout",
      504,
    );
    this.name = "DeploymentTriggerRunTimedOutError";
  }
}

// Lane-6 crash-recovery: a deployment run whose sandbox has entered a terminal
// state (STOPPED/ERROR/DESTROYED/...) with no exit code can never report a
// non-null exitCode — the box is gone. Surface that as a terminal error (a
// sibling of `DeploymentTriggerRunTimedOutError`, NOT a `RunPendingError`) so the
// delivery drain routes it to the bounded `markPendingDeliveryFailed` path
// instead of re-polling it until the ~30min wall-clock cap.
export class DeploymentTriggerRunSandboxTerminalError extends DeploymentTriggerDeliveryError {
  constructor(readonly run: DeploymentTriggerRunState, readonly state?: string | null) {
    super(
      `Deployment run ${run.commandId} sandbox entered terminal state${state ? ` (${state})` : ""}`,
      "deployment_run_sandbox_terminal",
      502,
    );
    this.name = "DeploymentTriggerRunSandboxTerminalError";
  }
}

export class HarnessExit137Error extends DeploymentTriggerDeliveryError {
  constructor(readonly detail: {
    agentName: string;
    deploymentId: string;
    sandboxId: string;
    sandboxName?: string | null;
    sessionId: string;
    commandId?: string | null;
    outputTail: string;
  }) {
    super(
      [
        `${detail.agentName} harness exited with code 137 (SIGKILL/OOM suspected)`,
        detail.sandboxId ? `sandbox=${detail.sandboxId}` : null,
        detail.sessionId ? `session=${detail.sessionId}` : null,
        detail.commandId ? `command=${detail.commandId}` : null,
        detail.outputTail ? `stdout/stderr tail:\n${detail.outputTail}` : "stdout/stderr tail unavailable",
      ].filter(Boolean).join("; "),
      "harness_exit_137",
      502,
    );
    this.name = "HarnessExit137Error";
  }
}

const MOUNT_LOG_TAIL_LINES = 200;
const MOUNT_LOG_TAIL_BYTES = 64 * 1024;
const RUN_OUTPUT_MAX_CHARS = 256 * 1024;
const MOUNT_LOG_TAIL_START = "__RELAYFILE_MOUNT_LOG_TAIL_START__";
const MOUNT_LOG_TAIL_END = "__RELAYFILE_MOUNT_LOG_TAIL_END__";
const MOUNT_CLEANUP_MESSAGE = "relayfile.mount.cleanup";
// cloud#2029: a run that drafted a writeback command but left it undelivered at
// teardown FAILS loudly with this error instead of silently recording success.
const WRITEBACK_UNDELIVERED_ERROR_MESSAGE =
  "writeback_undelivered: a writeback command draft did not deliver before sandbox teardown (pending writeback at mount cleanup). The draft was synced but not confirmed delivered (cloud#2029).";

function writebackUndeliveredErrorFromCleanup(
  cleanupStatus: AgentDeploymentRunCleanupStatus,
): Error | null {
  return cleanupIndicatesWritebackUndelivered(cleanupStatus)
    ? new Error(WRITEBACK_UNDELIVERED_ERROR_MESSAGE)
    : null;
}
const WORKFLOW_TOKEN_SCOPES = [
  "workflow:invoke:write",
  "workflow:runs:read",
];
const WORKFLOW_TOKEN_TTL_SECONDS = 2 * 60 * 60;
const DEPLOYMENT_RELAYFILE_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_RUN_SCRIPT_MAX_SECONDS = 30 * 60;
const ASYNC_RUN_START_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_SANDBOX_PROVISION_POLL_INTERVAL_MS = 2_000;
const DEFAULT_SANDBOX_PROVISION_WAIT_TIMEOUT_MS = 20_000;
const DEPLOYMENT_WORKSPACE_DIR = "/home/daytona/workspace";
const DEPLOYMENT_RUNTIME_DIR = "/home/daytona/workforce-runtime";
const WORKFORCE_RUNTIME_AWS_SMITHY_INSTALL_SPECS =
  WORKFORCE_RUNTIME_AWS_SMITHY_SPECS.join(" ");
const MAX_STARTED_DEPLOYMENT_SANDBOX_REUSE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PROACTIVE_GIT_WORKSPACE_TOKEN_ENV = "GITHUB_PROACTIVE_WORKSPACE_TOKEN";
const GITHUB_PR_WORKSPACE_TOKEN_ENV = "GITHUB_PR_WORKSPACE_TOKEN";
const PR_SANDBOX_WARM_LEASE_INPUT = "PR_SANDBOX_WARM_LEASE_ENABLED";
const PR_REVIEWER_IMMUTABLE_PATH_DENYLIST_INPUT =
  "PR_REVIEWER_IMMUTABLE_PATH_DENYLIST";
const PR_REVIEWER_EXPECTED_RED_TEST_PATHS_INPUT =
  "PR_REVIEWER_EXPECTED_RED_TEST_PATHS";
const HARNESS_EXIT_137_RETRY_EXIT_CODE = 137;
const PR_DIFF_MAX_BYTES = 180_000;
const SANDBOX_LEASE_BUFFER_SECONDS = 10 * 60;
const STRUCTURED_RUNNER_LOG_WRITE_TTL_SECONDS = 10 * 60;
const DEFAULT_PR_REVIEWER_IMMUTABLE_PATH_DENYLIST = [
  "SNAPSHOT.md",
  ".github/workflows/*",
  "*snapshot*.test.*",
  "*snapshot*.spec.*",
  "infra/*snapshot*",
  "infra/snapshot*",
] as const;
const PR_REVIEWER_EXPECTED_RED_FAILURE_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "startup_failure",
  "timed_out",
]);

export function buildDeploymentRunSessionId(deploymentId: string): string {
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `tick-${deploymentId}-${suffix}`;
}

// Daytona rejects creating a sandbox with a name that already exists in the
// workspace (`DaytonaConflictError: Sandbox with name <x> already exists`).
// The cold-start runtime provisions a *fresh* sandbox on every trigger fire,
// so the per-fire sandbox name must be unique. We suffix the persona slug
// with a short slice of the per-fire deploymentId (UUID, so an 8-char slice
// gives effectively-unique names across concurrent and sequential fires
// while keeping the total name well under Daytona's ~100 char limit).
const SANDBOX_NAME_DEPLOYMENT_SUFFIX_LENGTH = 8;
const SANDBOX_NAME_MAX_LENGTH = 63;

export function buildPerFireSandboxName(input: {
  personaSlug: string;
  deploymentId: string;
}): string {
  const suffix = input.deploymentId
    .replace(/-/g, "")
    .slice(0, SANDBOX_NAME_DEPLOYMENT_SUFFIX_LENGTH);
  const reservedForSuffix = suffix.length + 1; // "-" + suffix
  const baseMax = Math.max(1, SANDBOX_NAME_MAX_LENGTH - reservedForSuffix);
  const base = input.personaSlug.slice(0, baseMax);
  return `${base}-${suffix}`;
}

function isDaytonaSandboxNameConflict(error: unknown): boolean {
  if (error && typeof error === "object") {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (statusCode === 409) {
      return true;
    }
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /sandbox with name .* already exists/i.test(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function conversationSandboxWarmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.CONVERSATION_SANDBOX_WARM_ENABLED?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function slackConversationMarker(value: unknown): { channel: string; threadTs: string } | null {
  if (!isRecord(value)) return null;
  const channel = stringValue(value.channel);
  const threadTs = stringValue(value.threadTs) ?? stringValue(value.thread_ts) ?? stringValue(value.ackTs);
  if (!channel || !threadTs) return null;
  const normalizedChannel = normalizeSlackChannelId(channel);
  return normalizedChannel ? { channel: normalizedChannel, threadTs } : null;
}

export function slackConversationKeyFromPayload(payload: unknown): string | null {
  const record = isRecord(payload) ? payload : null;
  const direct = slackConversationMarker(record?.slackConversation);
  if (direct) return buildSlackConversationKey(direct);

  const resource = isRecord(record?.resource) ? record.resource : null;
  const fromResource = slackConversationMarker(resource?.slackConversation);
  if (fromResource) return buildSlackConversationKey(fromResource);

  const event = isRecord(record?.event) ? record.event : isRecord(resource?.event) ? resource.event : record;
  const channel = stringValue(event?.channel);
  const threadTs = stringValue(event?.thread_ts) ?? stringValue(event?.threadTs);
  if (!channel || !threadTs) return null;
  const normalizedChannel = normalizeSlackChannelId(channel);
  return normalizedChannel ? buildSlackConversationKey({ channel: normalizedChannel, threadTs }) : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numericValue(value: unknown): number | null {
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return numberValue(value);
}

function booleanInputValue(
  inputValues: Record<string, string>,
  key: string,
): boolean {
  const normalized = inputValues[key]?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export type PrReviewerPushPolicy = {
  immutablePathDenylist: readonly string[];
  expectedRedTestPaths: readonly string[];
  expectedRedReason: string | null;
};

function splitPathList(value: unknown): string[] {
  const raw = stringValue(value);
  if (!raw) return [];
  return raw
    .split(/[\n,]/u)
    .map((entry) => normalizeRepoRelativePath(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function normalizeRepoRelativePath(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) return null;
  const withoutWorkspace = raw
    .trim()
    .replace(/^\/home\/daytona\/workspace\//u, "")
    .replace(/^\.?\//u, "")
    .trim();
  if (
    !withoutWorkspace ||
    withoutWorkspace === "." ||
    withoutWorkspace.includes("\0") ||
    withoutWorkspace.startsWith("../")
  ) {
    return null;
  }
  return withoutWorkspace;
}

function collectExpectedRedTestPaths(value: unknown, paths = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    const testPathPattern = /(?:^|[\s"'(:])((?:\.\/)?[A-Za-z0-9_.@/-]*(?:test|spec)\.[A-Za-z0-9_.-]+)(?=$|[\s"'),:])/gu;
    for (const match of value.matchAll(testPathPattern)) {
      const normalized = normalizeRepoRelativePath(match[1]);
      if (normalized) {
        paths.add(normalized);
      }
    }
    return paths;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectExpectedRedTestPaths(entry, paths);
    }
    return paths;
  }
  if (!isRecord(value)) {
    return paths;
  }
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey === "path" ||
      normalizedKey === "file" ||
      normalizedKey === "filename" ||
      normalizedKey === "file_name" ||
      normalizedKey === "test_file" ||
      normalizedKey === "testfile" ||
      normalizedKey === "test_path" ||
      normalizedKey === "testpath"
    ) {
      const normalized = normalizeRepoRelativePath(entry);
      if (normalized && /(?:^|[./_-])(?:test|spec)\.[A-Za-z0-9_.-]+$/u.test(normalized)) {
        paths.add(normalized);
      }
    }
    collectExpectedRedTestPaths(entry, paths);
  }
  return paths;
}

function expectedRedReasonFromEnvelope(envelope: Record<string, unknown>): string | null {
  const eventType = stringValue(envelope.eventType) ?? stringValue(envelope.type) ?? "";
  const resource = isRecord(envelope.resource) ? envelope.resource : envelope;
  const nestedCheckRun = isRecord(resource.check_run) ? resource.check_run : null;
  const nestedCheckSuite = isRecord(resource.check_suite) ? resource.check_suite : null;
  const nestedWorkflowRun = isRecord(resource.workflow_run) ? resource.workflow_run : null;
  const check = nestedCheckRun ?? nestedCheckSuite ?? nestedWorkflowRun ?? resource;
  const conclusion = (stringValue(check.conclusion) ?? stringValue(resource.conclusion) ?? "")
    .toLowerCase();
  if (
    !PR_REVIEWER_EXPECTED_RED_FAILURE_CONCLUSIONS.has(conclusion) &&
    !/check_(?:run|suite)\.completed|workflow_run\.(?:completed|requested)/u.test(eventType)
  ) {
    return null;
  }
  if (conclusion && !PR_REVIEWER_EXPECTED_RED_FAILURE_CONCLUSIONS.has(conclusion)) {
    return null;
  }
  const name =
    stringValue(check.name) ??
    stringValue(check.workflow_name) ??
    stringValue(resource.name) ??
    eventType;
  return [name, conclusion].filter(Boolean).join(" ");
}

function expectedRedReasonFromCheckRuns(checkRuns: readonly Record<string, unknown>[]): string | null {
  const names = checkRuns
    .filter((checkRun) => {
      const conclusion = (stringValue(checkRun.conclusion) ?? "").toLowerCase();
      if (!PR_REVIEWER_EXPECTED_RED_FAILURE_CONCLUSIONS.has(conclusion)) return false;
      const name = stringValue(checkRun.name) ?? "";
      return /test|spec|vitest|jest|unit|integration|e2e|playwright/i.test(name);
    })
    .map((checkRun) => stringValue(checkRun.name) ?? stringValue(checkRun.conclusion) ?? "failed check")
    .filter((name): name is string => Boolean(name));
  if (names.length === 0) return null;
  return uniqueStrings(names).join(", ");
}

function prReviewerPushPolicy(input: {
  envelope: Record<string, unknown>;
  inputValues?: Record<string, string>;
  env?: Record<string, string | undefined>;
  expectedRedReason?: string | null;
  expectedRedTestPaths?: readonly string[];
}): PrReviewerPushPolicy {
  const inputValues = input.inputValues ?? {};
  const immutablePathDenylist = uniqueStrings([
    ...DEFAULT_PR_REVIEWER_IMMUTABLE_PATH_DENYLIST,
    ...splitPathList(inputValues[PR_REVIEWER_IMMUTABLE_PATH_DENYLIST_INPUT]),
    ...splitPathList(input.env?.PR_REVIEWER_IMMUTABLE_PATH_DENYLIST),
  ]);
  const expectedRedReason = input.expectedRedReason ?? expectedRedReasonFromEnvelope(input.envelope);
  const explicitExpectedRedPaths = [
    ...splitPathList(inputValues[PR_REVIEWER_EXPECTED_RED_TEST_PATHS_INPUT]),
    ...splitPathList(input.env?.PR_REVIEWER_EXPECTED_RED_TEST_PATHS),
  ];
  const eventExpectedRedPaths = expectedRedReason
    ? [...collectExpectedRedTestPaths(input.envelope)]
    : [];
  return {
    immutablePathDenylist,
    expectedRedReason,
    expectedRedTestPaths: uniqueStrings([
      ...explicitExpectedRedPaths,
      ...eventExpectedRedPaths,
      ...(input.expectedRedTestPaths ?? []),
    ]),
  };
}

async function resolvePrReviewerPushPolicy(input: {
  envelope: Record<string, unknown>;
  inputValues: Record<string, string>;
  pullRequestWorkspace: Omit<PullRequestWorkspaceConfig, "tokenEnvKey"> | null;
  userId: string;
  workspaceId: string;
}): Promise<PrReviewerPushPolicy> {
  let expectedRedReason = expectedRedReasonFromEnvelope(input.envelope);
  if (!expectedRedReason && input.pullRequestWorkspace) {
    try {
      const checkRuns = await readGithubProxyCommitCheckRuns({
        userId: input.userId,
        workspaceId: input.workspaceId,
        owner: input.pullRequestWorkspace.owner,
        repo: input.pullRequestWorkspace.repo,
        sha: input.pullRequestWorkspace.headSha,
      });
      expectedRedReason = expectedRedReasonFromCheckRuns(checkRuns);
      const checkRunExpectedRedTestPaths = expectedRedReason
        ? [...collectExpectedRedTestPaths(checkRuns)]
        : [];
      return prReviewerPushPolicy({
        envelope: input.envelope,
        inputValues: input.inputValues,
        env: process.env,
        expectedRedReason,
        expectedRedTestPaths: checkRunExpectedRedTestPaths,
      });
    } catch (error) {
      console.warn("[pr-reviewer] failed to inspect PR head check runs for expected-red push gate", {
        repo: `${input.pullRequestWorkspace.owner}/${input.pullRequestWorkspace.repo}`,
        pullRequestNumber: input.pullRequestWorkspace.number,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return prReviewerPushPolicy({
    envelope: input.envelope,
    inputValues: input.inputValues,
    env: process.env,
    expectedRedReason,
  });
}

function personaSkipsSandbox(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value.sandbox === false) {
    return true;
  }
  const persona = deploymentPersonaSpec(value);
  return persona?.sandbox === false;
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const candidate = result as { rows?: T[] };
  return Array.isArray(candidate?.rows) ? candidate.rows : [];
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isSafeGitBranchRefName(value: string): boolean {
  if (!value || value.startsWith("/") || value.endsWith("/") || value.includes("//")) return false;
  if (value.includes("..") || value.includes("@{") || value.endsWith(".lock")) return false;
  if (value.split("/").some((segment) => !segment || segment.startsWith(".") || segment.endsWith("."))) return false;
  return /^[A-Za-z0-9._/-]+$/.test(value);
}

function resolveRunScriptMaxSeconds(input: {
  persona: Record<string, unknown> | null;
  options?: DeploymentTriggerDeliveryOptions;
}): number {
  const configured = input.options?.runScriptMaxSeconds;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.ceil(configured);
  }
  const harnessSettings = isRecord(input.persona?.harnessSettings)
    ? input.persona.harnessSettings
    : {};
  const personaTimeout = numberValue(harnessSettings.timeoutSeconds);
  if (personaTimeout && personaTimeout > 0) {
    return Math.ceil(personaTimeout);
  }
  return DEFAULT_RUN_SCRIPT_MAX_SECONDS;
}

function withShellTimeout(script: string, maxSeconds: number): string {
  const seconds = Math.max(1, Math.ceil(maxSeconds));
  return `timeout ${seconds}s bash -lc ${shellSingleQuote(script)}`;
}

function createDeploymentSandboxOrchestrator(
  runtime: DeploymentSandboxRuntime,
): DeploymentSandboxOrchestrator {
  return new SandboxOrchestrator({
    provision: (options) => runtime.launch({
      name: options?.name,
      env: options?.env,
      labels: options?.labels,
      createTimeoutSeconds: options?.createTimeoutSeconds,
    }),
    uploadBundle: (handle, files) => runtime.uploadBundle(handle, { files: [...files] }),
    runScript: (handle, options) => runtime.runScript(handle, {
      command: options.command,
      sessionId: options.sessionId,
      timeoutMs: options.timeoutMs,
      env: options.env,
    }),
    teardown: (handle) => runtime.destroy(handle),
  });
}

export type RelayfileMountConfig = {
  baseUrl: string;
  workspaceId: string;
  /** Broad token exported to the runner for direct Relayfile API reads. */
  envToken?: string;
  /**
   * Path-scoped token used by the relayfile-mount daemon. The daemon mirrors
   * only `mountPaths`, so this token may be broader than the mirror scope.
   */
  token: string;
  /**
   * Broad paths granted to the relayfile path token. Relayauth only accepts
   * provider-root wildcards for some generated integration paths.
   */
  tokenPaths: readonly string[];
  /**
   * Paths granted to the relayfile-mount daemon token. The current mitigation
   * uses provider-root scopes while keeping `mountPaths` narrow.
   */
  daemonTokenPaths?: readonly string[];
  /**
   * Narrow paths that the sandbox relayfile-mount daemon should mirror.
   * Keeping this narrower than tokenPaths avoids whole-provider exports for
   * large provider trees such as GitHub repo content caches.
   */
  mountPaths: readonly string[];
  syncPaths?: readonly string[];
};

export type PullRequestWorkspaceConfig = {
  owner: string;
  repo: string;
  number: number;
  baseSha: string;
  headSha: string;
  headRef: string;
  headRepoFullName: string;
  canPush: boolean;
  remoteUrl: string;
  tokenEnvKey?: string | null;
  mode?: "review" | "conflictResolve";
};

export type ProactiveGitWorkspaceConfig = {
  owner: string;
  repo: string;
  remoteUrl: string;
  targetDir: string;
  ref?: string;
  tokenEnvKey?: string | null;
  username?: string | null;
};

/**
 * Mint a path-scoped relayfile token + return the mount config used by the
 * invokeScript to start `relayfile-mount` inside the sandbox.
 *
 * Returns `null` when:
 *   - the persona declares no relayfile-backed integrations (no paths to
 *     scope to → no mount needed), OR
 *   - any step of the mint chain fails (graceful degrade: handler still
 *     runs, writebacks queue to disk but don't flush; surfaced as a warn
 *     log so the operator can see why no comment got posted; reused
 *     sandboxes clear Relayfile env for that fire so stale launch-time
 *     tokens are not reused).
 *
 * /v1/tokens/path requires a workspace-scoped credential, not the
 * org-level RELAYAUTH_API_KEY — we exchange the org key for a `relay_ws_*`
 * workspace token first (per cloud#942 + cloud#955), then mint the
 * path-scoped `relay_pa_*` token from that.
 */
/**
 * Collapse persona-derived relayfile paths (e.g.
 * `/github/repos/**\/**\/issues/**`) into the single-wildcard form
 * relayauth's `/v1/tokens/path` accepts.
 *
 * Relayauth's `normalizePathTokenPath`
 * (`relayauth/packages/server/src/routes/tokens.ts:1155-1183`) only allows
 * paths whose ONLY `*` is the last character following a `/` — i.e.
 * `/github/*`. Anything with multiple wildcard segments (which is what
 * `relayfilePathsForIntegrations` produces — e.g. the github
 * `/repos/{owner}/{repo}/issues/**` resource shape) is rejected with
 * `{ error: "paths must contain valid relayfile paths", code: "invalid_paths" }`.
 *
 * Take the first non-wildcard segment of each derived path as the provider
 * root, dedupe, and emit `/<provider>/**` per scope — that normalizes
 * server-side to `/<provider>/*`, which IS valid. Slightly broader scope
 * than the original derived path, but the persona's writeback access is
 * still capped at the providers it declared (no cross-provider escape),
 * and prefix-matching the relayfile fs:read/write scopes against
 * `/github/...` still resolves correctly under the granted scope.
 *
 * Mirrors the simpler shape `box-manager.ts` uses for cloud-agent box
 * warms (`DEFAULT_MOUNT_PATH = "/workspace"` — a single non-wildcard
 * path), which is why the box flow has never hit this validation while
 * the proactive runtime has.
 */
export function relayfilePathRootsForTokenScope(
  derivedPaths: readonly string[],
): string[] {
  const roots = new Set<string>();
  for (const path of derivedPaths) {
    const trimmed = path.trim();
    if (!trimmed.startsWith("/")) {
      continue;
    }
    // First non-empty segment after the leading `/`. We don't trust the
    // input to be wildcard-free — `/github/repos/**/...` → take `github`.
    const firstSegment = trimmed.slice(1).split("/")[0] ?? "";
    if (!firstSegment || firstSegment.includes("*")) {
      continue;
    }
    roots.add(`/${firstSegment}/**`);
  }
  return [...roots].sort();
}

export function relayfileMountDaemonTokenConfig(input: {
  envToken: string;
  tokenPaths: readonly string[];
  mintDaemonToken?: boolean;
}): { token: string; daemonTokenPaths: string[] } {
  if (input.mintDaemonToken === false) {
    return { token: "", daemonTokenPaths: [] };
  }
  return {
    token: input.envToken,
    daemonTokenPaths: [...new Set(input.tokenPaths)].sort(),
  };
}

export function relayfileRuntimeWorkspaceTokenScopes(
  tokenPaths: readonly string[],
): string[] {
  const scopes = new Set<string>(["relayfile:ops:read:*"]);
  for (const path of tokenPaths) {
    const scopePath = relayAuthWorkspaceScopePath(path);
    scopes.add(`relayfile:fs:read:${scopePath}`);
    scopes.add(`relayfile:fs:write:${scopePath}`);
  }
  return [...scopes].sort();
}

function relayAuthWorkspaceScopePath(path: string): string {
  const trimmed = path.trim();
  return trimmed.endsWith("/**") ? `${trimmed.slice(0, -3)}/*` : trimmed;
}

async function mintRelayfileMountConfig(input: {
  workspaceId: string;
  agentId: string;
  relayfilePaths: readonly string[];
  syncPaths?: readonly string[];
  eventSyncPaths?: readonly string[];
  mintDaemonToken?: boolean;
}): Promise<RelayfileMountConfig | null> {
  if (input.relayfilePaths.length === 0) {
    return null;
  }
  const pathRoots = relayfilePathRootsForTokenScope(input.relayfilePaths);
  if (pathRoots.length === 0) {
    return null;
  }
  try {
    const relayfile = resolveRelayfileConfig();
    const envTokenPair = await mintWorkspaceScopedRelayfileTokenPair({
      workspaceId: input.workspaceId,
      relayAuthUrl: relayfile.relayAuthUrl,
      relayAuthApiKey: relayfile.relayAuthApiKey,
      scopes: relayfileRuntimeWorkspaceTokenScopes(pathRoots),
      ttlSeconds: DEPLOYMENT_RELAYFILE_TOKEN_TTL_SECONDS,
      agentName: input.agentId,
      agentId: input.agentId,
    });
    const envToken = envTokenPair.accessToken;
    const mountPaths = [...new Set(input.relayfilePaths)].sort();
    const syncPaths = [...new Set(input.syncPaths ?? [])].sort();
    const daemonEnvToken = input.mintDaemonToken === false
      ? ""
      : await mintPathScopedRelayfileTokenWithWorkspaceCache({
          workspaceId: input.workspaceId,
          relayAuthUrl: relayfile.relayAuthUrl,
          paths: pathRoots,
          agentName: input.agentId,
          agentId: input.agentId,
        });
    const { token: daemonToken, daemonTokenPaths } = relayfileMountDaemonTokenConfig({
      envToken: daemonEnvToken,
      tokenPaths: pathRoots,
      mintDaemonToken: input.mintDaemonToken,
    });
    return {
      baseUrl: normalizeCredentialUrl(relayfile.relayfileUrl),
      workspaceId: input.workspaceId,
      envToken,
      token: daemonToken,
      tokenPaths: pathRoots,
      daemonTokenPaths,
      mountPaths: daemonToken ? mountPaths : [],
      syncPaths: daemonToken ? syncPaths : [],
    };
  } catch (error) {
    console.error(
      "[persona-bundle-deploy] relayfile mount token mint failed; refusing to continue",
      {
        agentId: input.agentId,
        workspaceId: input.workspaceId,
        pathRoots,
        error: errorMessage(error),
      },
    );
    throw new DeploymentTriggerDeliveryError(
      "failed to mint relayfile mount token for deployment trigger",
      "relayfile_mount_token_unavailable",
      502,
      { cause: error },
    );
  }
}

function resolveWorkforceCloudBaseUrl(): string | null {
  const configured = process.env.CLOUD_PUBLIC_URL?.trim()
    || process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!configured) {
    return null;
  }
  const url = new URL(configured);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("CLOUD_PUBLIC_URL must use http or https");
  }
  return url.toString().replace(/\/+$/u, "");
}

function normalizeCredentialUrl(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

function resolveCredentialEncryptionKey(): string {
  try {
    const resourceValue = Resource.CredentialEncryptionKey.value?.trim();
    if (resourceValue) {
      return resourceValue;
    }
  } catch {
    // Local dev/test fallback below.
  }
  const envValue = process.env.CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (envValue) {
    return envValue;
  }
  throw new Error("CredentialEncryptionKey is not configured");
}

function resolveCredentialStoreBucket(): string {
  try {
    const bucket = Resource.WorkflowStorage.bucketName?.trim();
    if (bucket) {
      return bucket;
    }
  } catch {
    // Local dev/test fallback below.
  }
  const envValue = (process.env.WORKFLOW_STORAGE_BUCKET ?? process.env.S3_BUCKET)?.trim();
  if (envValue) {
    return envValue;
  }
  throw new Error("WorkflowStorage bucket is not configured");
}

async function getHarnessCliCredentials(input: {
  userId: string;
  provider: string;
}): Promise<string> {
  const s3 = await createCredentialStoreS3Client({ userId: input.userId });
  const store = new CredentialStore({
    bucket: resolveCredentialStoreBucket(),
    prefix: "credentials",
    encryptionKey: resolveCredentialEncryptionKey(),
    client: s3,
  });
  const credentials = await store.retrieve(input.userId, input.provider);
  if (!credentials) {
    throw new HarnessCliCredentialMissingError(input.provider, input.userId);
  }
  // Per-run expiry check + refresh + persist. Without this, freshness rode
  // entirely on the 6-hourly credential sweep cron, so an expired (or
  // refresh-token-dead) credential was mounted verbatim and every harness
  // run 401'd with a cryptic "Bearer token is invalid".
  return refreshHarnessCliCredentialIfStale({
    store,
    userId: input.userId,
    provider: input.provider,
    credentialJson: credentials,
  });
}

async function mintWorkflowWorkspaceToken(input: {
  workspaceId: string;
  agentId: string;
  required: boolean;
}): Promise<string | null> {
  const { relayAuthUrl, relayAuthApiKey } = resolveRelayAuthConfig();
  if (!relayAuthApiKey) {
    if (input.required) {
      console.error(
        "[persona-bundle-deploy] workflow token mint skipped because RelayAuth API key is missing; refusing to continue",
        {
          agentId: input.agentId,
          workspaceId: input.workspaceId,
        },
      );
      throw new DeploymentTriggerDeliveryError(
        "workflow workspace token is required but RelayAuth API key is not configured",
        "workflow_workspace_token_unavailable",
        503,
      );
    }
    return null;
  }
  try {
    return await mintRelayfileToken({
      workspaceId: input.workspaceId,
      relayAuthUrl,
      relayAuthApiKey,
      agentName: input.agentId,
      scopes: WORKFLOW_TOKEN_SCOPES,
      // Covers the v1 long-running codex workflow while keeping the token
      // short-lived. The sandbox cannot refresh this token mid-poll.
      ttlSeconds: WORKFLOW_TOKEN_TTL_SECONDS,
    });
  } catch (error) {
    console.error(
      "[persona-bundle-deploy] workflow token mint failed; refusing to continue",
      {
        agentId: input.agentId,
        workspaceId: input.workspaceId,
        error: errorMessage(error),
      },
    );
    throw new DeploymentTriggerDeliveryError(
      "failed to mint workflow workspace token for deployment trigger",
      "workflow_workspace_token_unavailable",
      502,
      { cause: error },
    );
  }
}

async function workflowEnvVars(input: {
  workspaceId: string;
  agentId: string;
}): Promise<Record<string, string>> {
  const baseUrl = resolveWorkforceCloudBaseUrl();
  const token = await mintWorkflowWorkspaceToken({
    ...input,
    required: Boolean(baseUrl),
  });
  return {
    ...(token ? { WORKFORCE_AGENT_TOKEN: token } : {}),
    ...(token ? { WORKFORCE_WORKSPACE_TOKEN: token } : {}),
    ...(token ? { CLOUD_API_ACCESS_TOKEN: token } : {}),
    ...(baseUrl ? { WORKFORCE_CLOUD_BASE_URL: baseUrl } : {}),
    ...(baseUrl ? { WORKFORCE_CLOUD_URL: baseUrl } : {}),
    ...(baseUrl ? { WORKFORCE_DEPLOY_CLOUD_URL: baseUrl } : {}),
    ...(baseUrl ? { CLOUD_API_URL: baseUrl } : {}),
  };
}

async function resolveRelayWorkspaceIdForDelivery(input: {
  workspaceId: string;
  agentId: string;
  phase: "provision" | "deliver";
}): Promise<string> {
  try {
    return await resolveRelayWorkspaceIdForRuntime(input.workspaceId);
  } catch (error) {
    console.error(
      "[persona-bundle-deploy] relay workspace resolution failed; refusing to continue",
      {
        agentId: input.agentId,
        workspaceId: input.workspaceId,
        phase: input.phase,
        error: errorMessage(error),
      },
    );
    throw new DeploymentTriggerDeliveryError(
      "failed to resolve relay workspace id for deployment trigger",
      "relay_workspace_resolution_failed",
      502,
    );
  }
}

async function resolveSubscriptionFallbackEnvBestEffort(input: {
  workspaceId: string;
  deployedByUserId: string;
  personaModel: string | null;
  personaHarness: string | null;
}): Promise<Record<string, string>> {
  try {
    const fallback = await resolveSubscriptionFallbackEnv({
      workspaceId: input.workspaceId,
      userId: input.deployedByUserId,
      personaModel: input.personaModel,
      personaHarness: input.personaHarness,
    });
    const credential = fallback.credentials[0];
    if (credential) {
      console.log(
        "[persona-bundle-deploy] useSubscription fallback selected credential",
        {
          workspaceId: input.workspaceId,
          provider: credential.provider,
          authType: credential.authType,
          envVar: credential.envVar,
          providerCredentialId: credential.providerCredentialId,
        },
      );
    } else {
      console.warn(
        "[persona-bundle-deploy] useSubscription fallback found no resolvable active credential",
        { workspaceId: input.workspaceId, userId: input.deployedByUserId },
      );
    }
    return fallback.env;
  } catch (error) {
    console.warn(
      "[persona-bundle-deploy] useSubscription fallback failed; continuing without ctx.llm env",
      {
        workspaceId: input.workspaceId,
        userId: input.deployedByUserId,
        error: errorMessage(error),
      },
    );
    return {};
  }
}

async function resolveSelectedProviderEnv(input: {
  workspaceId: string;
  deployedByUserId: string;
  credentialSelections: Record<string, string>;
  persona: Record<string, unknown> | null;
}): Promise<Record<string, string>> {
  // Deployment rows persist either a flat persona or the wrapped
  // `{persona, agent}` spec snapshot — read through the unwrap like
  // personaSkipsSandbox does, or wrapped rows silently skip the
  // useSubscription gates below (the #1649 capability-reader class).
  const persona = deploymentPersonaSpec(input.persona) ?? input.persona;
  const usesSubscription = persona?.useSubscription === true;
  const personaModel = stringValue(persona?.model) ?? null;
  const personaHarness = stringValue(persona?.harness) ?? null;

  if (Object.keys(input.credentialSelections).length === 0) {
    // `useSubscription: true` is the user's standing consent to run this
    // persona's inference on their connected subscription, so an empty
    // selection set (pre-#197 CLI deploys never stamped the oauth legs)
    // falls back to the deploying user's ACTIVE credential instead of
    // booting ctx.llm as a stub. Best-effort by design: a fallback failure
    // must degrade to today's stub, never convert a working delivery into
    // a failed one.
    if (!usesSubscription) {
      return {};
    }
    return resolveSubscriptionFallbackEnvBestEffort({
      workspaceId: input.workspaceId,
      deployedByUserId: input.deployedByUserId,
      personaModel,
      personaHarness,
    });
  }

  try {
    const resolved = await resolveProviderCredentialRuntimeEnv({
      workspaceId: input.workspaceId,
      userId: input.deployedByUserId,
      credentialSelections: input.credentialSelections,
    });
    return resolved.env;
  } catch (error) {
    // Stale/broken explicit selections (e.g. the selected row was deleted
    // via the dashboard Disconnect while older deployments still reference
    // its id) used to hard-fail the delivery — a worse failure mode than
    // the ctx.llm stub for personas the user consented to run on their
    // subscription. For those, degrade to the same active-credential
    // fallback the empty-selections path uses (#1903). Non-useSubscription
    // personas keep the fatal behavior: a visible failure, no implicit
    // billing.
    if (!usesSubscription) {
      throw error;
    }
    console.warn(
      "[persona-bundle-deploy] credential selection resolution failed; using useSubscription fallback",
      {
        workspaceId: input.workspaceId,
        userId: input.deployedByUserId,
        credentialSelections: input.credentialSelections,
        error: errorMessage(error),
      },
    );
    return resolveSubscriptionFallbackEnvBestEffort({
      workspaceId: input.workspaceId,
      deployedByUserId: input.deployedByUserId,
      personaModel,
      personaHarness,
    });
  }
}

function personaDeclaresIntegration(
  personaInput: Record<string, unknown> | null,
  provider: string,
): boolean {
  const persona = deploymentPersonaSpec(personaInput) ?? personaInput;
  if (!isRecord(persona?.integrations)) {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(persona.integrations, provider);
}

async function resolvePersonaIntegrationEnv(input: {
  deployedByUserId: string;
  persona: Record<string, unknown> | null;
  inputValues?: Record<string, string> | null;
}): Promise<Record<string, string>> {
  if (!personaDeclaresIntegration(input.persona, "daytona")) {
    return {};
  }
  const rawOrgId = input.inputValues?.DAYTONA_ORG_ID;
  const inputOrgId = typeof rawOrgId === "string" ? rawOrgId.trim() : undefined;
  let env: Record<string, string> = {};
  try {
    env = await resolveDaytonaCredentialRuntimeEnv({ userId: input.deployedByUserId });
  } catch (error) {
    console.warn("[proactive-runtime] Daytona credential env unavailable; continuing without access token", {
      userId: input.deployedByUserId,
      hasInputOrgId: Boolean(inputOrgId),
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    ...env,
    ...(inputOrgId ? { DAYTONA_ORG_ID: inputOrgId } : {}),
  };
}

async function mountHarnessCliCredential(input: {
  orchestrator: DeploymentSandboxOrchestrator;
  handle: RuntimeHandle;
  persona: Record<string, unknown> | null;
  deployedByUserId: string;
}): Promise<HarnessCliCredentialMountResult> {
  const harness = stringValue(input.persona?.harness);
  if (!harness) {
    return EMPTY_HARNESS_CLI_CREDENTIAL_MOUNT;
  }
  const provider = CLI_TO_PROVIDER[harness];
  if (!provider) {
    return EMPTY_HARNESS_CLI_CREDENTIAL_MOUNT;
  }

  let credentialJson: string;
  try {
    credentialJson = await getHarnessCliCredentials({
      userId: input.deployedByUserId,
      provider,
    });
  } catch (error) {
    if (error instanceof HarnessCliCredentialMissingError) {
      await removeHarnessCliCredentialFiles({
        orchestrator: input.orchestrator,
        handle: input.handle,
        provider,
      });
      console.warn(
        "[persona-bundle-deploy] harness CLI credential not connected; falling back to ambient sandbox auth",
        {
          harness,
          provider,
          userId: input.deployedByUserId,
        },
      );
      return {
        provider,
        mounted: false,
        ambientEnvKeysToUnset: [],
        env: {},
      };
    }
    if (error instanceof HarnessCredentialExpiredError) {
      // Surface the reconnect instruction on the run's FAILED card instead
      // of letting the harness die later with a bare "Bearer token is
      // invalid" (the pre-refresh failure mode).
      throw new DeploymentTriggerDeliveryError(
        error.userMessage,
        "harness_credential_expired",
        503,
      );
    }
    throw error;
  }
  const sandboxAdapter = {
    process: {
      executeCommand: async (command: string) => {
        const result = await input.orchestrator.runScript(input.handle, {
          command,
          timeoutMs: 30_000,
        });
        if (result.exitCode !== 0) {
          throw new Error(result.output || `Failed to prepare ${harness} credentials`);
        }
        return result.output;
      },
    },
    fs: {
      uploadFile: async (source: Buffer, destination: string) => {
        await input.orchestrator.uploadBundle(input.handle, [{ source, destination }]);
      },
    },
  };

  await mountCliCredentials(
    sandboxAdapter as unknown as Parameters<typeof mountCliCredentials>[0],
    "/home/daytona",
    credentialJson,
    provider,
  );

  // ctx.llm runs off the SAME in-sandbox credential the harness uses: the
  // mounted auth blob (which we already retrieved + refreshed above). This is
  // the owner's design intent — "the sandbox already has the auth file, so
  // ctx.llm should just work" — and it covers BOTH anthropic subscriptions/
  // setup-tokens (→ CLAUDE_CODE_OAUTH_TOKEN) and openai/codex OAuth blobs
  // (→ CODEX_OAUTH_CREDENTIAL, the structured backend blob — never an
  // OPENAI_API_KEY, since a ChatGPT OAuth bearer is not a platform key).
  // It is a fallback: an explicit credentialSelection (providerEnv) is spread
  // AFTER this in the run env, so a user's explicit ctx.llm pick still wins.
  // The setup-token shape additionally requires the env for the HARNESS too —
  // mountCliCredentials deliberately skips the .credentials.json upload for it.
  const ctxLlmEnv = deriveCtxLlmEnvFromHarnessCredential({
    provider,
    credentialJson,
  });

  return {
    provider,
    mounted: true,
    ambientEnvKeysToUnset: HARNESS_PROVIDER_AMBIENT_ENV_KEYS[provider] ?? [],
    env: ctxLlmEnv,
  };
}

async function removeHarnessCliCredentialFiles(input: {
  orchestrator: DeploymentSandboxOrchestrator;
  handle: RuntimeHandle;
  provider: string;
}): Promise<void> {
  const paths = HARNESS_PROVIDER_CREDENTIAL_PATHS[input.provider] ?? [];
  if (paths.length === 0) {
    return;
  }
  const command = `rm -f ${paths.map(shellSingleQuote).join(" ")}`;
  const result = await input.orchestrator.runScript(input.handle, {
    command,
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.output || `Failed to clear ${input.provider} credentials`);
  }
}

/**
 * Bash snippet that starts the `relayfile-mount` daemon in the background.
 * Returns an empty string when `mount` is null (no relayfile-backed
 * integrations, or path-scoped token mint failed earlier). Builds the shell via
 * `SandboxOrchestrator` helpers so the proactive runtime and the workflow
 * executor (`packages/core/src/executor/executor.ts`) emit byte-identical bash
 * for the same opts.
 *
 * The PID lands in `$RELAYFILE_MOUNT_PID` so the post-runner flush can
 * `kill` it after running the one-time sync.
 */
/**
 * Derive the Slack writeback command roots from the mounted scopes, per the
 * relayfile/Pear authority (`slack-writeback-command-roots` /
 * `writebackCommandMountPathsForIntegration`). Only `slack` collections
 * `channels|dms|users` qualify; `/discovery/*`, bare collections, and broad
 * historical roots are excluded. Used to scope the cloud#2029 command-draft
 * probe so a dropped writeback is loud without false-alarming read-only runs.
 *
 *   /slack/{coll}/{id}                       => /slack/{coll}/{id}/messages
 *   /slack/{coll}/{id}/messages              => stays
 *   /slack/{coll}/{id}/threads/{tid}         => /slack/{coll}/{id}/threads/{tid}/replies
 *   /slack/{coll}/{id}/threads/{tid}/replies => stays
 */
export function slackWritebackCommandRoots(mountPaths: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const raw of mountPaths) {
    const path = stripTrailingGlob(raw);
    const match = path.match(/^\/slack\/(channels|dms|users)\/([^/]+)(?:\/(.*))?$/u);
    if (!match) {
      continue;
    }
    const collection = match[1];
    const id = match[2];
    if (!id || id.includes("*")) {
      continue;
    }
    const rest = match[3] ?? "";
    if (rest === "" || rest === "messages") {
      roots.add(`/slack/${collection}/${id}/messages`);
      continue;
    }
    const thread = rest.match(/^threads\/([^/]+)(?:\/replies)?$/u);
    if (thread?.[1] && !thread[1].includes("*")) {
      roots.add(`/slack/${collection}/${id}/threads/${thread[1]}/replies`);
    }
  }
  return [...roots].sort();
}

function relayfileMountScript(
  mount: RelayfileMountConfig | null,
  options: { lazyRepos?: boolean } = {},
): string {
  if (!mount) return "";
  const localDir = DEPLOYMENT_WORKSPACE_DIR;
  const initialSyncPaths = relayfileInitialSyncPaths(mount.mountPaths);
  const commandRootLocalDirs = slackWritebackCommandRoots(mount.mountPaths).map(
    (root) => `${localDir}${root}`,
  );
  return buildRelayfileMountLifecycleShell({
    mount: {
      ...mount,
      interval: "3s",
      paths: mount.mountPaths,
      websocket: false,
      lazyRepos: options.lazyRepos === true,
    },
    localDir,
    initialSyncPaths,
    flushTimeoutSeconds: 75,
    // 300s no-progress idle timeout for the bootstrap full-pull (cloud #1516
    // interim): raises BOTH the outer buildIdleWatchedCommand wrapper AND the
    // daemon's internal RELAYFILE_BOOTSTRAP_IDLE_TIMEOUT (matched pair, set
    // together in buildRelayfileMountLifecycleShell) so a slow-but-progressing
    // atomic export completes instead of being cancelled at 90s -> the sticky
    // "non-empty without completed bootstrap" reconcile loop. This rescues the
    // slow subset now; the durable all-cases fix is the relayfile daemon's
    // export-to-resumable-tree fall-through (operator-released). It does NOT help a
    // truly-hung or empty-200 export (those need the daemon fix).
    initialSyncIdleTimeoutSeconds: 300,
    continueOnInitialSyncFailure: true,
    cleanupStatusMessage: MOUNT_CLEANUP_MESSAGE,
    commandRootLocalDirs,
    mountLogTail: {
      startMarker: MOUNT_LOG_TAIL_START,
      endMarker: MOUNT_LOG_TAIL_END,
      bytes: MOUNT_LOG_TAIL_BYTES,
      lines: MOUNT_LOG_TAIL_LINES,
    },
  });
}

function isProviderRootPath(path: string): boolean {
  return /^\/[^/]+\/\*\*$/u.test(path);
}

function stripTrailingGlob(path: string): string {
  return path.endsWith("/**")
    ? path.slice(0, -3)
    : path.endsWith("/")
      ? path.slice(0, -1)
      : path;
}

function arrayHasEntries(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function agentHasRelayfileTriggers(agent: DeploymentAgentSpec): boolean {
  return Object.keys(relayfileTriggerIntegrationsFromAgentOrLegacy({ agent }) ?? {}).length > 0;
}

function hasWebhookTriggerSource(agent: DeploymentAgentSpec): boolean {
  return agentHasRelayfileTriggers(agent)
    || arrayHasEntries(agent.watch)
    || arrayHasEntries(agent.watchRules)
    || arrayHasEntries(agent.watch_rules)
    || arrayHasEntries(agent.watchGlobs)
    || arrayHasEntries(agent.watch_globs);
}

function personaHasLegacyWebhookTriggerSource(persona: Record<string, unknown> | null): boolean {
  if (!persona) {
    return false;
  }
  return Object.keys(relayfileTriggerIntegrationsFromDeploymentSpec(persona) ?? {}).length > 0
    || arrayHasEntries(persona.triggers)
    || arrayHasEntries(persona.watch)
    || arrayHasEntries(persona.watchRules)
    || arrayHasEntries(persona.watch_rules)
    || arrayHasEntries(persona.watchGlobs)
    || arrayHasEntries(persona.watch_globs);
}

function personaHasLegacySchedules(persona: Record<string, unknown> | null): boolean {
  return arrayHasEntries(persona?.schedules);
}

function hasScheduleWithoutWebhookTrigger(
  agent: DeploymentAgentSpec | null,
  persona: Record<string, unknown> | null,
): boolean {
  if (agent) {
    return arrayHasEntries(agent.schedules) && !hasWebhookTriggerSource(agent);
  }
  return personaHasLegacySchedules(persona) && !personaHasLegacyWebhookTriggerSource(persona);
}

export function shouldUseLazyReposForDeploymentSpec(
  agent: DeploymentAgentSpec | null,
  persona: Record<string, unknown> | null = null,
): boolean {
  // Safe only because scheduled broad GitHub mounts run
  // githubMaterializeScript() before relayfile-mount initial sync. Poll-mode
  // lazy repos have no on-access FUSE trigger, so removing that pre-run
  // materialize step must make this predicate false again.
  return hasScheduleWithoutWebhookTrigger(agent, persona);
}

function githubMaterializeScript(input: {
  mount: RelayfileMountConfig | null;
  envelope: Record<string, unknown>;
  agentSpec?: DeploymentAgentSpec | null;
  persona?: Record<string, unknown> | null;
}): string {
  if (!input.mount || !hasScheduleWithoutWebhookTrigger(input.agentSpec ?? null, input.persona ?? null)) {
    return "";
  }
  const ownerRoots = githubMaterializeOwnerRootsForMountPaths([
    ...input.mount.mountPaths,
    ...(input.mount.syncPaths ?? []),
  ]);
  if (ownerRoots.length === 0) {
    return "";
  }
  const occurredAt = stringValue(input.envelope.occurredAt) ?? "";
  const script = `
const owners = new Set(${JSON.stringify(ownerRoots)});
const baseUrl = (process.env.RELAYFILE_URL || "").replace(/\\/+$/, "");
const workspaceId = process.env.RELAYFILE_WORKSPACE_ID || "";
const token = process.env.RELAYFILE_TOKEN || "";
// Default covers daily and weekly digests; longer-cadence scans must override
// RELAYFILE_GITHUB_MATERIALIZE_LOOKBACK_HOURS to match their handler window.
const lookbackHoursRaw = Number(process.env.RELAYFILE_GITHUB_MATERIALIZE_LOOKBACK_HOURS || "192");
const lookbackHours = Number.isFinite(lookbackHoursRaw) && lookbackHoursRaw > 0 ? lookbackHoursRaw : 192;
const occurredAtMs = Date.parse(${JSON.stringify(occurredAt)});
const windowEndMs = Number.isFinite(occurredAtMs) ? occurredAtMs : Date.now();
const sinceMs = windowEndMs - lookbackHours * 60 * 60 * 1000;
const concurrencyRaw = Number(process.env.RELAYFILE_GITHUB_MATERIALIZE_CONCURRENCY || "6");
const concurrency = Math.max(1, Math.min(16, Math.floor(Number.isFinite(concurrencyRaw) ? concurrencyRaw : 6)));
const requestTimeoutRaw = Number(process.env.RELAYFILE_GITHUB_MATERIALIZE_REQUEST_TIMEOUT_MS || "60000");
const requestTimeoutMs = Number.isFinite(requestTimeoutRaw) && requestTimeoutRaw > 0 ? requestTimeoutRaw : 60000;
const totalTimeoutRaw = Number(process.env.RELAYFILE_GITHUB_MATERIALIZE_TOTAL_TIMEOUT_MS || "240000");
const totalTimeoutMs = Number.isFinite(totalTimeoutRaw) && totalTimeoutRaw > 0 ? totalTimeoutRaw : 240000;
const deadlineMs = Date.now() + totalTimeoutMs;

function timedOut() {
  return Date.now() >= deadlineMs;
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  if (typeof AbortController === "undefined") {
    return undefined;
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}

function repoUpdatedMs(row) {
  const value = row && (row.updated || row.updated_at || row.pushed_at);
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function repoName(row) {
  return typeof row.repo === "string" && row.repo.trim()
    ? row.repo.trim()
    : typeof row.name === "string" && row.name.trim()
      ? row.name.trim()
      : typeof row.title === "string" && row.title.trim()
        ? row.title.trim()
        : typeof row.id === "string" && row.id.trim()
          ? row.id.trim()
          : "";
}

function repoIdentity(row, defaultOwner) {
  if (!row || typeof row !== "object") return null;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  const fullName = typeof row.full_name === "string" ? row.full_name.trim() : "";
  const combined = id.includes("/") ? id : fullName;
  if (combined.includes("/")) {
    const [owner, repo] = combined.split("/");
    return owner && repo ? { owner, repo } : null;
  }
  const owner = typeof row.owner === "string" && row.owner.trim() ? row.owner.trim() : defaultOwner || "";
  const repo = repoName(row);
  return owner && repo && !repo.includes("/") ? { owner, repo } : null;
}

async function relayfileRequest(pathname, init) {
  if (timedOut()) {
    throw new Error("github materialize total timeout exceeded before request");
  }
  const response = await fetch(baseUrl + pathname, {
    ...init,
    signal: timeoutSignal(Math.min(requestTimeoutMs, Math.max(1, deadlineMs - Date.now()))),
    headers: {
      Authorization: "Bearer " + token,
      "X-Correlation-Id": "corr_github_materialize_" + Date.now(),
      ...(init && init.headers ? init.headers : {}),
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(response.status + " " + response.statusText + (body ? " - " + body.slice(0, 300) : ""));
  }
  return response;
}

async function relayfileJson(pathname, init) {
  const response = await relayfileRequest(pathname, init);
  return response.json();
}

async function readCatalogRows(path, label) {
  try {
    const catalog = await relayfileJson("/v1/workspaces/" + encodeURIComponent(workspaceId) + "/fs/file?path=" + encodeURIComponent(path));
    const rows = JSON.parse(String(catalog.content || "[]"));
    if (!Array.isArray(rows)) {
      throw new Error(path + " is not an array");
    }
    return rows;
  } catch (error) {
    console.warn("[proactive-runtime] github materialize catalog read failed", {
      catalog: label,
      path,
      error: error && error.message ? error.message : String(error)
    });
    return [];
  }
}

async function runLimited(items, limit, fn) {
  let next = 0;
  let stoppedForTimeout = false;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      if (timedOut()) {
        stoppedForTimeout = true;
        break;
      }
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
  return { stoppedForTimeout, started: next };
}

if (!baseUrl || !workspaceId || !token) {
  console.warn("[proactive-runtime] github materialize skipped: relayfile env missing");
  process.exit(0);
}

try {
  const ownerRows = new Map();
  for (const owner of owners) {
    if (timedOut()) {
      break;
    }
    ownerRows.set(owner, await readCatalogRows("/github/repos/" + owner + "/_index.json", owner));
  }
  const catalogTimedOut = timedOut();
  const topLevelRows = catalogTimedOut ? [] : await readCatalogRows("/github/repos/_index.json", "top-level");
  const reposByKey = new Map();
  let skippedMissingIdentity = 0;
  let skippedMissingUpdated = 0;

  function addRows(rows, defaultOwner) {
    for (const row of rows) {
      const identity = repoIdentity(row, defaultOwner);
      if (!identity) {
        skippedMissingIdentity += 1;
        continue;
      }
      if (!owners.has(identity.owner)) continue;
      const updatedMs = repoUpdatedMs(row);
      if (updatedMs === null) {
        skippedMissingUpdated += 1;
        continue;
      }
      if (updatedMs < sinceMs) continue;
      reposByKey.set(identity.owner + "/" + identity.repo, { ...identity, updatedMs });
    }
  }

  for (const [owner, rows] of ownerRows.entries()) {
    addRows(rows, owner);
  }
  addRows(topLevelRows);
  const repos = [...reposByKey.values()].sort((left, right) =>
    (right.updatedMs || 0) - (left.updatedMs || 0)
      || (left.owner + "/" + left.repo).localeCompare(right.owner + "/" + right.repo)
  );
  if (skippedMissingIdentity || skippedMissingUpdated) {
    console.warn("[proactive-runtime] github materialize skipped catalog rows", {
      missingIdentity: skippedMissingIdentity,
      missingUpdated: skippedMissingUpdated
    });
  }
  if (repos.length === 0) {
    const message = catalogTimedOut || timedOut()
      ? "[proactive-runtime] github materialize incomplete"
      : "[proactive-runtime] github materialize found no recently updated repos";
    console.log(message, {
      owners: [...owners],
      lookbackHours,
      catalogTimedOut: catalogTimedOut || timedOut(),
      occurredAt: ${JSON.stringify(occurredAt)}
    });
    process.exit(0);
  }
  const started = Date.now();
  let failures = 0;
  const limited = await runLimited(repos, concurrency, async (repo) => {
    try {
      await relayfileRequest(
        "/v1/workspaces/" + encodeURIComponent(workspaceId)
          + "/integrations/github/repos/" + encodeURIComponent(repo.owner)
          + "/" + encodeURIComponent(repo.repo) + "/materialize",
        { method: "POST" }
      );
    } catch (error) {
      failures += 1;
      console.warn("[proactive-runtime] github repo materialize failed", {
        repo: repo.owner + "/" + repo.repo,
        error: error && error.message ? error.message : String(error)
      });
    }
  });
  const incomplete = limited.stoppedForTimeout || timedOut();
  console.log("[proactive-runtime] github materialize complete", {
    requested: repos.length,
    started: limited.started,
    failures,
    incomplete,
    owners: [...owners],
    occurredAt: ${JSON.stringify(occurredAt)},
    durationMs: Date.now() - started
  });
  if (incomplete || failures > 0) {
    console.warn("[proactive-runtime] github materialize incomplete", {
      requested: repos.length,
      started: limited.started,
      failures,
      timedOut: incomplete
    });
  }
} catch (error) {
  console.warn("[proactive-runtime] github materialize skipped", error && error.message ? error.message : String(error));
}
`;
  return [
    "echo '[proactive-runtime] materializing recent GitHub repos before relayfile mount'",
    `node -e ${shellSingleQuote(script)}`,
  ].join("\n");
}

function isSluggedGithubIssueOrPullPath(path: string): boolean {
  return /^\/github\/repos\/[^/]+\/[^/]+\/(?:issues|pulls)\/[1-9]\d*__[^/]+(?:\/.*)?$/u
    .test(stripTrailingGlob(path));
}

/**
 * Bootstrap (initial-sync `--once` full-pull) roots for the mount.
 *
 * Each entry becomes its own `relayfile-mount --once` full-pull, and a slow
 * `/fs/export` on any one of them can blow the 90s initial-sync watchdog →
 * SIGTERM (124) before the persona runner ever starts (cloud #1516, the
 * cloud-side amplifier of #1499). So we bootstrap ONLY the primary READ roots
 * and exclude writeback-companion paths: `relayfileWritebackCompanionPaths`
 * adds write targets the handler CREATES files under (e.g. the bare
 * `/github/repos/{o}/{r}/issues/{N}/**` comments dir — see the comment-draft
 * write path) — there is nothing to read-pull from them at bootstrap, and the
 * daemon still watches them for writeback. This collapses the slugged-issue +
 * plain-companion duplication (and every other primary/companion pair) so the
 * bootstrap does one full-pull per primary, not one per companion too.
 *
 * Excluding a path from bootstrap is correctness-safe: the daemon watches the
 * full path set, so anything not pre-pulled is synced lazily on access — this
 * changes pre-warmth, never breaks reads. A path that is its own only
 * companion (e.g. a bare `issues/N/**` with no slugged sibling) is NOT excluded
 * (the `companion !== source` guard), so a primary read-root is never dropped.
 */
export function relayfileInitialSyncPaths(
  pathsToSync: readonly string[],
): string[] {
  // Compare on a glob-insensitive base so a companion (always emitted with a
  // trailing `/**`) still matches a set path written without the glob (or with
  // a trailing slash). normalizeRelayfilePath does NOT canonicalize `/**`, so
  // `issues/N` and `issues/N/**` would otherwise be treated as different and
  // the companion would escape exclusion.
  const writebackCompanions = new Set<string>();
  const writebackCompanionBases = new Set<string>();
  for (const path of pathsToSync) {
    const normalized = normalizeRelayfilePath(path);
    if (!normalized) {
      continue;
    }
    const base = stripTrailingGlob(normalized);
    for (const companion of relayfileWritebackCompanionPaths(normalized)) {
      const normalizedCompanion = normalizeRelayfilePath(companion);
      if (!normalizedCompanion) {
        continue;
      }
      const companionBase = stripTrailingGlob(normalizedCompanion);
      // Different-base companions need glob-insensitive exclusion. Same-base
      // exact/glob pairs keep the older exact comparison so an exact primary
      // can still suppress its generated `/**` companion without suppressing
      // itself.
      if (companionBase !== base) {
        writebackCompanionBases.add(companionBase);
      } else if (normalizedCompanion !== normalized) {
        writebackCompanions.add(normalizedCompanion);
      }
    }
  }
  const paths = new Set<string>();
  for (const path of pathsToSync) {
    const normalized = normalizeRelayfilePath(path);
    if (!normalized || isProviderRootPath(normalized)) {
      continue;
    }
    if (
      writebackCompanions.has(normalized)
      || writebackCompanionBases.has(stripTrailingGlob(normalized))
    ) {
      // Writeback target — daemon covers it; no bootstrap full-pull needed.
      continue;
    }
    paths.add(normalized);
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

function relayfileRuntimeMountPaths(
  mount: RelayfileMountConfig,
  eventSyncPaths: readonly string[],
): string[] {
  return relayfileRuntimeMountPathsFromPathSets({
    mountPaths: mount.mountPaths ?? [],
    syncPaths: mount.syncPaths ?? [],
    eventSyncPaths,
  });
}

export function relayfileRuntimeMountPathsFromPathSets(input: {
  mountPaths: readonly string[];
  syncPaths?: readonly string[];
  eventSyncPaths?: readonly string[];
}): string[] {
  const normalizedPaths = [
    ...input.mountPaths,
    ...(input.syncPaths ?? []),
    ...(input.eventSyncPaths ?? []),
  ].flatMap((path) => {
    const normalized = normalizeRelayfilePath(path);
    return normalized && !isProviderRootPath(normalized) ? [normalized] : [];
  });
  const sluggedGithubCompanionBases = new Set<string>();
  for (const normalized of normalizedPaths) {
    if (!isSluggedGithubIssueOrPullPath(normalized)) {
      continue;
    }
    for (const companion of relayfileWritebackCompanionPaths(normalized)) {
      const normalizedCompanion = normalizeRelayfilePath(companion);
      if (normalizedCompanion) {
        sluggedGithubCompanionBases.add(stripTrailingGlob(normalizedCompanion));
      }
    }
  }

  const paths = new Set<string>();
  for (const normalized of normalizedPaths) {
    if (sluggedGithubCompanionBases.has(stripTrailingGlob(normalized))) {
      continue;
    }
    paths.add(normalized);
    for (const companion of relayfileWritebackCompanionPaths(normalized)) {
      const normalizedCompanion = normalizeRelayfilePath(companion);
      if (
        normalizedCompanion
        && (
          // Runtime mounts flush outbound provider writes from canonical paths.
          // Initial sync still excludes plain companions to avoid doubled pulls.
          isSluggedGithubIssueOrPullPath(normalized)
          || !sluggedGithubCompanionBases.has(stripTrailingGlob(normalizedCompanion))
        )
      ) {
        paths.add(normalizedCompanion);
      }
    }
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

function relayfileWritebackCompanionPaths(path: string): string[] {
  const withoutTrailingGlob = path.endsWith("/**") ? path.slice(0, -3) : path;
  const issueMatch = withoutTrailingGlob.match(
    /^\/github\/repos\/([^/]+)\/([^/]+)\/issues\/([1-9]\d*)(?:__[^/]+)?(?:\/.*)?$/u,
  );
  if (issueMatch) {
    const [, owner, repo, number] = issueMatch;
    return owner && repo && number
      ? [`/github/repos/${owner}/${repo}/issues/${number}/**`]
      : [];
  }
  const pullMatch = withoutTrailingGlob.match(
    /^\/github\/repos\/([^/]+)\/([^/]+)\/pulls\/([1-9]\d*)(?:__[^/]+)?(?:\/.*)?$/u,
  );
  if (pullMatch) {
    const [, owner, repo, number] = pullMatch;
    return owner && repo && number
      ? [
        `/github/repos/${owner}/${repo}/issues/${number}/**`,
        `/github/repos/${owner}/${repo}/pulls/${number}/**`,
      ]
      : [];
  }
  const slackThreadMatch = withoutTrailingGlob.match(
    /^\/slack\/channels\/([^/]+)\/threads\/([^/]+)(?:\/.*)?$/u,
  );
  if (slackThreadMatch?.[1] && slackThreadMatch[2]) {
    return [`/slack/channels/${slackThreadMatch[1]}/messages/${slackThreadMatch[2]}/replies/**`];
  }
  const slackChannelMatch = withoutTrailingGlob.match(
    /^\/slack\/channels?\/([^/]+)(?:\/.*)?$/u,
  );
  if (slackChannelMatch?.[1]) {
    return [`/slack/channels/${slackChannelMatch[1]}/messages/**`];
  }
  return [];
}

function hasInternalWildcard(path: string): boolean {
  const withoutTrailingGlob = path.endsWith("/**") ? path.slice(0, -3) : path;
  return withoutTrailingGlob.includes("*");
}

function isGenericGithubCollectionPath(path: string): boolean {
  const withoutTrailingGlob = path.endsWith("/**") ? path.slice(0, -3) : path;
  const segments = withoutTrailingGlob.split("/").filter(Boolean);
  return segments[0] === "github"
    && segments[1] === "repos"
    && segments.length === 5
    && ["issues", "pulls", "branches", "commits", "contents"].includes(segments[4] ?? "");
}

export function relayfileDaemonTokenPathsForRuntimeMountPaths(
  paths: readonly string[],
): string[] {
  const tokenPaths = new Set<string>();
  const candidates = new Set<string>();
  for (const path of paths) {
    const normalized = normalizeRelayfilePath(path);
    if (!normalized) {
      continue;
    }
    candidates.add(normalized);
    for (const companion of relayfileWritebackCompanionPaths(normalized)) {
      candidates.add(companion);
    }
  }
  for (const normalized of candidates) {
    if (
      isProviderRootPath(normalized)
      || hasInternalWildcard(normalized)
      || isGenericGithubCollectionPath(normalized)
    ) {
      continue;
    }
    tokenPaths.add(normalized);
  }
  return [...tokenPaths].sort((left, right) => left.localeCompare(right));
}

function relayfileRuntimeMountConfig(
  mount: RelayfileMountConfig | null,
  eventSyncPaths: readonly string[],
  gitWorkspace?: Pick<ProactiveGitWorkspaceConfig, "owner" | "repo"> | null,
): RelayfileMountConfig | null {
  if (!mount) return null;
  if (!mount.token) return null;
  const mountPaths = relayfileRuntimeMountPathsForGitWorkspace({
    paths: relayfileRuntimeMountPaths(mount, eventSyncPaths),
    gitWorkspace,
  });
  return mountPaths.length > 0 ? { ...mount, mountPaths } : null;
}

export function relayfileMountPathsForPersona(
  persona: Record<string, unknown> | null,
  agent?: DeploymentAgentSpec | null,
): {
  relayfilePaths: string[];
  syncPaths: string[];
} {
  if (!persona) {
    return { relayfilePaths: [], syncPaths: [] };
  }
  const deploymentAgent = agent ?? undefined;
  const triggerPaths = relayfilePathsForIntegrations(
    deploymentAgent
      ? relayfileTriggerIntegrationsFromAgentOrLegacy({ agent: deploymentAgent })
      : relayfileTriggerIntegrationsFromDeploymentSpec(persona),
  );
  const triggerPathSet = new Set(triggerPaths);
  const relayfilePaths = deriveRelayfileMountPaths(
    persona as never,
    deploymentAgent as never,
  );
  return {
    relayfilePaths,
    syncPaths: relayfilePaths.filter((path) => !triggerPathSet.has(path)),
  };
}

/**
 * Bash snippet run AFTER the runner exits to flush any pending writebacks the
 * handler queued (e.g. `ctx.github.comment` writes a draft JSON file under
 * `/home/daytona/workspace/github/...`). Mirrors `flushRelayfileMount` in the
 * workflow executor. Always kills the daemon PID at the end so the sandbox
 * shuts down cleanly. Returns an empty string when `mount` is null.
 */
function relayfileMountFlushScript(mount: RelayfileMountConfig | null): string {
  return buildRelayfileMountCleanupInvocationShell(mount);
}

export function buildDeploymentInvokeScript(input: {
  envVars: Record<string, string>;
  envUnsetKeys?: readonly string[];
  envelope: Record<string, unknown>;
  inputValues?: Record<string, string>;
  prReviewerPushPolicy?: PrReviewerPushPolicy;
  mount: RelayfileMountConfig | null;
  persona?: Record<string, unknown> | null;
  agentSpec?: DeploymentAgentSpec | null;
  pullRequestWorkspace?: PullRequestWorkspaceConfig | null;
  pullRequestWritebackWorkspace?: PullRequestWorkspaceConfig | null;
  pullRequestWarmCheckoutEnabled?: boolean;
  proactiveGitWorkspace?: ProactiveGitWorkspaceConfig | null;
}): string {
  const runtimeMount = relayfileRuntimeMountConfig(
    input.mount,
    eventScopedSyncPaths(input.envelope),
    input.proactiveGitWorkspace ?? null,
  );
  const envExports = Object.entries(input.envVars)
    .map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`)
    .join("\n");
  const envUnsets = [...new Set(input.envUnsetKeys ?? [])]
    .map((key) => `unset ${key}`)
    .join("\n");
  // Don't write a sandbox-side `runner.log`. Daytona's `uploadBundle`
  // materializes uploaded files at mode `0444` and the user-side
  // chmod from cloud#998 doesn't move that needle for those files —
  // verified against proactive-agents#112 sandbox `5bdc6186-...` where
  // `chmod -R u+w` ran cleanly but `: > runner.log` still failed with
  // EACCES at line 41 of the emitted cmd.sh. Files CREATED in-sandbox
  // (`.relayfile-mount-state.json`, `node_modules/` entries from the
  // npm-install fallback) come out `0644` and writable, but
  // bundle-uploaded `runner.log` stays read-only.
  //
  // The workflow executor (`packages/core/src/executor/executor.ts`)
  // never wrote a sandbox-side log either — it captures Daytona's
  // merged command output directly into the `LogStreamer` (S3-backed).
  // The proactive runtime now gets the equivalent through
  // `SandboxOrchestrator.runScript()`: callers inspect the ordered,
  // merged `result.output` for failure messages instead of trying to
  // reassemble split stream strings. Removing the redirect lets the handler's
  // structured-log lines (`{"t":"...","message":"runner.started",...}`)
  // flow to the runScript response, where the cloud-web Worker can log
  // them via the existing error pathway. Operators can also inspect
  // them post-fire via `daytona sandbox exec <id> -- cat
  // ~/.daytona/sessions/tick-<deploymentId>/<cmd-id>/output.log` since
  // Daytona's session machinery captures every command's stdout
  // automatically.
  //
  // The handler's writeback drafts (e.g.
  // `~/workspace/github/repos/<o>/<r>/issues/<n>/comments/create comment <uuid>.json`)
  // are unaffected — those are created in-sandbox by the runner and
  // inherit the writable dir's default mode.
  const prSetupScript = pullRequestWorkspaceSetupScript(
    input.pullRequestWorkspace ?? null,
    input.pullRequestWarmCheckoutEnabled === true,
  );
  const proactiveGitSetupScript = proactiveGitWorkspaceSetupScript(
    input.proactiveGitWorkspace ?? null,
  );
  const prScriptWritebackWorkspace = Object.prototype.hasOwnProperty.call(
    input,
    "pullRequestWritebackWorkspace",
  )
    ? input.pullRequestWritebackWorkspace ?? null
    : input.pullRequestWorkspace?.tokenEnvKey
      ? input.pullRequestWorkspace
      : null;
  const prPushScript = pullRequestWorkspacePushScript(
    prScriptWritebackWorkspace,
    input.prReviewerPushPolicy ??
      prReviewerPushPolicy({
        envelope: input.envelope,
        inputValues: input.inputValues,
        env: process.env,
      }),
  );
  const prCommentOutcomeScript = pullRequestCommentOutcomeScript(prScriptWritebackWorkspace);
  return [
    `mkdir -p ${DEPLOYMENT_RUNTIME_DIR} ${DEPLOYMENT_WORKSPACE_DIR}`,
    `cd ${DEPLOYMENT_RUNTIME_DIR}`,
    envUnsets,
    envExports,
    codexOauthCredentialMountScript(input.envVars),
    ...githubTokenCaptureLines(prScriptWritebackWorkspace),
    ...proactiveGitTokenCaptureLines(input.proactiveGitWorkspace ?? null),
    runtimeDependencyInstallScript(),
    prSetupScript,
    proactiveGitSetupScript,
    githubMaterializeScript({
      mount: runtimeMount,
      envelope: input.envelope,
      agentSpec: input.agentSpec ?? null,
      persona: input.persona ?? null,
    }),
    relayfileMountScript(runtimeMount, {
      lazyRepos: shouldUseLazyReposForDeploymentSpec(
        input.agentSpec ?? null,
        input.persona ?? null,
      ),
    }),
    "# node runner.mjs now executes from the isolated runtime directory",
    `printf '%s\\n' ${shellSingleQuote(JSON.stringify(input.envelope))} | node ${DEPLOYMENT_RUNTIME_DIR}/runner.mjs`,
    "RUNNER_EXIT=$?",
    "PUSH_EXIT=0",
    // The push-back script reports whether it actually committed+pushed
    // (PR_REVIEWER_PUSHED=1 + sha) so the comment draft can be corrected to
    // match reality. Without this, the agent's self-reported "fixed/pushed"
    // claim ships even when the clobber-guard, a fork, or a non-fast-forward
    // rejection meant nothing landed on the PR.
    "PR_REVIEWER_PUSHED=0",
    "PR_REVIEWER_PUSHED_SHA=",
    "if [ \"$RUNNER_EXIT\" -eq 0 ]; then",
    indentShell(prPushScript || ": # no pull request push-back configured"),
    // Rewrite the agent's comment draft with the authoritative push outcome
    // on the issue-comment surface. The script sets PR_REVIEWER_* env on its
    // own node -e line (see pullRequestCommentOutcomeScript), reading the shell
    // vars in scope here.
    indentShell(prCommentOutcomeScript || ": # no pull request comment outcome configured"),
    "fi",
    "MOUNT_EXIT=0",
    relayfileMountFlushScript(runtimeMount),
    "if [ \"$RUNNER_EXIT\" -ne 0 ]; then exit $RUNNER_EXIT; fi",
    "if [ \"$PUSH_EXIT\" -ne 0 ]; then exit $PUSH_EXIT; fi",
    "exit \"$MOUNT_EXIT\"",
  ].join("\n");
}

function indentShell(script: string): string {
  return script
    .split("\n")
    .map((line) => line ? `  ${line}` : line)
    .join("\n");
}

function githubTokenCaptureLines(pr: PullRequestWorkspaceConfig | null): string[] {
  if (!pr?.tokenEnvKey) return [];
  return [
    `PR_REVIEWER_GIT_TOKEN_VALUE="\${${pr.tokenEnvKey}:-}"`,
    `unset ${pr.tokenEnvKey}`,
    "PR_REVIEWER_GIT_ASKPASS=/tmp/pr-reviewer-git-askpass.sh",
    "cat > \"$PR_REVIEWER_GIT_ASKPASS\" <<'ASKPASS'",
    "#!/usr/bin/env sh",
    "case \"$1\" in",
    "*Username*) printf '%s\\n' 'x-access-token' ;;",
    "*) printf '%s\\n' \"$GITHUB_PR_WORKSPACE_TOKEN\" ;;",
    "esac",
    "ASKPASS",
    "chmod 700 \"$PR_REVIEWER_GIT_ASKPASS\"",
  ];
}

function withGitTokenPrefix(pr: PullRequestWorkspaceConfig): string {
  if (!pr.tokenEnvKey) return "";
  return "GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=\"$PR_REVIEWER_GIT_ASKPASS\" GITHUB_PR_WORKSPACE_TOKEN=\"$PR_REVIEWER_GIT_TOKEN_VALUE\" ";
}

const PROACTIVE_GIT_WORKSPACE_TOKEN_CAPTURE = "PROACTIVE_GIT_WORKSPACE_TOKEN_VALUE";

function proactiveGitTokenCaptureLines(workspace: ProactiveGitWorkspaceConfig | null): string[] {
  if (!workspace?.tokenEnvKey) return [];
  return [
    `${PROACTIVE_GIT_WORKSPACE_TOKEN_CAPTURE}="\${${workspace.tokenEnvKey}:-}"`,
    `unset ${workspace.tokenEnvKey}`,
  ];
}

function pullRequestWorkspaceSetupScript(
  pr: PullRequestWorkspaceConfig | null,
  warmCheckoutEnabled: boolean,
): string {
  if (!pr) return "";
  const conflictResolveMode = pr.mode === "conflictResolve";
  const context = JSON.stringify({
    owner: pr.owner,
    repo: pr.repo,
    pullRequestNumber: pr.number,
    baseSha: pr.baseSha,
    headSha: pr.headSha,
    headRef: pr.headRef,
    headRepoFullName: pr.headRepoFullName,
    canPush: pr.canPush,
    diffPath: ".workforce/pr.diff",
    changedFilesPath: ".workforce/changed-files.txt",
    diffMaxBytes: PR_DIFF_MAX_BYTES,
  }, null, 2);
  const gitPrefix = withGitTokenPrefix(pr);
  const headFetchRefSpec = shellSingleQuote(`+refs/pull/${pr.number}/head:refs/remotes/origin/pr/${pr.number}/head`);
  const baseFetchRefSpec = shellSingleQuote(`+${pr.baseSha}:refs/remotes/origin/pr/${pr.number}/base`);
  const checkoutSetupLines = warmCheckoutEnabled
    ? [
      `mkdir -p ${DEPLOYMENT_WORKSPACE_DIR}`,
      `if [ -d ${DEPLOYMENT_WORKSPACE_DIR}/.git ]; then`,
      "  echo '[pr-reviewer] reusing existing pull request workspace checkout'",
      `  cd ${DEPLOYMENT_WORKSPACE_DIR}`,
      `  git remote set-url origin ${shellSingleQuote(pr.remoteUrl)} || git remote add origin ${shellSingleQuote(pr.remoteUrl)}`,
      "else",
      `  rm -rf ${DEPLOYMENT_WORKSPACE_DIR}/* ${DEPLOYMENT_WORKSPACE_DIR}/.[!.]* ${DEPLOYMENT_WORKSPACE_DIR}/..?* 2>/dev/null || true`,
      `  git init ${DEPLOYMENT_WORKSPACE_DIR}`,
      `  cd ${DEPLOYMENT_WORKSPACE_DIR}`,
      `  git remote add origin ${shellSingleQuote(pr.remoteUrl)} || git remote set-url origin ${shellSingleQuote(pr.remoteUrl)}`,
      "fi",
    ]
    : [
      `rm -rf ${DEPLOYMENT_WORKSPACE_DIR}/* ${DEPLOYMENT_WORKSPACE_DIR}/.[!.]* ${DEPLOYMENT_WORKSPACE_DIR}/..?* 2>/dev/null || true`,
      `mkdir -p ${DEPLOYMENT_WORKSPACE_DIR}`,
      `git init ${DEPLOYMENT_WORKSPACE_DIR}`,
      `cd ${DEPLOYMENT_WORKSPACE_DIR}`,
    ];
  return [
    "echo '[pr-reviewer] preparing pull request workspace'",
    ...checkoutSetupLines,
    `git config user.name '${PR_REVIEWER_BOT_COMMIT_NAME}'`,
    `git config user.email '${PR_REVIEWER_BOT_COMMIT_EMAIL}'`,
    "git config --local --unset-all credential.helper >/dev/null 2>&1 || true",
    "rm -f ~/.git-credentials",
    ...(warmCheckoutEnabled
      ? [
        "mkdir -p .git/info",
        "cat > .git/info/exclude <<'EOF'",
        ".workforce/",
        "github/",
        "slack/",
        "node_modules/",
        ".relayfile-mount-state.json",
        "EOF",
      ]
      : [
        `git remote add origin ${shellSingleQuote(pr.remoteUrl)}`,
      ]),
    pr.tokenEnvKey
      ? `# GitHub token is installation-scoped; runtime limits usage to ${pr.owner}/${pr.repo}.`
      : "# Pull request checkout is running without a sandbox GitHub write token.",
    `${gitPrefix}git fetch --no-tags --depth=200 origin ${headFetchRefSpec} ${baseFetchRefSpec}`,
    `git checkout --force -B pr-head ${shellSingleQuote(`refs/remotes/origin/pr/${pr.number}/head`)}`,
    ...(warmCheckoutEnabled
      ? [
        `git reset --hard ${shellSingleQuote(`refs/remotes/origin/pr/${pr.number}/head`)}`,
        "git clean -ffd",
      ]
      : []),
    `git branch -f pr-base ${shellSingleQuote(`refs/remotes/origin/pr/${pr.number}/base`)}`,
    "git rev-parse --is-inside-work-tree >/dev/null",
    ...(warmCheckoutEnabled ? ["rm -rf .workforce"] : []),
    "mkdir -p .workforce",
    ...(warmCheckoutEnabled
      ? []
      : [
        "cat >> .git/info/exclude <<'EOF'",
        ".workforce/",
        "github/",
        "slack/",
        "node_modules/",
        ".relayfile-mount-state.json",
        "EOF",
      ]),
    "MERGE_BASE=$(git merge-base pr-base pr-head)",
    "git diff --name-only \"$MERGE_BASE...pr-head\" > .workforce/changed-files.txt",
    "git diff --binary \"$MERGE_BASE...pr-head\" > /tmp/pr-reviewer-pr.diff.full",
    `DIFF_BYTES=$(wc -c < /tmp/pr-reviewer-pr.diff.full | tr -d ' ')`,
    `if [ "$DIFF_BYTES" -gt ${PR_DIFF_MAX_BYTES} ]; then`,
    `  head -c ${PR_DIFF_MAX_BYTES} /tmp/pr-reviewer-pr.diff.full > .workforce/pr.diff`,
    `  printf '\\n\\n[PR diff truncated at ${PR_DIFF_MAX_BYTES} bytes; inspect the checkout for remaining changes.]\\n' >> .workforce/pr.diff`,
    "else",
    "  cp /tmp/pr-reviewer-pr.diff.full .workforce/pr.diff",
    "fi",
    "cat > .workforce/context.json <<'JSON'",
    context,
    "JSON",
    ...(conflictResolveMode
      ? [
        "echo '[pr-reviewer] merging base into PR head for conflict resolution'",
        "rm -f .workforce/conflicted-files.txt",
        "if git merge --no-ff --no-commit pr-base; then",
        "  : > .workforce/conflicted-files.txt",
        "  echo '[pr-reviewer] base merged cleanly for conflict resolution'",
        "else",
        "  git diff --name-only --diff-filter=U > .workforce/conflicted-files.txt",
        "  echo '[pr-reviewer] base merge produced conflicts for harness resolution'",
        "fi",
      ]
      : []),
    "if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo 'pr-reviewer workspace guard: cwd is not a git repo' >&2; exit 86; fi",
    "if git remote get-url origin | grep -E 'x-access-token|gh[psu]_' >/dev/null 2>&1; then echo 'pr-reviewer workspace guard: tokenized git remote persisted' >&2; exit 90; fi",
    "if [ -f ~/.git-credentials ]; then echo 'pr-reviewer workspace guard: git credential store file exists' >&2; exit 91; fi",
    "if [ ! -s .workforce/pr.diff ]; then echo 'pr-reviewer workspace guard: PR diff is empty' >&2; exit 87; fi",
    "if [ ! -s .workforce/changed-files.txt ]; then echo 'pr-reviewer workspace guard: changed files list is empty' >&2; exit 88; fi",
    `echo '[pr-reviewer] prepared pull request workspace for #${pr.number}'`,
  ].join("\n");
}

function proactiveGitWorkspaceSetupScript(workspace: ProactiveGitWorkspaceConfig | null): string {
  if (!workspace) return "";
  const tokenEnvKey = workspace.tokenEnvKey
    ? PROACTIVE_GIT_WORKSPACE_TOKEN_CAPTURE
    : null;
  return [
    buildGitWorkspaceSyncShell({
      source: {
        remoteUrl: workspace.remoteUrl,
        targetDir: workspace.targetDir,
        ref: workspace.ref,
        shallow: true,
      },
      credentials: tokenEnvKey && workspace.username
        ? {
            username: workspace.username,
            tokenEnvKey,
          }
        : null,
      askpassPath: "/home/daytona/.proactive-git-askpass",
      logPrefix: "[proactive-runtime]",
    }),
    tokenEnvKey ? `unset ${PROACTIVE_GIT_WORKSPACE_TOKEN_CAPTURE}` : "",
  ].filter(Boolean).join("\n");
}

function codexOauthCredentialMountScript(envVars: Record<string, string>): string {
  if (!envVars.CODEX_OAUTH_CREDENTIAL) return "";
  return [
    "mkdir -p /home/daytona/.codex",
    "printf '%s' \"$CODEX_OAUTH_CREDENTIAL\" > /home/daytona/.codex/auth.json",
    "chmod 600 /home/daytona/.codex/auth.json",
  ].join("\n");
}

function shellMultilineAssignment(
  variableName: string,
  values: readonly string[],
): string {
  return `${variableName}=${shellSingleQuote(values.join("\n"))}`;
}

function pullRequestPushPolicyGuardScript(
  pr: PullRequestWorkspaceConfig,
  policy: PrReviewerPushPolicy,
  pushVisiblePathspecArgs: string,
): string[] {
  const expectedRedScript = `
const fs = require("node:fs");
const owner = process.env.PR_REVIEWER_EXPECTED_RED_OWNER || "";
const repo = process.env.PR_REVIEWER_EXPECTED_RED_REPO || "";
const headSha = process.env.PR_REVIEWER_EXPECTED_RED_HEAD_SHA || "";
const token = process.env.PR_REVIEWER_GITHUB_TOKEN || "";
const reason = process.env.PR_REVIEWER_EXPECTED_RED_REASON || "pre-existing red CI";
const changedPath = ".workforce/pr-reviewer-local-changed-files.txt";
const seedPath = ".workforce/pr-reviewer-expected-red-seed-paths.txt";
const blockedPath = ".workforce/pr-reviewer-expected-red-blocked.txt";
const failureConclusions = new Set(["action_required", "cancelled", "failure", "startup_failure", "timed_out"]);

function normalizePath(value) {
  if (typeof value !== "string") return "";
  return value.replace(/^\\.\\//u, "").replace(/^\\/home\\/daytona\\/workspace\\//u, "").trim();
}

function readLines(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").split(/\\r?\\n/u).map(normalizePath).filter(Boolean);
  } catch {
    return [];
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function isTestFile(filePath) {
  return /(^|\\/)(__tests__|tests?)\\//iu.test(filePath) ||
    /(?:^|\\/)[^/]+\\.(?:test|spec)\\.[^/]+$/iu.test(filePath);
}

function intersect(left, right) {
  const rightSet = new Set(right);
  return left.filter((entry) => rightSet.has(entry));
}

async function githubJson(pathname) {
  const response = await fetch("https://api.github.com" + pathname, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + token,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agent-relay-pr-reviewer",
    },
  });
  if (!response.ok) {
    throw new Error("GitHub API " + pathname + " returned " + response.status);
  }
  return response.json();
}

function annotationPaths(entries) {
  const paths = [];
  for (const entry of entries) {
    const normalized = normalizePath(entry && (entry.path || entry.filename || entry.file));
    if (normalized) paths.push(normalized);
  }
  return paths;
}

function outputMentionsChangedTest(run, changedTests) {
  const output = run && typeof run === "object" ? run.output : null;
  const haystack = [
    run && run.name,
    output && output.title,
    output && output.summary,
    output && output.text,
  ].filter((entry) => typeof entry === "string").join("\\n");
  return changedTests.filter((testPath) => {
    const basename = testPath.split("/").pop();
    return haystack.includes(testPath) || (basename ? haystack.includes(basename) : false);
  });
}

(async () => {
  const changedTests = unique(readLines(changedPath).filter(isTestFile));
  if (changedTests.length === 0) {
    process.exit(0);
  }

  const seedMatches = intersect(changedTests, unique(readLines(seedPath)));
  if (seedMatches.length > 0) {
    fs.writeFileSync(
      blockedPath,
      seedMatches.map((filePath) => filePath + " (already red: " + reason + ")").join("\\n") + "\\n",
      "utf8",
    );
    process.exit(43);
  }

  if (!owner || !repo || !headSha || !token || typeof fetch !== "function") {
    console.warn("[pr-reviewer] expected-red gate could not query GitHub check annotations; continuing");
    process.exit(0);
  }

  try {
    const runs = await githubJson(
      "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo) +
        "/commits/" + encodeURIComponent(headSha) + "/check-runs?per_page=100&filter=latest",
    );
    const checkRuns = Array.isArray(runs.check_runs) ? runs.check_runs : [];
    const matches = new Set();
    for (const run of checkRuns) {
      const conclusion = String(run && run.conclusion || "").toLowerCase();
      if (!failureConclusions.has(conclusion)) continue;
      for (const match of outputMentionsChangedTest(run, changedTests)) {
        matches.add(match + " (already red: " + (run.name || reason) + ")");
      }
      const output = run && typeof run === "object" ? run.output : null;
      let paths = annotationPaths(output && Array.isArray(output.annotations) ? output.annotations : []);
      if (run && run.id) {
        try {
          const annotations = await githubJson(
            "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo) +
              "/check-runs/" + encodeURIComponent(String(run.id)) + "/annotations?per_page=100",
          );
          if (Array.isArray(annotations)) {
            paths = paths.concat(annotationPaths(annotations));
          }
        } catch (error) {
          console.warn(
            "[pr-reviewer] expected-red gate could not read annotations for check_run " +
              run.id + ": " + (error && error.message || error),
          );
        }
      }
      for (const match of intersect(changedTests, unique(paths))) {
        matches.add(match + " (already red: " + (run.name || reason) + ")");
      }
    }
    if (matches.size > 0) {
      fs.writeFileSync(blockedPath, [...matches].sort().join("\\n") + "\\n", "utf8");
      process.exit(43);
    }
  } catch (error) {
    console.warn("[pr-reviewer] expected-red gate could not inspect GitHub checks; continuing: " + (error && error.message || error));
  }
  process.exit(0);
})();
`;
  return [
    `git diff --name-only HEAD -- ${pushVisiblePathspecArgs} > .workforce/pr-reviewer-local-changed-files.txt`,
    `git ls-files --others --exclude-standard -- ${pushVisiblePathspecArgs} >> .workforce/pr-reviewer-local-changed-files.txt`,
    "sort -u .workforce/pr-reviewer-local-changed-files.txt -o .workforce/pr-reviewer-local-changed-files.txt",
    shellMultilineAssignment(
      "PR_REVIEWER_IMMUTABLE_PATH_DENYLIST",
      policy.immutablePathDenylist,
    ),
    "PR_REVIEWER_IMMUTABLE_MATCHES=",
    "while IFS= read -r PR_REVIEWER_CHANGED_FILE; do",
    "  [ -n \"$PR_REVIEWER_CHANGED_FILE\" ] || continue",
    "  while IFS= read -r PR_REVIEWER_DENY_PATTERN; do",
    "    [ -n \"$PR_REVIEWER_DENY_PATTERN\" ] || continue",
    "    if [[ \"$PR_REVIEWER_CHANGED_FILE\" == $PR_REVIEWER_DENY_PATTERN ]]; then",
    "      PR_REVIEWER_IMMUTABLE_MATCHES=\"${PR_REVIEWER_IMMUTABLE_MATCHES}${PR_REVIEWER_CHANGED_FILE} (matched ${PR_REVIEWER_DENY_PATTERN})\"$'\\n'",
    "      break",
    "    fi",
    "  done <<< \"$PR_REVIEWER_IMMUTABLE_PATH_DENYLIST\"",
    "done < .workforce/pr-reviewer-local-changed-files.txt",
    "if [ -n \"$PR_REVIEWER_IMMUTABLE_MATCHES\" ]; then",
    "  echo '[pr-reviewer] bot-immutable path gate blocked push' >&2",
    "  printf '%s' \"$PR_REVIEWER_IMMUTABLE_MATCHES\" >&2",
    "  PR_REVIEWER_PUSH_BLOCKED_FILES=\"$PR_REVIEWER_IMMUTABLE_MATCHES\"",
    "  PUSH_EXIT=93",
    "fi",
    shellMultilineAssignment(
      "PR_REVIEWER_EXPECTED_RED_SEED_PATHS",
      policy.expectedRedTestPaths,
    ),
    `PR_REVIEWER_EXPECTED_RED_REASON=${shellSingleQuote(policy.expectedRedReason ?? "")}`,
    "printf '%s\\n' \"$PR_REVIEWER_EXPECTED_RED_SEED_PATHS\" > .workforce/pr-reviewer-expected-red-seed-paths.txt",
    "if [ -n \"$PR_REVIEWER_EXPECTED_RED_REASON\" ]; then",
    "  while IFS= read -r PR_REVIEWER_ORIGINAL_CHANGED_FILE; do",
    "    [ -n \"$PR_REVIEWER_ORIGINAL_CHANGED_FILE\" ] || continue",
    "    case \"$PR_REVIEWER_ORIGINAL_CHANGED_FILE\" in",
    "      *test.*|*spec.*) printf '%s\\n' \"$PR_REVIEWER_ORIGINAL_CHANGED_FILE\" ;;",
    "    esac",
    "  done < .workforce/changed-files.txt >> .workforce/pr-reviewer-expected-red-seed-paths.txt",
    "  sort -u .workforce/pr-reviewer-expected-red-seed-paths.txt -o .workforce/pr-reviewer-expected-red-seed-paths.txt",
    "fi",
    "rm -f .workforce/pr-reviewer-expected-red-blocked.txt",
    "if [ \"$PUSH_EXIT\" -eq 0 ]; then",
    [
      `PR_REVIEWER_GITHUB_TOKEN="$PR_REVIEWER_GIT_TOKEN_VALUE"`,
      `PR_REVIEWER_EXPECTED_RED_OWNER=${shellSingleQuote(pr.owner)}`,
      `PR_REVIEWER_EXPECTED_RED_REPO=${shellSingleQuote(pr.repo)}`,
      `PR_REVIEWER_EXPECTED_RED_HEAD_SHA=${shellSingleQuote(pr.headSha)}`,
      "PR_REVIEWER_EXPECTED_RED_REASON=\"$PR_REVIEWER_EXPECTED_RED_REASON\"",
      `node -e ${shellSingleQuote(expectedRedScript)}`,
    ].join(" "),
    "  PR_REVIEWER_EXPECTED_RED_EXIT=$?",
    "  if [ \"$PR_REVIEWER_EXPECTED_RED_EXIT\" -eq 43 ]; then",
    "    echo '[pr-reviewer] expected-red test gate blocked push' >&2",
    "    cat .workforce/pr-reviewer-expected-red-blocked.txt >&2",
    "    PR_REVIEWER_PUSH_BLOCKED_FILES=$(cat .workforce/pr-reviewer-expected-red-blocked.txt)",
    "    PUSH_EXIT=94",
    "  elif [ \"$PR_REVIEWER_EXPECTED_RED_EXIT\" -ne 0 ]; then",
    "    echo \"[pr-reviewer] expected-red gate exited $PR_REVIEWER_EXPECTED_RED_EXIT; continuing\" >&2",
    "  fi",
    "fi",
  ];
}

function pullRequestWorkspacePushScript(
  pr: PullRequestWorkspaceConfig | null,
  policy: PrReviewerPushPolicy,
): string {
  if (!pr) return "";
  const conflictResolveMode = pr.mode === "conflictResolve";
  const expectedHead = shellSingleQuote(pr.headSha);
  const headGuard = [
    `EXPECTED_PR_HEAD=${expectedHead}`,
    "CURRENT_PR_HEAD=$(git rev-parse HEAD 2>/dev/null || true)",
    "if [ \"$CURRENT_PR_HEAD\" != \"$EXPECTED_PR_HEAD\" ]; then",
    `  echo '[pr-reviewer] workspace checkout changed before push for #${pr.number}; refusing clean-tree noop' >&2`,
    "  echo \"expected HEAD $EXPECTED_PR_HEAD, found ${CURRENT_PR_HEAD:-missing}\" >&2",
    "  PUSH_EXIT=92",
    "fi",
  ];
  const vfsInternalPathspecs = ["memory/workspace", ".relay", "**/.relay/**"];
  const vfsInternalPathspecArgs = vfsInternalPathspecs.map(shellSingleQuote).join(" ");
  const pushVisiblePathspecArgs = [
    ".",
    ":(exclude)memory/workspace",
    ":(exclude).relay",
    ":(exclude).relay/**",
    ":(exclude)**/.relay/**",
  ].map(shellSingleQuote).join(" ");
  const unstageVfsInternalCommand = `git reset -q -- ${vfsInternalPathspecArgs} 2>/dev/null || true`;
  const statusCommand = `CHANGED=$(git status --porcelain --untracked-files=all -- ${pushVisiblePathspecArgs})`;
  const addCommand = `git add -A -- ${pushVisiblePathspecArgs} || PUSH_EXIT=$?`;
  if (!pr.canPush) {
    return [
      `cd ${DEPLOYMENT_WORKSPACE_DIR}`,
      "PR_REVIEWER_PUSH_BLOCKED_FILES=",
      "PR_REVIEWER_EXPECTED_RED_REASON=",
      ...headGuard,
      "if [ \"$PUSH_EXIT\" -eq 0 ]; then",
      unstageVfsInternalCommand,
      statusCommand,
      "if [ -n \"$CHANGED\" ]; then",
      "  echo '[pr-reviewer] changed tree detected, but push-back is disabled for this PR' >&2",
      "  echo 'cannot push pr-reviewer fixes for fork or read-only PR' >&2",
      "  PUSH_EXIT=89",
      "else",
      "  echo '[pr-reviewer] clean tree after harness; no push needed'",
      "fi",
      "fi",
    ].join("\n");
  }
  const gitPrefix = withGitTokenPrefix(pr);
  const pushRefSpec = shellSingleQuote(`HEAD:refs/heads/${pr.headRef}`);
  const forceWithLeaseArg = shellSingleQuote(`refs/heads/${pr.headRef}:${pr.headSha}`);
  const pushCommand = conflictResolveMode
    ? `${gitPrefix}git push --force-with-lease=${forceWithLeaseArg} origin ${pushRefSpec}`
    : `${gitPrefix}git push origin ${pushRefSpec}`;
  const retryPushCommand = conflictResolveMode
    ? pushCommand
    : `${gitPrefix}git push origin ${pushRefSpec}`;
  const commitCommand = conflictResolveMode
    ? "git commit --no-edit"
    : `git commit -m ${shellSingleQuote(`chore: apply pr-reviewer fixes for #${pr.number}`)}`;
  const fetchHeadRefSpec = shellSingleQuote(
    `+refs/heads/${pr.headRef}:refs/remotes/origin/${pr.headRef}`,
  );
  const remoteHeadRef = shellSingleQuote(`refs/remotes/origin/${pr.headRef}`);
  return [
    `cd ${DEPLOYMENT_WORKSPACE_DIR}`,
    "PR_REVIEWER_PUSH_BLOCKED_FILES=",
    "PR_REVIEWER_EXPECTED_RED_REASON=",
    ...headGuard,
    "if [ \"$PUSH_EXIT\" -eq 0 ]; then",
    unstageVfsInternalCommand,
    statusCommand,
    "if [ -n \"$CHANGED\" ]; then",
    "  echo '[pr-reviewer] changed tree detected; checking push gates'",
    ...pullRequestPushPolicyGuardScript(pr, policy, pushVisiblePathspecArgs).map((line) => line ? `  ${line}` : line),
    "  if [ \"$PUSH_EXIT\" -ne 0 ]; then",
    "    echo '[pr-reviewer] push gate blocked fixes before commit' >&2",
    "  else",
    "    echo '[pr-reviewer] changed tree detected; committing and pushing fixes'",
    ...(conflictResolveMode
      ? [
        `    if git grep -n -E '^(<<<<<<<|=======|>>>>>>>)' -- ${pushVisiblePathspecArgs} > .workforce/pr-reviewer-conflict-markers.txt; then`,
        "      echo '[pr-reviewer] unresolved conflict markers remain; refusing conflict-resolution push' >&2",
        "      PR_REVIEWER_PUSH_BLOCKED_FILES=$(cat .workforce/pr-reviewer-conflict-markers.txt)",
        "      PUSH_EXIT=95",
        "    fi",
      ]
      : []),
    "    if [ \"$PUSH_EXIT\" -eq 0 ]; then",
    `      ${addCommand}`,
    "    fi",
    "    if [ \"$PUSH_EXIT\" -ne 0 ]; then",
    "      echo '[pr-reviewer] push preparation failed before commit' >&2",
    `  elif ${commitCommand}; then`,
    `    if ${pushCommand}; then`,
    `    echo '[pr-reviewer] pushed fixes for #${pr.number}'`,
    "    PR_REVIEWER_PUSHED=1",
    "    PR_REVIEWER_PUSHED_SHA=$(git rev-parse HEAD 2>/dev/null || true)",
    "    else",
    "      PUSH_EXIT=$?",
    ...(conflictResolveMode
      ? [
        "      echo '[pr-reviewer] conflict-resolution push failed; refusing rebase retry' >&2",
      ]
      : [
        "      echo '[pr-reviewer] push failed; fetching remote head and retrying once' >&2",
        `      if ${gitPrefix}git fetch --no-tags --depth=200 origin ${fetchHeadRefSpec}; then`,
        `        if git rebase ${remoteHeadRef}; then`,
        "          PUSH_EXIT=0",
        `          if ${retryPushCommand}; then`,
        `            echo '[pr-reviewer] pushed fixes for #${pr.number} after rebase retry'`,
        "            PR_REVIEWER_PUSHED=1",
        "            PR_REVIEWER_PUSHED_SHA=$(git rev-parse HEAD 2>/dev/null || true)",
        "          else",
        "            PUSH_EXIT=$?",
        "            echo '[pr-reviewer] push retry failed' >&2",
        "          fi",
        "        else",
        "          PUSH_EXIT=$?",
        "          echo '[pr-reviewer] rebase before push retry failed' >&2",
        "          git rebase --abort >/dev/null 2>&1 || true",
        "        fi",
        "      else",
        "        PUSH_EXIT=$?",
        "        echo '[pr-reviewer] fetch before push retry failed' >&2",
        "      fi",
      ]),
    "    fi",
    "  else",
    "    PUSH_EXIT=$?",
    "    echo '[pr-reviewer] commit failed' >&2",
    "  fi",
    "  fi",
    "else",
    "  echo '[pr-reviewer] clean tree after harness; no push needed'",
    "fi",
    "fi",
    "rm -f \"$PR_REVIEWER_GIT_ASKPASS\"",
    "unset PR_REVIEWER_GIT_TOKEN_VALUE GITHUB_PR_WORKSPACE_TOKEN",
  ].join("\n");
}

// Rewrites the agent's pending issue-comment draft so it leads with the
// authoritative push outcome cloud actually observed. The harness comment is
// the agent's self-report — it can claim "fixed / pushed / tests pass" even
// when the clobber-guard (PUSH_EXIT=92), a fork (89), or a non-fast-forward
// rejection meant nothing landed on the PR. Reads PR_REVIEWER_PUSH_EXIT /
// PR_REVIEWER_PUSHED / PR_REVIEWER_PUSHED_SHA from the environment (set by the
// push-back script). Tolerant: no draft / parse failure → no-op, exit 0.
function pullRequestCommentOutcomeScript(pr: PullRequestWorkspaceConfig | null): string {
  if (!pr) return "";
  const script = `
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SENTINEL = "<!-- pr-reviewer-push-outcome -->";
const workspaceDir = ${JSON.stringify(DEPLOYMENT_WORKSPACE_DIR)};
const ownerSegment = ${JSON.stringify(encodeURIComponent(pr.owner))};
const repoSegment = ${JSON.stringify(encodeURIComponent(pr.repo))};
const pullNumber = ${JSON.stringify(String(pr.number))};
const canPush = ${pr.canPush ? "true" : "false"};
const commentsDir = path.join(
  workspaceDir,
  "github",
  "repos",
  ownerSegment,
  repoSegment,
  "issues",
  pullNumber,
  "comments"
);

function latestDraft(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.includes(".tmp-"))
    .map((entry) => {
      const filePath = path.join(dir, entry.name);
      return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const candidate of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate.filePath, "utf8"));
      if (parsed && typeof parsed.body === "string" && parsed.body.trim()) {
        return { filePath: candidate.filePath, parsed };
      }
    } catch {}
  }
  return null;
}

function outcomeHeader() {
  const exitRaw = (process.env.PR_REVIEWER_PUSH_EXIT || "0").trim();
  const pushed = (process.env.PR_REVIEWER_PUSHED || "0").trim() === "1";
  const sha = (process.env.PR_REVIEWER_PUSHED_SHA || "").trim().slice(0, 7);
  const blockedFiles = (process.env.PR_REVIEWER_PUSH_BLOCKED_FILES || "").trim();
  const expectedRedReason = (process.env.PR_REVIEWER_EXPECTED_RED_REASON || "").trim();
  const blockedSuffix = blockedFiles ? "\\n\\nBlocked files:\\n\`\`\`\\n" + blockedFiles + "\\n\`\`\`" : "";
  if (pushed) {
    return "✅ **pr-reviewer applied fixes** — committed and pushed" + (sha ? " \`" + sha + "\`" : "") + " to this PR. The notes below describe what changed.";
  }
  if (exitRaw === "0") {
    return "ℹ️ **pr-reviewer: review only** — no file changes were applied to the PR (nothing to commit after review). The notes below are advisory and were **not** pushed.";
  }
  if (exitRaw === "92") {
    return "⚠️ **pr-reviewer did not push** — the PR branch advanced during the review, so fixes were withheld to avoid overwriting newer commits. Re-trigger the review once the branch settles. The notes below are advisory and were **not** pushed.";
  }
  if (exitRaw === "89" || !canPush) {
    return "⚠️ **pr-reviewer could not push** — this PR is from a fork or is read-only, so fixes were not applied. The notes below are advisory and were **not** pushed.";
  }
  if (exitRaw === "93") {
    return "⚠️ **pr-reviewer did not push** — the proposed changes touched bot-immutable paths, so fixes were withheld for human review. The notes below are advisory and were **not** pushed." + blockedSuffix;
  }
  if (exitRaw === "94") {
    return "⚠️ **pr-reviewer did not push** — CI was already red for test files the proposed changes also modified" + (expectedRedReason ? " (" + expectedRedReason + ")" : "") + ", so fixes were withheld for human review. The notes below are advisory and were **not** pushed." + blockedSuffix;
  }
  if (exitRaw === "95") {
    return "⚠️ **pr-reviewer did not push** — unresolved conflict markers remain, so Cloud refused to finalize or push the merge. The notes below are advisory and were **not** pushed." + blockedSuffix;
  }
  return "⚠️ **pr-reviewer push failed** (exit \`" + exitRaw + "\`) — fixes were not applied to the PR. The notes below are advisory and were **not** pushed.";
}

function shouldCreateStandaloneWarning() {
  const exitRaw = (process.env.PR_REVIEWER_PUSH_EXIT || "0").trim();
  return exitRaw === "93" || exitRaw === "94" || exitRaw === "95";
}

try {
  const draft = latestDraft(commentsDir);
  if (!draft) {
    if (shouldCreateStandaloneWarning()) {
      fs.mkdirSync(commentsDir, { recursive: true });
      const filePath = path.join(commentsDir, "create comment pr-reviewer-push-blocked-" + crypto.randomUUID() + ".json");
      const body = SENTINEL + "\\n" + outcomeHeader();
      fs.writeFileSync(filePath, JSON.stringify({ body }, null, 2) + "\\n", "utf8");
      console.log("[pr-reviewer] created standalone push-block warning comment draft", {
        source: path.relative(workspaceDir, filePath),
        pushExit: (process.env.PR_REVIEWER_PUSH_EXIT || "0").trim()
      });
      process.exit(0);
    }
    console.log("[pr-reviewer] no comment draft to annotate with push outcome");
    process.exit(0);
  }
  if (draft.parsed.body.includes(SENTINEL)) {
    process.exit(0);
  }
  const header = SENTINEL + "\\n" + outcomeHeader();
  const nextBody = header + "\\n\\n" + draft.parsed.body;
  const tempPath = draft.filePath + ".tmp-" + crypto.randomUUID();
  fs.writeFileSync(tempPath, JSON.stringify({ ...draft.parsed, body: nextBody }, null, 2) + "\\n", "utf8");
  fs.renameSync(tempPath, draft.filePath);
  console.log("[pr-reviewer] annotated comment draft with push outcome", {
    source: path.relative(workspaceDir, draft.filePath),
    pushed: (process.env.PR_REVIEWER_PUSHED || "0").trim() === "1",
    pushExit: (process.env.PR_REVIEWER_PUSH_EXIT || "0").trim()
  });
} catch (error) {
  console.error("[pr-reviewer] failed to annotate comment draft (non-fatal)", error && error.message ? error.message : error);
}
process.exit(0);
`;
  // The env assignments MUST sit on the same line as `node -e` so they scope to
  // the node process. A leading-prefix on a multi-line snippet would only apply
  // to the first command (the echo), leaving node to read empty env and
  // mislabel every push as "review only".
  return [
    "echo '[pr-reviewer] annotating review comment with authoritative push outcome'",
    `PR_REVIEWER_PUSH_EXIT="$PUSH_EXIT" PR_REVIEWER_PUSHED="$PR_REVIEWER_PUSHED" PR_REVIEWER_PUSHED_SHA="$PR_REVIEWER_PUSHED_SHA" PR_REVIEWER_PUSH_BLOCKED_FILES="$PR_REVIEWER_PUSH_BLOCKED_FILES" PR_REVIEWER_EXPECTED_RED_REASON="$PR_REVIEWER_EXPECTED_RED_REASON" node -e ${shellSingleQuote(script)}`,
  ].join("\n");
}

function runtimeDependencyInstallScript(): string {
  // Use newline separators rather than `; `. The block contains an
  // if/then/else/fi construct where `then;` and `else;` are syntax
  // errors in bash (no command may follow `then` / `else` via a
  // separator alone). Newlines are safe everywhere a statement
  // separator is valid.
  //
  // The sandbox snapshot (`relay-orchestrator-sdk-*`) pre-bakes
  // `@agentworkforce/runtime` in the runtime directory. When that bake
  // is present, skip `npm install` entirely — it otherwise spends 30-60s
  // walking the dependency graph against the npm registry on every
  // per-fire sandbox, which alone can exhaust Daytona's ~120s
  // `runScript` proxy budget (524 from `proxy.app.daytona.io` observed
  // against issue #103 even after #976 dropped the initial
  // relayfile-mount sync).
  //
  // When the bake is missing or stale, fall back to an exact runtime install
  // from the registry. Do not use --prefer-offline here: the failure in #1214
  // was a stale baked npm cache resolving runtime ranges to packages whose
  // transitive dependencies were absent from the cache.
  //
  // The install MUST be the direct `--no-save <pkg>@<exact>` form and MUST
  // NOT touch package.json. Two hard constraints, both hit by hn-monitor's
  // first fire (2026-06-03):
  //   1. The uploaded bundle's package.json materializes read-only
  //      (Daytona uploadBundle mode 0444 — see the runner.log note above),
  //      so an in-place patch (fs.writeFileSync) dies with EACCES.
  //   2. A bare `npm install` then reconciles node_modules against the
  //      unpatched (near-empty) package.json and REMOVES the entire baked
  //      runtime tree, leaving the runner with
  //      ERR_MODULE_NOT_FOUND '@agentworkforce/runtime'.
  // `--no-save` installs the exact runtime + its transitives into
  // node_modules without writing package.json and without reconcile-pruning
  // what the bake provided. It works identically whether package.json
  // exists or not, so there is deliberately no branch here.
  return [
    `RUNTIME_VERSION="$(node -e "try{console.log(require('./node_modules/${WORKFORCE_RUNTIME_PACKAGE}/package.json').version)}catch(_error){process.exit(1)}" 2>/dev/null || true)"`,
    `RUNTIME_DEPS_OK="$(node -e ${shellSingleQuote(`try{${WORKFORCE_RUNTIME_AWS_SMITHY_REQUIRE_CHECK}}catch(_error){process.exit(1)}`)} >/dev/null 2>&1 && echo 1 || true)"`,
    `if [ "$RUNTIME_VERSION" = "${WORKFORCE_RUNTIME_VERSION}" ] && [ "$RUNTIME_DEPS_OK" = "1" ]; then`,
    `  : # runtime ${WORKFORCE_RUNTIME_VERSION} pre-baked into snapshot; skip install`,
    "else",
    `  if [ -n "$RUNTIME_VERSION" ] && [ "$RUNTIME_VERSION" != "${WORKFORCE_RUNTIME_VERSION}" ]; then echo "[proactive-runtime] baked runtime version $RUNTIME_VERSION != ${WORKFORCE_RUNTIME_VERSION}; installing exact runtime"; fi`,
    `  if [ "$RUNTIME_DEPS_OK" != "1" ]; then echo "[proactive-runtime] baked runtime dependency closure failed health check; installing exact runtime"; fi`,
    `  npm install --omit=dev --no-audit --no-fund --no-save ${WORKFORCE_RUNTIME_SPEC} ${WORKFORCE_RUNTIME_AWS_SMITHY_INSTALL_SPECS} || { echo "[proactive-runtime] npm install failed with exit code $?"; exit 1; }`,
    "fi",
    `node -e ${shellSingleQuote(WORKFORCE_RUNTIME_SMITHY_DIAGNOSTIC)} || true`,
    // Re-emit the diagnostic in the failure branch so its [smithy-diag] lines are
    // the LAST output before exit — the run record keeps only the output tail, and
    // the load-check stack trace would otherwise push the (earlier) diagnostic out
    // of the captured tail. This makes the box's actual @smithy/smithy-client
    // resolution visible in the `/runs` error without needing to exec the box.
    `node -e ${shellSingleQuote(`${WORKFORCE_RUNTIME_SMITHY_LOAD_CHECK}.catch((error)=>{console.error('[proactive-runtime] runtime load failed:', error && error.stack || error);process.exit(1)})`)} || { echo "[proactive-runtime] runtime load check failed"; node -e ${shellSingleQuote(WORKFORCE_RUNTIME_SMITHY_DIAGNOSTIC)} || true; exit 1; }`,
  ].join("\n");
}

function runtimeAgentContext(input: {
  agentId: string;
  deployedName: string;
  inputValues: Record<string, string>;
}): string {
  return JSON.stringify({
    id: input.agentId,
    deployedName: input.deployedName,
    spawnedByAgentId: null,
    input_values: input.inputValues,
    inputValues: input.inputValues,
  });
}

function runtimeDeploymentContext(input: {
  deploymentId: string;
  triggerKind: "inbox" | "clock";
}): string {
  return JSON.stringify({
    id: input.deploymentId,
    triggerKind: input.triggerKind,
    parentDeploymentId: null,
  });
}

/**
 * The complete field set `buildEnvelope` can emit (cloud#1841). This is the
 * cross-repo envelope CONTRACT ANCHOR: workforce's `RawGatewayEnvelope`
 * (packages/runtime/src/shim.ts) pins its documented fields against this
 * list via a checked-in copy (workforce#189). A unit test in this repo pins
 * `buildEnvelope`'s actual output to this constant, so drift on either side
 * fails CI instead of silently widening.
 *
 * `always` fields appear on every envelope; `optional` fields appear only
 * when the trigger payload carries them.
 */
export const ENVELOPE_FIELDS = {
  always: ["id", "workspace", "type", "occurredAt", "attempt", "name", "cron", "resource"],
  optional: ["provider", "eventType", "deliveryId", "paths", "summary", "resumeContext", "harnessSession", "channel", "messageId", "threadId"],
} as const;

export function buildEnvelope(input: {
  workspaceId: string;
  deploymentId: string;
  payload: unknown;
  resumeContext?: DeploymentResumeContext;
  harnessSession?: DeploymentHarnessSession | null;
}): Record<string, unknown> {
  const payload = isRecord(input.payload) ? input.payload : {};
  const rawType = stringValue(payload.type) ?? stringValue(payload.eventType);
  const type = rawType ?? "cron.tick";
  const occurredAt =
    stringValue(payload.occurredAt) ??
    stringValue(payload.occurred_at) ??
    (() => {
      const occurrenceEpoch = numericValue(payload.occurrenceEpoch);
      return occurrenceEpoch === null ? null : new Date(occurrenceEpoch).toISOString();
    })() ??
    new Date().toISOString();
  return {
    id:
      stringValue(payload.id) ??
      stringValue(payload.eventId) ??
      stringValue(payload.occurrenceId) ??
      stringValue(payload.deliveryId) ??
      input.deploymentId,
    workspace: input.workspaceId,
    type,
    occurredAt,
    attempt: numberValue(payload.attempt) ?? 1,
    name:
      stringValue(payload.name) ??
      stringValue(payload.scheduleName) ??
      stringValue(payload.scheduleId) ??
      "",
    cron: stringValue(payload.cron) ?? stringValue(payload.cronExpression) ?? "",
    ...(stringValue(payload.provider) ? { provider: stringValue(payload.provider) } : {}),
    ...(stringValue(payload.eventType) ? { eventType: stringValue(payload.eventType) } : {}),
    ...(stringValue(payload.deliveryId) ? { deliveryId: stringValue(payload.deliveryId) } : {}),
    ...(Array.isArray(payload.paths)
      ? { paths: payload.paths.filter((entry): entry is string => typeof entry === "string") }
      : {}),
    resource: payload.resource ?? payload,
    ...(isRecord(payload.summary) ? { summary: payload.summary } : {}),
    ...(input.resumeContext ? { resumeContext: input.resumeContext } : {}),
    ...(input.harnessSession ? { harnessSession: input.harnessSession } : {}),
    // Relaycast message coordinates, surfaced first-class so workforce's
    // RawGatewayEnvelope can map relaycast.message without digging through
    // `resource`. Emitted only when the trigger payload carries them (the
    // relay-native agent-gateway envelope-builder sets them top-level).
    ...(stringValue(payload.channel) ? { channel: stringValue(payload.channel) } : {}),
    ...(stringValue(payload.messageId) ? { messageId: stringValue(payload.messageId) } : {}),
    ...(stringValue(payload.threadId) ? { threadId: stringValue(payload.threadId) } : {}),
  };
}

function fullNameParts(fullName: string | null): { owner: string; repo: string } | null {
  if (!fullName) return null;
  const [owner, repo, ...rest] = fullName.split("/");
  if (!owner || !repo || rest.length > 0) return null;
  return { owner, repo };
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function githubPullRequestLocatorFromApiUrl(value: unknown): {
  owner: string;
  repo: string;
  number: number;
} | null {
  const raw = stringValue(value);
  if (!raw) return null;
  const match = raw.match(/\/repos\/([^/?#]+)\/([^/?#]+)\/pulls\/([1-9]\d*)(?:$|[/?#])/u);
  if (!match) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return {
    owner: decodePathSegment(match[1] ?? ""),
    repo: decodePathSegment(match[2] ?? ""),
    number,
  };
}

function githubPullRequestNumberFromPath(path: string): number | null {
  const match = path.match(/^\/github\/repos\/[^/]+\/[^/]+\/pulls\/([^/]+)/u);
  if (!match) return null;
  const raw = decodePathSegment(match[1] ?? "")
    .replace(/\.json$/u, "")
    .replace(/__.*$/u, "")
    .trim();
  if (!/^[1-9]\d*$/u.test(raw)) return null;
  const number = Number(raw);
  return Number.isSafeInteger(number) ? number : null;
}

function githubPullRequestLocatorFromEnvelope(envelope: Record<string, unknown>): {
  owner: string;
  repo: string;
  number: number;
} | null {
  const resource = isRecord(envelope.resource) ? envelope.resource : envelope;
  const links = isRecord(resource._links) ? resource._links : null;
  const linkPullRequest = isRecord(links?.pull_request) ? links.pull_request : null;
  const comment = isRecord(resource.comment) ? resource.comment : null;
  const fromUrl =
    githubPullRequestLocatorFromApiUrl(resource.pull_request_url) ??
    githubPullRequestLocatorFromApiUrl(linkPullRequest?.href) ??
    githubPullRequestLocatorFromApiUrl(comment?.pull_request_url);
  if (fromUrl) return fromUrl;

  const repository = isRecord(resource.repository) ? resource.repository : null;
  const repoParts =
    fullNameParts(stringValue(repository?.full_name)) ??
    fullNameParts(stringValue(resource.full_name));
  const paths = Array.isArray(envelope.paths)
    ? envelope.paths.filter((entry): entry is string => typeof entry === "string")
    : [];
  const number = paths.map(githubPullRequestNumberFromPath).find((entry): entry is number => entry !== null) ?? null;
  return repoParts && number ? { ...repoParts, number } : null;
}

function pullRequestWorkspaceFromApiResponse(
  pullRequest: Record<string, unknown>,
  fallback: { owner: string; repo: string; number: number },
): Omit<PullRequestWorkspaceConfig, "tokenEnvKey"> | null {
  const base = isRecord(pullRequest.base) ? pullRequest.base : null;
  const head = isRecord(pullRequest.head) ? pullRequest.head : null;
  const baseRepo = isRecord(base?.repo) ? base.repo : null;
  const headRepo = isRecord(head?.repo) ? head.repo : null;
  const repoParts = fullNameParts(stringValue(baseRepo?.full_name)) ?? {
    owner: fallback.owner,
    repo: fallback.repo,
  };
  const number = numberValue(pullRequest.number) ?? fallback.number;
  const baseSha = stringValue(base?.sha);
  const headSha = stringValue(head?.sha);
  const headRef = stringValue(head?.ref);
  const headRepoFullName = stringValue(headRepo?.full_name);
  if (!number || !baseSha || !headSha || !headRef || !headRepoFullName) {
    return null;
  }

  return {
    owner: repoParts.owner,
    repo: repoParts.repo,
    number,
    baseSha,
    headSha,
    headRef,
    headRepoFullName,
    canPush: headRepoFullName === `${repoParts.owner}/${repoParts.repo}` && isSafeGitBranchRefName(headRef),
    remoteUrl:
      stringValue(baseRepo?.clone_url) ??
      `https://github.com/${repoParts.owner}/${repoParts.repo}.git`,
  };
}

async function hydrateGithubPullRequestWorkspaceFromEnvelope(input: {
  envelope: Record<string, unknown>;
  workspaceId: string;
  userId: string;
}): Promise<Omit<PullRequestWorkspaceConfig, "tokenEnvKey"> | null> {
  const locator = githubPullRequestLocatorFromEnvelope(input.envelope);
  if (!locator) return null;
  let body: Record<string, unknown>;
  try {
    body = await readGithubProxyPullRequest({
      userId: input.userId,
      workspaceId: input.workspaceId,
      owner: locator.owner,
      repo: locator.repo,
      pullNumber: locator.number,
    });
  } catch (error) {
    if (error instanceof GithubProxyPullRequestError) {
      if (error.status === 404) {
        throw new DeploymentTriggerDeliveryError(
          "pr-reviewer pull_request event could not hydrate checkout because the PR was not found",
          "pr_reviewer_checkout_unavailable",
          404,
        );
      }
      if (error.code === "github_nango_proxy_unavailable") {
        throw new DeploymentTriggerDeliveryError(
          `pr-reviewer pull_request event could not hydrate checkout because the Nango GitHub proxy is unavailable: ${error.message}`,
          "pr_reviewer_nango_hydration_unavailable",
          error.status,
        );
      }
      if (error.status >= 500) {
        throw new DeploymentTriggerDeliveryError(
          `GitHub PR checkout hydration failed: ${error.message}`,
          "pr_reviewer_checkout_hydration_failed",
          error.status,
        );
      }
      if (error.status === 403) {
        throw new DeploymentTriggerDeliveryError(
          "pr-reviewer pull_request event could not hydrate checkout because GitHub denied PR read access",
          "pr_reviewer_checkout_unavailable",
          403,
        );
      }
      throw new DeploymentTriggerDeliveryError(
        `pr-reviewer pull_request event could not hydrate checkout from GitHub status ${error.status}`,
        "pr_reviewer_checkout_unavailable",
        error.status,
      );
    }
    throw new DeploymentTriggerDeliveryError(
      `GitHub PR checkout hydration failed: ${error instanceof Error ? error.message : String(error)}`,
      "pr_reviewer_checkout_hydration_failed",
      503,
    );
  }
  const workspace = pullRequestWorkspaceFromApiResponse(body, locator);
  if (!workspace) {
    throw new DeploymentTriggerDeliveryError(
      "GitHub PR checkout hydration returned incomplete repository/head/base data",
      "pr_reviewer_checkout_hydration_failed",
      502,
    );
  }
  return workspace;
}

export function githubPullRequestWorkspaceFromEnvelope(
  envelope: Record<string, unknown>,
): Omit<PullRequestWorkspaceConfig, "tokenEnvKey"> | null {
  if (!isPullRequestWorkspaceEvent(envelope)) {
    return null;
  }
  const resource = isRecord(envelope.resource) ? envelope.resource : envelope;
  const pullRequest = isRecord(resource.pull_request) ? resource.pull_request : resource;
  const base = isRecord(pullRequest.base) ? pullRequest.base : null;
  const baseRepo = isRecord(base?.repo) ? base.repo : null;
  const repository = isRecord(resource.repository) ? resource.repository : baseRepo;
  if (!repository || !pullRequest) return null;

  const repoFullName = stringValue(repository.full_name);
  const repoParts = fullNameParts(repoFullName);
  const head = isRecord(pullRequest.head) ? pullRequest.head : null;
  const headRepo = isRecord(head?.repo) ? head.repo : null;
  if (!repoParts || !head || !base) return null;

  const number = numberValue(pullRequest.number);
  const baseSha = stringValue(base.sha);
  const headSha = stringValue(head.sha);
  const headRef = stringValue(head.ref);
  const headRepoFullName = stringValue(headRepo?.full_name) ?? repoFullName;
  if (!number || !baseSha || !headSha || !headRef || !headRepoFullName) {
    return null;
  }

  return {
    owner: repoParts.owner,
    repo: repoParts.repo,
    number,
    baseSha,
    headSha,
    headRef,
    headRepoFullName,
    canPush: headRepoFullName === `${repoParts.owner}/${repoParts.repo}` && isSafeGitBranchRefName(headRef),
    remoteUrl:
      stringValue(repository.clone_url) ??
      `https://github.com/${repoParts.owner}/${repoParts.repo}.git`,
  };
}

export function isPullRequestWorkspaceEvent(envelope: Record<string, unknown>): boolean {
  const type = stringValue(envelope.type);
  if (
    type === "github.issue_comment.created" &&
    githubPullRequestLocatorFromEnvelope(envelope)
  ) {
    return true;
  }
  return type === "github.pull_request.opened" ||
    type === "github.pull_request.synchronize" ||
    type === "github.pull_request.reopened" ||
    type === "github.pull_request.closed" ||
    type === "github.pull_request_review.submitted" ||
    type === "github.pull_request_review_comment.created";
}

function isPullRequestClosedEvent(envelope: Record<string, unknown>): boolean {
  return stringValue(envelope.type) === "github.pull_request.closed";
}

function isConflictResolveDirectiveEnvelope(envelope: Record<string, unknown>): boolean {
  if (stringValue(envelope.type) !== "github.issue_comment.created") {
    return false;
  }
  const resource = isRecord(envelope.resource) ? envelope.resource : envelope;
  const issue = isRecord(resource.issue) ? resource.issue : null;
  if (!isRecord(issue?.pull_request)) {
    return false;
  }
  const comment = isRecord(resource.comment) ? resource.comment : null;
  return matchesConflictResolveDirective(comment?.body);
}

function triggerKindForPayload(payload: unknown): "inbox" | "clock" {
  if (isContinuationResumeEnabled() && isContinuationWakePayload(payload)) {
    return "clock";
  }
  const type = isRecord(payload)
    ? stringValue(payload.type) ?? stringValue(payload.eventType)
    : null;
  return !type || type === "cron.tick" || type.startsWith("cron.") ? "clock" : "inbox";
}

function isContinuationResumeEnabled(): boolean {
  return isProactiveContinuationResumeEnabled();
}

function isContinuationWakePayload(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false;
  }
  const type = stringValue(payload.type) ?? stringValue(payload.eventType);
  const continuationId = stringValue(payload.continuationId) ??
    stringValue(payload.continuation_id);
  return type === "continuation_wake" && Boolean(continuationId);
}

function continuationWakePayload(input: {
  payload: unknown;
}): { continuationId: string; trigger: ContinuationResumeTrigger } | null {
  if (!isRecord(input.payload)) {
    return null;
  }
  const type = stringValue(input.payload.type) ?? stringValue(input.payload.eventType);
  const continuationId = stringValue(input.payload.continuationId) ??
    stringValue(input.payload.continuation_id);
  if (type !== "continuation_wake" || !continuationId) {
    return null;
  }
  return {
    continuationId,
    trigger: {
      type: "scheduled_wake",
      wakeUpId: stringValue(input.payload.wakeUpId) ??
        stringValue(input.payload.wake_up_id) ??
        undefined,
      firedAt: stringValue(input.payload.firedAt) ??
        stringValue(input.payload.fired_at) ??
        stringValue(input.payload.occurredAt) ??
        stringValue(input.payload.occurred_at) ??
        new Date().toISOString(),
    },
  };
}

function userReplyTrigger(payload: unknown): ContinuationResumeTrigger | null {
  if (!isRecord(payload)) return null;
  const resource = isRecord(payload.resource) ? payload.resource : payload;
  const message = isRecord(resource.message) ? resource.message : null;
  const source = message ?? resource;
  const receivedAt = stringValue(source.receivedAt) ??
    stringValue(source.received_at) ??
    stringValue(payload.occurredAt) ??
    stringValue(payload.occurred_at) ??
    new Date().toISOString();
  const id = firstNonEmptyString(source.id, source.event_id, source.eventId, source.ts, payload.id, payload.eventId) ??
    `reply-${receivedAt}`;
  const text = firstNonEmptyString(source.text, source.body, resource.text, resource.body) ?? "";
  return {
    type: "user_reply",
    receivedAt,
    message: {
      id,
      text,
      receivedAt,
    },
  };
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    const resolved = stringValue(value);
    if (resolved) return resolved;
  }
  return null;
}

function isSafeGithubPathSegment(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/u.test(value) && !value.startsWith(".") && !value.endsWith(".");
}

function githubRepoFromRelayfilePath(path: string): { owner: string; repo: string } | null {
  const normalized = normalizeRelayfilePath(path);
  const match = normalized.match(/^\/github\/repos\/([^/*]+)\/([^/*]+)(?:\/|$)/u);
  if (!match?.[1] || !match[2]) return null;
  const owner = match[1];
  const repo = match[2];
  return isSafeGithubPathSegment(owner) && isSafeGithubPathSegment(repo)
    ? { owner, repo }
    : null;
}

function githubRepoFromEnvelope(envelope: Record<string, unknown>): {
  owner: string;
  repo: string;
  remoteUrl?: string;
  defaultBranch?: string;
} | null {
  const resource = isRecord(envelope.resource) ? envelope.resource : envelope;
  const repository = isRecord(resource.repository) ? resource.repository : null;
  const fullName =
    stringValue(repository?.full_name) ??
    stringValue(resource.full_name);
  const repoParts = fullNameParts(fullName);
  if (!repoParts) return null;
  if (!isSafeGithubPathSegment(repoParts.owner) || !isSafeGithubPathSegment(repoParts.repo)) {
    return null;
  }
  return {
    owner: repoParts.owner,
    repo: repoParts.repo,
    ...(stringValue(repository?.clone_url) ? { remoteUrl: stringValue(repository?.clone_url)! } : {}),
    ...(stringValue(repository?.default_branch) ? { defaultBranch: stringValue(repository?.default_branch)! } : {}),
  };
}

function gitWorkspaceTargetDir(input: { owner: string; repo: string }): string {
  return `${DEPLOYMENT_WORKSPACE_DIR}/github/repos/${input.owner}/${input.repo}`;
}

export function proactiveGitWorkspaceFromSources(input: {
  envelope: Record<string, unknown>;
  relayfilePaths: readonly string[];
}): Omit<ProactiveGitWorkspaceConfig, "tokenEnvKey" | "username"> | null {
  const candidates = new Map<string, { owner: string; repo: string }>();
  for (const path of input.relayfilePaths) {
    const repo = githubRepoFromRelayfilePath(path);
    if (repo) {
      candidates.set(`${repo.owner}/${repo.repo}`, repo);
    }
  }

  const envelopeRepo = githubRepoFromEnvelope(input.envelope);
  if (envelopeRepo) {
    candidates.set(`${envelopeRepo.owner}/${envelopeRepo.repo}`, envelopeRepo);
  }
  if (candidates.size !== 1) {
    return null;
  }
  const repo = [...candidates.values()][0];
  if (!repo) return null;
  const remoteUrl = normalizeHttpsGitRemote(
    envelopeRepo &&
      envelopeRepo.owner === repo.owner &&
      envelopeRepo.repo === repo.repo &&
      envelopeRepo.remoteUrl
      ? envelopeRepo.remoteUrl
      : `https://github.com/${repo.owner}/${repo.repo}.git`,
  );
  if (!remoteUrl) return null;
  const defaultBranch =
    envelopeRepo &&
      envelopeRepo.owner === repo.owner &&
      envelopeRepo.repo === repo.repo &&
      envelopeRepo.defaultBranch &&
      isSafeGitBranchRefName(envelopeRepo.defaultBranch)
      ? envelopeRepo.defaultBranch
      : undefined;
  return {
    owner: repo.owner,
    repo: repo.repo,
    remoteUrl,
    targetDir: gitWorkspaceTargetDir(repo),
    ...(defaultBranch ? { ref: defaultBranch } : {}),
  };
}

function isRepoSourceMountPath(path: string, source: Pick<ProactiveGitWorkspaceConfig, "owner" | "repo">): boolean {
  const normalized = normalizeRelayfilePath(path);
  const root = `/github/repos/${source.owner}/${source.repo}`;
  const base = stripTrailingGlob(normalized);
  return base === root ||
    base === `${root}/contents` ||
    base === `${root}/git`;
}

export function relayfileRuntimeMountPathsForGitWorkspace(input: {
  paths: readonly string[];
  gitWorkspace?: Pick<ProactiveGitWorkspaceConfig, "owner" | "repo"> | null;
}): string[] {
  if (!input.gitWorkspace) {
    return [...input.paths];
  }
  return input.paths.filter((path) => !isRepoSourceMountPath(path, input.gitWorkspace!));
}

function resumeContextForInput(input: ContinuationResumedTurnInput): DeploymentResumeContext {
  return {
    continuationId: input.continuation.id,
    resumedTurnId: input.resumedTurnId,
    triggerType: input.trigger.type,
    priorState: {
      status: input.continuation.status,
      originTurnId: input.continuation.origin.turnId,
      ...(input.continuation.sessionId ? { sessionId: input.continuation.sessionId } : {}),
      ...(input.continuation.threadId ? { threadId: input.continuation.threadId } : {}),
      ...(input.continuation.userId ? { userId: input.continuation.userId } : {}),
      waitFor: input.continuation.waitFor,
      resumeAttempts: input.continuation.bounds.resumeAttempts,
      continuation: input.continuation.continuation,
    },
  };
}

function completedContinuationHarnessResult(input: ContinuationResumedTurnInput): HarnessResult {
  return {
    outcome: "completed",
    stopReason: "answer_finalized",
    turnId: input.resumedTurnId,
    sessionId: input.continuation.sessionId ?? "session-unknown",
    assistantMessage: {
      text: "resumed",
    },
    traceSummary: {
      iterationCount: 1,
      toolCallCount: 0,
      hadContinuation: false,
      finalEventType: "turn_finished",
    },
    usage: {
      modelCalls: 0,
      toolCalls: 0,
    },
    metadata: {
      continuationId: input.continuation.id,
      triggerType: input.trigger.type,
    },
  };
}

async function resolveDeploymentSandbox(input: {
  runtime: DeploymentSandboxRuntime;
  workspaceId: string;
  agentId: string;
  leaseTtlSeconds: number;
}): Promise<RuntimeHandle | null> {
  const leasedSandboxIds = await activeDeploymentSandboxLeaseIds({
    agentId: input.agentId,
    ttlSeconds: input.leaseTtlSeconds,
  });
  const handles = await input.runtime.findAllByLabels(
    {
      purpose: "workforce-deploy",
      workspaceId: input.workspaceId,
      agentId: input.agentId,
    },
    { states: ["STARTED"], limit: 10 },
  );
  for (const handle of handles) {
    if (leasedSandboxIds.has(handle.id)) {
      continue;
    }
    if (isStartedDeploymentSandboxTooOldForReuse(handle, new Date())) {
      console.info("[deployment-sandbox-reuse] skipping old started sandbox", {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        sandboxId: handle.id,
        createdAt: handle.createdAt,
        maxReuseAgeDays: 7,
      });
      try {
        await input.runtime.destroy(handle);
      } catch (error) {
        console.warn("[deployment-sandbox-reuse] failed to destroy old started sandbox", {
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          sandboxId: handle.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }
    return handle;
  }
  return null;
}

function isStartedDeploymentSandboxTooOldForReuse(
  handle: Pick<RuntimeHandle, "createdAt">,
  now: Date,
): boolean {
  if (!handle.createdAt) {
    return false;
  }
  const createdAtMs = Date.parse(handle.createdAt);
  if (!Number.isFinite(createdAtMs)) {
    return false;
  }
  return now.getTime() - createdAtMs >= MAX_STARTED_DEPLOYMENT_SANDBOX_REUSE_AGE_MS;
}

async function activeDeploymentSandboxLeaseIds(input: {
  agentId: string;
  ttlSeconds: number;
}): Promise<Set<string>> {
  const result = await getDb().execute(sql`
    SELECT DISTINCT sandbox_id
    FROM (
      SELECT run_sandbox_id AS sandbox_id
      FROM integration_watch_deliveries
      WHERE agent_id = ${input.agentId}
        AND status IN ('running', 'processing')
        AND run_sandbox_id IS NOT NULL
        AND run_started_at >= NOW() - (${input.ttlSeconds} || ' seconds')::interval
      UNION ALL
      SELECT run_sandbox_id AS sandbox_id
      FROM deployment_tick_deliveries
      WHERE agent_id = ${input.agentId}
        AND status IN ('running', 'processing')
        AND run_sandbox_id IS NOT NULL
        AND run_started_at >= NOW() - (${input.ttlSeconds} || ' seconds')::interval
    ) active_leases
  `);
  return new Set(
    rowsOf<{ sandbox_id: string | null }>(result)
      .map((row) => row.sandbox_id)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );
}

async function isDeploymentSandboxLeased(input: {
  agentId: string;
  sandboxId: string;
  ttlSeconds: number;
}): Promise<boolean> {
  return (await activeDeploymentSandboxLeaseIds({
    agentId: input.agentId,
    ttlSeconds: input.ttlSeconds,
  })).has(input.sandboxId);
}

async function provisionOnDemandSandbox(input: {
  runtime: DeploymentSandboxRuntime;
  orchestrator: DeploymentSandboxOrchestrator;
  workspaceId: string;
  agentId: string;
  deployedName: string;
  deployedByUserId: string;
  personaSlug: string;
  deploymentId: string;
  bundleSha256: string;
  persona: Record<string, unknown>;
  agentSpec?: DeploymentAgentSpec | null;
  inputValues: Record<string, string>;
  credentialSelections: Record<string, string>;
  provisioningSandboxId?: string | null;
  sandboxName?: string | null;
  labels?: Record<string, string>;
  options?: DeploymentTriggerDeliveryOptions;
  // When set, do NOT block the Worker in-process waiting for the sandbox to
  // boot. Instead, the moment a freshly-created sandbox isn't started yet, throw
  // DeploymentSandboxProvisioningPendingError so the tick-delivery layer persists
  // its id (provisioning_sandbox_id) and re-drains in PENDING_RETRY_SECONDS; the
  // next invocation resumes THAT same sandbox. This frees the Worker while the
  // box boots AND guarantees a re-claim never spawns a second sandbox (the
  // duplicate-post window). Only the cold on-demand tick path passes this — the
  // warm-lease / exit-137 callers keep the in-process wait so their own sandbox
  // lease bookkeeping is unaffected.
  yieldWhileProvisioning?: boolean;
}): Promise<RuntimeHandle> {
  const { relayfilePaths, syncPaths } = relayfileMountPathsForPersona(input.persona, input.agentSpec);
  const relayWorkspaceId = await resolveRelayWorkspaceIdForDelivery({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    phase: "provision",
  });
  const workflowEnv = await workflowEnvVars({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
  });
  const providerEnv = await resolveSelectedProviderEnv({
    workspaceId: input.workspaceId,
    deployedByUserId: input.deployedByUserId,
    credentialSelections: input.credentialSelections,
    persona: input.persona,
  });
  const personaIntegrationEnv = await resolvePersonaIntegrationEnv({
    deployedByUserId: input.deployedByUserId,
    persona: input.persona,
    inputValues: input.inputValues,
  });
  const envVars: Record<string, string> = {
    WORKFORCE_AGENT_ID: input.agentId,
    WORKFORCE_WORKSPACE_ID: input.workspaceId,
    WORKFORCE_SANDBOX_ROOT: DEPLOYMENT_WORKSPACE_DIR,
    WORKFORCE_WORKSPACE_DIR: DEPLOYMENT_WORKSPACE_DIR,
    WORKFORCE_AGENT_CONTEXT: runtimeAgentContext({
      agentId: input.agentId,
      deployedName: input.deployedName,
      inputValues: input.inputValues,
    }),
    WORKFORCE_CREDENTIAL_SELECTIONS: JSON.stringify(input.credentialSelections),
    RELAY_AGENT_NAME: input.agentId,
    RELAY_DEFAULT_WORKSPACE: relayWorkspaceId,
    ...workflowEnv,
    ...providerEnv,
    ...personaIntegrationEnv,
  };

  // Mint a broad path-scoped relayfile token at sandbox creation time so the
  // `RELAYFILE_TOKEN` env var is available to the runner (the persona's
  // direct Relayfile clients read it via process.env). The relayfile-mount
  // daemon gets a separate, narrower per-fire token in
  // `deliverEnvelopeToSandbox`.
  const mount = await mintRelayfileMountConfig({
    workspaceId: relayWorkspaceId,
    agentId: input.agentId,
    relayfilePaths,
    syncPaths,
    mintDaemonToken: false,
  });
  if (mount) {
    envVars.RELAYFILE_TOKEN = mount.envToken ?? mount.token;
    envVars.RELAYFILE_MOUNT_PATHS = JSON.stringify(mount.mountPaths);
    envVars.RELAYFILE_URL = normalizeCredentialUrl(mount.baseUrl);
    envVars.RELAYFILE_WORKSPACE_ID = mount.workspaceId;
  }

  const sandboxName = input.sandboxName ?? buildPerFireSandboxName({
    personaSlug: input.personaSlug,
    deploymentId: input.deploymentId,
  });
  const labels = {
    purpose: "workforce-deploy",
    workspaceId: input.workspaceId,
    personaId: input.personaSlug,
    agentId: input.agentId,
    deploymentId: input.deploymentId,
    ...(input.labels ?? {}),
    sandboxName,
  };
  const launchOptions = {
    name: sandboxName,
    env: envVars,
    labels,
    createTimeoutSeconds: input.options?.sandboxCreateTimeoutSeconds ?? 120,
  };
  const launchSandbox = async (): Promise<RuntimeHandle> => {
    if (input.runtime.launchDetached) {
      return input.runtime.launchDetached(launchOptions);
    }
    return input.orchestrator.provision(launchOptions);
  };
  let handle: RuntimeHandle;
  if (input.provisioningSandboxId) {
    // Resuming a sandbox a prior tick already created. In yield mode, do a single
    // readiness check (resolveProvisioningSandbox throws ProvisioningPendingError
    // when it isn't started yet) and let the tick layer reschedule, rather than
    // holding the Worker in the in-process wait loop.
    handle = input.yieldWhileProvisioning
      ? await resolveProvisioningSandbox({
          runtime: input.runtime,
          sandboxId: input.provisioningSandboxId,
        })
      : await waitForProvisioningSandboxStarted({
          runtime: input.runtime,
          sandboxId: input.provisioningSandboxId,
          timeoutMs: resolveSandboxProvisionWaitTimeoutMs(input.options),
          pollIntervalMs: input.options?.sandboxProvisionPollIntervalMs,
        });
  } else {
    try {
      handle = await launchSandbox();
    } catch (error) {
      if (!isDaytonaSandboxNameConflict(error)) {
        throw error;
      }
      const existing = await findSameNamedDeploymentSandbox({
        runtime: input.runtime,
        labels,
      });
      if (!existing) {
        throw error;
      }
      if (isTerminalSandboxState(existing.state)) {
        await input.runtime.destroy(existing);
        handle = await launchSandbox();
      } else {
        handle = existing;
      }
    }
    if (!isSandboxStarted(handle)) {
      if (input.yieldWhileProvisioning) {
        // The sandbox is created (id is live) but still booting. Yield NOW so the
        // tick layer records provisioning_sandbox_id and the next drain resumes
        // this exact sandbox via the branch above — never a fresh second one.
        throw new DeploymentSandboxProvisioningPendingError(handle.id, handle.state);
      }
      handle = await waitForProvisioningSandboxStarted({
        runtime: input.runtime,
        sandboxId: handle.id,
        timeoutMs: resolveSandboxProvisionWaitTimeoutMs(input.options),
        pollIntervalMs: input.options?.sandboxProvisionPollIntervalMs,
        initialState: handle.state,
      });
    }
  }

  await uploadDeploymentBundleToSandbox({
    orchestrator: input.orchestrator,
    handle,
    bundleSha256: input.bundleSha256,
    persona: input.persona,
  });
  return handle;
}

async function findSameNamedDeploymentSandbox(input: {
  runtime: DeploymentSandboxRuntime;
  labels: Record<string, string>;
}): Promise<RuntimeHandle | null> {
  const handles = await input.runtime.findAllByLabels(input.labels, {
    states: null,
    limit: 5,
    owned: true,
  });
  return handles[0] ?? null;
}

async function uploadDeploymentBundleToSandbox(input: {
  orchestrator: DeploymentSandboxOrchestrator;
  handle: RuntimeHandle;
  bundleSha256: string;
  persona: Record<string, unknown>;
}): Promise<void> {
  const bundle = await loadBundle(input.bundleSha256);
  const persona = deploymentPersonaSpec(input.persona) ?? input.persona;
  await input.orchestrator.uploadBundle(input.handle, [
    { source: Buffer.from(bundle.runner, "utf8"), destination: `${DEPLOYMENT_RUNTIME_DIR}/runner.mjs` },
    { source: Buffer.from(bundle.agent, "utf8"), destination: `${DEPLOYMENT_RUNTIME_DIR}/agent.bundle.mjs` },
    {
      source: Buffer.from(JSON.stringify(persona, null, 2), "utf8"),
      destination: `${DEPLOYMENT_RUNTIME_DIR}/persona.json`,
    },
    {
      source: Buffer.from(JSON.stringify(bundle.packageJson, null, 2), "utf8"),
      destination: `${DEPLOYMENT_RUNTIME_DIR}/package.json`,
    },
  ]);
}

function resolveSandboxProvisionWaitTimeoutMs(
  options?: DeploymentTriggerDeliveryOptions,
): number {
  const createTimeoutMs = (options?.sandboxCreateTimeoutSeconds ?? 120) * 1000;
  return Math.max(
    0,
    Math.min(
      createTimeoutMs,
      options?.sandboxProvisionWaitTimeoutMs ?? DEFAULT_SANDBOX_PROVISION_WAIT_TIMEOUT_MS,
    ),
  );
}

async function waitForProvisioningSandboxStarted(input: {
  runtime: DeploymentSandboxRuntime;
  sandboxId: string;
  timeoutMs: number;
  pollIntervalMs?: number;
  initialState?: string | null;
}): Promise<RuntimeHandle> {
  const pollIntervalMs = Math.max(
    100,
    input.pollIntervalMs ?? DEFAULT_SANDBOX_PROVISION_POLL_INTERVAL_MS,
  );
  const deadline = Date.now() + Math.max(0, input.timeoutMs);
  let lastPending = new DeploymentSandboxProvisioningPendingError(input.sandboxId, input.initialState);
  while (Date.now() <= deadline) {
    try {
      return await resolveProvisioningSandbox({
        runtime: input.runtime,
        sandboxId: input.sandboxId,
      });
    } catch (error) {
      if (!(error instanceof DeploymentSandboxProvisioningPendingError)) {
        throw error;
      }
      lastPending = error;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)));
    }
  }
  throw lastPending;
}

async function resolveProvisioningSandbox(input: {
  runtime: DeploymentSandboxRuntime;
  sandboxId: string;
}): Promise<RuntimeHandle> {
  if (!input.runtime.getById) {
    throw new DeploymentSandboxProvisioningPendingError(input.sandboxId);
  }
  const handle = await input.runtime.getById(input.sandboxId, {
    states: null,
    owned: true,
  });
  if (!handle) {
    throw new DeploymentSandboxProvisioningTerminalError(input.sandboxId, "missing");
  }
  if (isSandboxStarted(handle)) {
    return handle;
  }
  if (isTerminalSandboxState(handle.state)) {
    await input.runtime.destroy(handle).catch(() => undefined);
    throw new DeploymentSandboxProvisioningTerminalError(handle.id, handle.state);
  }
  throw new DeploymentSandboxProvisioningPendingError(handle.id, handle.state);
}

function isSandboxStarted(handle: RuntimeHandle): boolean {
  const state = normalizeSandboxState(handle.state);
  return state === "STARTED" || state === "RUNNING";
}

function isTerminalSandboxState(value: string | null | undefined): boolean {
  const state = normalizeSandboxState(value);
  return Boolean(state && [
    "ARCHIVED",
    "BUILD_FAILED",
    "DESTROYED",
    "ERROR",
    "STOPPED",
  ].includes(state));
}

function normalizeSandboxState(value: string | null | undefined): string | null {
  return value?.trim().replace(/-/g, "_").toUpperCase() || null;
}

async function markDeploymentFailed(deploymentId: string): Promise<void> {
  await getDb().execute(sql`
    UPDATE agent_deployments
    SET status = 'failed',
        updated_at = NOW()
    WHERE id = ${deploymentId}
  `);
}

export async function markAgentDispatchResult(input: {
  agentId: string;
  error: string | null;
}): Promise<void> {
  if (input.error) {
    await getDb().execute(sql`
      UPDATE agents
      SET last_error = ${input.error},
          updated_at = NOW()
      WHERE id = ${input.agentId}
    `);
    return;
  }

  await getDb().execute(sql`
    UPDATE agents
    SET last_used_at = NOW(),
        last_error = NULL,
        updated_at = NOW()
    WHERE id = ${input.agentId}
  `);
}

type AgentDeploymentRunCleanupStatus = {
  mountConfigured: boolean;
  scriptCompleted: boolean;
  flushExitCode: number | null;
  killAttempted: boolean | null;
  killExitCode: number | null;
  logTailCaptured: boolean;
  /**
   * Canonical undelivered-writeback count from `<mount>/.relay/state.json` at
   * teardown (cloud#2029). `null` when the mount emitted no count (old mount /
   * unparsable). NOT inferred from a sync `revision`.
   */
  pendingWriteback: number | null;
  /**
   * Unified `states.hasPendingWriteback` flag (cloud#2029 #1). True for LOCAL
   * pending (v0.8.19+) AND durable-outbox pending (post-#264) — subsumes the
   * nested `outbox.pending` count. `null`/false on mounts that omit it.
   */
  hasPendingWriteback: boolean | null;
  /**
   * `states.outboxNeedsAttention` — durable outbox retry budget exhausted
   * (post-#264; `omitempty`, so `null`/false on pre-#264 mounts). cloud#2029 #1.
   */
  outboxNeedsAttention: boolean | null;
  /**
   * Whether THIS run wrote a draft under a configured writeback command root.
   * Combined with the pending signals this is the loud-fail conjunction.
   */
  commandDraftWrittenThisRun: boolean | null;
  /**
   * cloud#2029 #1b: count of THIS-run command drafts with NO positive
   * adapter-dispatch receipt — failed/dead-lettered, never-uploaded (no opId),
   * or never-enqueued (no outbox record). `null` = not computed (pre-receipt
   * mount, node absent, or the unscoped-localDir precondition was violated), in
   * which case the gate feature-detects and falls back to the pending signals.
   * A number is the positive-receipt undeliverable count. Benign in-flight
   * (opId committed, running/pending/queued) is NOT counted — the server owns
   * delivery past teardown.
   */
  commandDraftsUndeliverable: number | null;
};

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return "";
}

function truncateText(value: string, maxLength: number): { text: string; truncated: boolean } {
  if (value.length <= maxLength) {
    return { text: value, truncated: false };
  }
  return { text: value.slice(0, maxLength), truncated: true };
}

function errorMessage(error: unknown): string | null {
  if (!error) {
    return null;
  }
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = (error as Error & { cause?: unknown }).cause;
  if (!cause) {
    return error.message;
  }
  const causeMessage = errorMessage(cause);
  if (!causeMessage || causeMessage === error.message) {
    return error.message;
  }
  return `${error.message}: ${causeMessage}`;
}

function isRelayfileNotFound(error: unknown): boolean {
  return isRecord(error) && error.status === 404;
}

function isRelayfileRevisionConflict(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  const status = Number(error.status ?? error.statusCode);
  if (status === 409 || status === 412) {
    return true;
  }
  const code = typeof error.code === "string" ? error.code.toLowerCase() : "";
  const name = typeof error.name === "string" ? error.name.toLowerCase() : "";
  const message = typeof error.message === "string" ? error.message.toLowerCase() : "";
  return code.includes("revision") ||
    code.includes("conflict") ||
    name.includes("revision") ||
    name.includes("conflict") ||
    message.includes("revision") ||
    message.includes("conflict");
}

function workspaceLogRoot(relayWorkspaceId: string): string {
  return `/_logs/${encodeURIComponent(relayWorkspaceId)}`;
}

function workspaceLogPath(relayWorkspaceId: string, timestamp: string): string {
  const parsed = new Date(timestamp);
  const date = Number.isNaN(parsed.getTime())
    ? new Date().toISOString().slice(0, 10)
    : parsed.toISOString().slice(0, 10);
  return `${workspaceLogRoot(relayWorkspaceId)}/${date}.jsonl`;
}

function deploymentRunTerminalErrorFromOutput(input: {
  output: string;
  relayWorkspaceId: string;
  agentId: string;
  deploymentId: string;
  eventSource: string;
  sandboxId?: string | null;
  sessionId?: string | null;
  commandId?: string | null;
}): Error | null {
  for (const entry of deploymentRunnerStructuredLogEntries(input)) {
    if (entry.msg !== "runner.handler.error") {
      continue;
    }
    const message = stringValue(entry.error) ?? stringValue(entry.stack) ?? entry.msg;
    return new Error(message);
  }
  return null;
}

function deploymentRunOutputHasHandlerOk(input: {
  output: string;
  relayWorkspaceId: string;
  agentId: string;
  deploymentId: string;
  eventSource: string;
  sandboxId?: string | null;
  sessionId?: string | null;
  commandId?: string | null;
}): boolean {
  return deploymentRunnerStructuredLogEntries(input).some((entry) => entry.msg === "runner.handler.ok");
}

function deploymentRunOutputHasHandlerError(input: {
  output: string;
  relayWorkspaceId: string;
  agentId: string;
  deploymentId: string;
  eventSource: string;
  sandboxId?: string | null;
  sessionId?: string | null;
  commandId?: string | null;
}): boolean {
  return deploymentRunnerStructuredLogEntries(input).some((entry) => entry.msg === "runner.handler.error");
}

function isCleanupOnlySuccessfulHandlerExit(input: {
  exitCode: number | null | undefined;
  output: string;
  cleanupStatus: AgentDeploymentRunCleanupStatus;
  relayWorkspaceId: string;
  agentId: string;
  deploymentId: string;
  eventSource: string;
  sandboxId?: string | null;
  sessionId?: string | null;
  commandId?: string | null;
}): boolean {
  if (input.exitCode == null || input.exitCode === 0) {
    return false;
  }
  if (!input.cleanupStatus.mountConfigured) {
    return false;
  }
  const cleanupNonZero =
    (input.cleanupStatus.flushExitCode !== null && input.cleanupStatus.flushExitCode !== 0) ||
    (input.cleanupStatus.killExitCode !== null && input.cleanupStatus.killExitCode !== 0);
  if (!input.cleanupStatus.scriptCompleted || !cleanupNonZero) {
    return false;
  }
  if (!deploymentRunOutputHasHandlerOk(input)) {
    return false;
  }
  if (deploymentRunOutputHasHandlerError(input)) {
    return false;
  }
  const pendingWriteback = input.cleanupStatus.pendingWriteback ?? 0;
  return (
    pendingWriteback === 0 &&
    input.cleanupStatus.hasPendingWriteback !== true &&
    input.cleanupStatus.outboxNeedsAttention !== true &&
    (input.cleanupStatus.commandDraftsUndeliverable ?? 0) === 0
  );
}

function logCleanupNonzeroButComplete(input: {
  workspaceId: string;
  agentId: string;
  deploymentId: string;
  deliveryId?: string;
  commandId?: string | null;
  flushExitCode: number | null;
  killExitCode: number | null;
  phase: "poll" | "sync";
}): void {
  console.info("[delivery.cleanup_nonzero_but_complete]", {
    area: "integration-watch-delivery",
    diag: "delivery.cleanup_nonzero_but_complete",
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    deploymentId: input.deploymentId,
    ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
    commandId: input.commandId ?? null,
    flushExitCode: input.flushExitCode,
    killExitCode: input.killExitCode,
    phase: input.phase,
  });
}

async function appendDeploymentRunStructuredLogsToRelayfile(input: {
  relayWorkspaceId: string;
  agentId: string;
  deploymentId: string;
  eventSource: string;
  sandboxId?: string | null;
  sessionId?: string | null;
  commandId?: string | null;
  output: string;
}): Promise<void> {
  const entries = deploymentRunnerStructuredLogEntries(input);
  if (entries.length === 0) {
    return;
  }
  const relayfile = resolveRelayfileConfig();
  const token = await mintPathScopedRelayfileTokenWithWorkspaceCache({
    workspaceId: input.relayWorkspaceId,
    relayAuthUrl: relayfile.relayAuthUrl,
    paths: [`${workspaceLogRoot(input.relayWorkspaceId)}/**`],
    ttlSeconds: STRUCTURED_RUNNER_LOG_WRITE_TTL_SECONDS,
    agentName: input.agentId,
    agentId: input.agentId,
  });
  const client = new RelayFileClient({
    baseUrl: relayfile.relayfileUrl,
    token,
  });
  const grouped = new Map<string, DeploymentRunnerStructuredLogEntry[]>();
  for (const entry of entries) {
    const path = workspaceLogPath(input.relayWorkspaceId, entry.ts);
    grouped.set(path, [...(grouped.get(path) ?? []), entry]);
  }

  for (const [path, pathEntries] of grouped) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let existingContent = "";
      let baseRevision = "*";
      try {
        const file = await client.readFile(input.relayWorkspaceId, path);
        if (typeof file.content === "string") {
          existingContent = file.content;
        }
        if (typeof file.revision === "string" && file.revision.trim()) {
          baseRevision = file.revision;
        }
      } catch (error) {
        if (!isRelayfileNotFound(error)) {
          throw error;
        }
        // Missing log files are expected on first write. Other Relayfile read
        // failures bubble to the outer best-effort handler so we do not risk
        // overwriting an existing log file with a stale base revision.
      }
      const separator = existingContent && !existingContent.endsWith("\n") ? "\n" : "";
      try {
        await client.writeFile({
          workspaceId: input.relayWorkspaceId,
          path,
          baseRevision,
          content: `${existingContent}${separator}${pathEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
          contentType: "application/x-ndjson",
          encoding: "utf-8",
        });
        break;
      } catch (error) {
        if (attempt >= 3 || !isRelayfileRevisionConflict(error)) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 75)));
      }
    }
  }
}

async function appendDeploymentRunStructuredLogsBestEffort(input: {
  workspaceId: string;
  agentId: string;
  deploymentId: string;
  eventSource: string;
  sandboxId?: string | null;
  sessionId?: string | null;
  commandId?: string | null;
  output: string;
}): Promise<void> {
  if (!input.output.trim()) {
    return;
  }
  // This persists the captured Daytona output when the delivery poll reaches a
  // terminal branch. A sandbox hard-reaped before any successful poll can still
  // lose its local /tmp run-tick file.
  try {
    const relayWorkspaceId = await resolveRelayWorkspaceIdForDelivery({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      phase: "deliver",
    });
    await appendDeploymentRunStructuredLogsToRelayfile({
      relayWorkspaceId,
      agentId: input.agentId,
      deploymentId: input.deploymentId,
      eventSource: input.eventSource,
      sandboxId: input.sandboxId,
      sessionId: input.sessionId,
      commandId: input.commandId,
      output: input.output,
    });
  } catch (error) {
    console.warn("[persona-bundle-deploy] failed to persist structured runner logs", {
      agentId: input.agentId,
      deploymentId: input.deploymentId,
      error: errorMessage(error),
    });
  }
}

function extractMountLogTail(text: string): string {
  const start = text.lastIndexOf(MOUNT_LOG_TAIL_START);
  if (start < 0) {
    return "";
  }
  const afterStart = start + MOUNT_LOG_TAIL_START.length;
  const end = text.indexOf(MOUNT_LOG_TAIL_END, afterStart);
  const raw = end >= 0 ? text.slice(afterStart, end) : text.slice(afterStart);
  return raw.replace(/^\r?\n/u, "").replace(/\r?\n$/u, "");
}

function stripMountDiagnostics(text: string): string {
  if (!text) {
    return "";
  }
  const withoutTailBlocks = text
    .replace(
      new RegExp(
        `${MOUNT_LOG_TAIL_START.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}[\\s\\S]*?` +
          `${MOUNT_LOG_TAIL_END.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\r?\\n?`,
        "gu",
      ),
      "",
    );
  return withoutTailBlocks
    .split(/\r?\n/u)
    .filter((line) => !line.includes(MOUNT_CLEANUP_MESSAGE))
    .join("\n")
    .replace(/\r?\n$/u, "");
}

function numberFrom(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanFrom(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function parseMountCleanupStatus(
  text: string,
  mountConfigured: boolean,
  mountLogTail: string,
  scriptRan: boolean,
): AgentDeploymentRunCleanupStatus {
  const base: AgentDeploymentRunCleanupStatus = {
    mountConfigured,
    scriptCompleted: false,
    flushExitCode: null,
    killAttempted: null,
    killExitCode: null,
    logTailCaptured: mountLogTail.length > 0,
    pendingWriteback: null,
    hasPendingWriteback: null,
    outboxNeedsAttention: null,
    commandDraftWrittenThisRun: null,
    commandDraftsUndeliverable: null,
  };
  if (!mountConfigured) {
    return { ...base, scriptCompleted: scriptRan };
  }

  for (const line of text.split(/\r?\n/u)) {
    if (!line.includes(MOUNT_CLEANUP_MESSAGE)) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as {
        message?: unknown;
        flushExitCode?: unknown;
        killAttempted?: unknown;
        killExitCode?: unknown;
        pendingWriteback?: unknown;
        hasPendingWriteback?: unknown;
        outboxNeedsAttention?: unknown;
        commandDraftWrittenThisRun?: unknown;
        commandDraftsUndeliverable?: unknown;
      };
      if (parsed.message !== MOUNT_CLEANUP_MESSAGE) {
        continue;
      }
      return {
        mountConfigured: true,
        scriptCompleted: true,
        flushExitCode: numberFrom(parsed.flushExitCode),
        killAttempted: booleanFrom(parsed.killAttempted),
        killExitCode: numberFrom(parsed.killExitCode),
        logTailCaptured: mountLogTail.length > 0,
        pendingWriteback: numberFrom(parsed.pendingWriteback),
        hasPendingWriteback: booleanFrom(parsed.hasPendingWriteback),
        outboxNeedsAttention: booleanFrom(parsed.outboxNeedsAttention),
        commandDraftWrittenThisRun: booleanFrom(parsed.commandDraftWrittenThisRun),
        commandDraftsUndeliverable: numberFrom(parsed.commandDraftsUndeliverable),
      };
    } catch {
      // Ignore unrelated/partial JSON emitted by the runner.
    }
  }
  return base;
}

function eventSourceForPayload(payload: unknown): string {
  if (!isRecord(payload)) {
    return "unknown";
  }
  const provider = stringValue(payload.provider);
  const eventType = stringValue(payload.eventType) ?? stringValue(payload.type);
  const scheduleId = stringValue(payload.scheduleId);
  const scheduleName = stringValue(payload.scheduleName) ?? stringValue(payload.name);
  const deliveryId = stringValue(payload.deliveryId);
  if (scheduleId || scheduleName || eventType?.startsWith("cron.")) {
    return ["cron", scheduleName, scheduleId].filter(Boolean).join(":");
  }
  if (provider || eventType) {
    return [provider ?? "webhook", eventType, deliveryId].filter(Boolean).join(":");
  }
  return "unknown";
}

/**
 * Post a conflict-autofix outcome comment via the github-relay proxy. Best
 * effort: the rebase outcome is authoritative and already recorded as the run
 * result, so a failed comment is a warn, never a delivery failure.
 */
async function postConflictAutofixComment(input: {
  deployedByUserId: string;
  workspaceId: string;
  owner: string;
  repo: string;
  number: number;
  body: string;
}): Promise<void> {
  try {
    await createGithubProxyIssueComment({
      userId: input.deployedByUserId,
      workspaceId: input.workspaceId,
      owner: input.owner,
      repo: input.repo,
      issueNumber: input.number,
      body: input.body,
    });
  } catch (error) {
    console.warn("[conflict-autofix] failed to post outcome comment (non-fatal)", {
      area: "conflict-autofix-delivery",
      repo: `${input.owner}/${input.repo}`,
      pullRequest: input.number,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Envelope capture is ALL-OR-NOTHING (cloud#1841): unlike stdout/stderr's
 * truncate-and-flag, a TRUNCATED envelope is strictly worse than an absent
 * one — the whole point of persisting it is byte-exact
 * `workforce invoke --fixture` replay, and truncated JSON replays wrong (or
 * not at all). Oversized envelopes are therefore omitted entirely with
 * `omitted: true`.
 */
export function envelopeCaptureForStorage(envelopeJson: string | null): {
  envelope: string | null;
  omitted: boolean;
} {
  if (typeof envelopeJson !== "string" || envelopeJson.length === 0) {
    return { envelope: null, omitted: false };
  }
  if (envelopeJson.length > RUN_OUTPUT_MAX_CHARS) {
    return { envelope: null, omitted: true };
  }
  return { envelope: envelopeJson, omitted: false };
}

type DeploymentRunOutputStreams = {
  output: string;
  stdout: string;
  stderr: string;
  combined: string;
};

function deploymentRunOutputStreams(
  result: SandboxCapturedOutput | null,
  error: unknown,
): DeploymentRunOutputStreams {
  const streams = result as (SandboxCapturedOutput & {
    stdout?: unknown;
    stderr?: unknown;
  }) | null;
  const output = firstString(result?.output);
  const stdout = firstString(streams?.stdout);
  const stderr = firstString(streams?.stderr);
  const combined = deploymentRunOutputFromLogs({ output, stdout, stderr });
  if (combined || result !== null) {
    return { output, stdout, stderr, combined };
  }

  const message = errorMessage(error);
  const diagnostic = message
    ? `[deployment-trigger] failed before sandbox output was captured: ${message}`
    : "[deployment-trigger] failed before sandbox output was captured with no error detail";
  const redacted = redactRunOutputForDiagnostics(diagnostic);
  return {
    output: redacted,
    stdout: redacted,
    stderr: "",
    combined: redacted,
  };
}

async function recordAgentDeploymentRun(input: {
  deploymentId: string;
  agentId: string;
  eventSource: string;
  handle: RuntimeHandle | null;
  sandboxName: string | null;
  mountConfigured: boolean;
  startedAt: Date;
  endedAt: Date;
  result: SandboxCapturedOutput | null;
  error: unknown;
  /** Byte-exact envelope JSON delivered to runner.mjs (cloud#1841). */
  envelopeJson?: string | null;
}): Promise<void> {
  const streams = deploymentRunOutputStreams(input.result, input.error);
  const diagnosticText = streams.combined;
  const mountLogTail = extractMountLogTail(diagnosticText);
  const cleanupStatus = parseMountCleanupStatus(
    diagnosticText,
    input.mountConfigured,
    mountLogTail,
    input.result !== null,
  );
  const stdout = stripMountDiagnostics(firstString(streams.stdout, streams.output, streams.combined));
  const stderr = stripMountDiagnostics(streams.stderr);
  const boundedStdout = truncateText(stdout, RUN_OUTPUT_MAX_CHARS);
  const boundedStderr = truncateText(stderr, RUN_OUTPUT_MAX_CHARS);
  const durationMs = Math.max(0, input.endedAt.getTime() - input.startedAt.getTime());
  // cloud#2029: a dropped writeback must record as failed even when the teardown
  // exit code was rescued to 0. Belt-and-suspenders vs the runError fold at the
  // call sites — no recordRun path may persist "succeeded" for an undelivered
  // command draft.
  const writebackUndelivered = cleanupIndicatesWritebackUndelivered(cleanupStatus);
  const inputErrorMessage = errorMessage(input.error)?.trim() ?? "";
  const error =
    inputErrorMessage ||
    (writebackUndelivered
      ? WRITEBACK_UNDELIVERED_ERROR_MESSAGE
      : input.result?.exitCode === 0
        ? null
        : "deployment run failed without a recorded error");
  const status =
    !input.error && input.result?.exitCode === 0 && !writebackUndelivered
      ? "succeeded"
      : "failed";
  const { envelope: envelopeToStore, omitted: envelopeOmitted } =
    envelopeCaptureForStorage(input.envelopeJson ?? null);

  await getDb().execute(sql`
    INSERT INTO agent_deployment_runs (
      deployment_id,
      agent_id,
      event_source,
      sandbox_id,
      sandbox_name,
      stdout,
      stdout_truncated,
      stderr,
      stderr_truncated,
      mount_log_tail,
      envelope,
      envelope_omitted,
      exit_code,
      cleanup_status,
      started_at,
      ended_at,
      duration_ms,
      status,
      error,
      updated_at
    )
    VALUES (
      ${input.deploymentId},
      ${input.agentId},
      ${input.eventSource},
      ${input.handle?.id ?? null},
      ${input.sandboxName},
      ${boundedStdout.text},
      ${boundedStdout.truncated},
      ${boundedStderr.text},
      ${boundedStderr.truncated},
      ${mountLogTail},
      ${envelopeToStore},
      ${envelopeOmitted},
      ${input.result?.exitCode ?? null},
      ${JSON.stringify(cleanupStatus)}::jsonb,
      ${input.startedAt.toISOString()}::timestamp with time zone,
      ${input.endedAt.toISOString()}::timestamp with time zone,
      ${durationMs},
      ${status},
      ${error ? truncateText(error, 10_000).text : null},
      NOW()
    )
  `);
}

function deploymentRunOutputFromLogs(logs: {
  output?: string;
  stdout?: string;
  stderr?: string;
}): string {
  const clean = [logs.stdout, logs.stderr]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
  return clean || logs.output || "";
}

function harnessExit137OutputTail(result: SandboxCapturedOutput | null): string {
  if (!result) {
    return "";
  }
  const streams = result as SandboxCapturedOutput & {
    stdout?: unknown;
    stderr?: unknown;
  };
  const output = deploymentRunOutputFromLogs({
    output: result.output,
    stdout: typeof streams.stdout === "string" ? streams.stdout : undefined,
    stderr: typeof streams.stderr === "string" ? streams.stderr : undefined,
  });
  return personaRunOutputTailForDiagnostics(output);
}

function isHarnessExit137(result: SandboxCapturedOutput | null): boolean {
  return result?.exitCode === HARNESS_EXIT_137_RETRY_EXIT_CODE;
}

function harnessExit137Error(input: {
  agentName: string;
  deploymentId: string;
  sandboxId: string;
  sandboxName?: string | null;
  sessionId: string;
  commandId?: string | null;
  result: SandboxCapturedOutput | null;
}): HarnessExit137Error {
  return new HarnessExit137Error({
    agentName: input.agentName,
    deploymentId: input.deploymentId,
    sandboxId: input.sandboxId,
    sandboxName: input.sandboxName,
    sessionId: input.sessionId,
    commandId: input.commandId,
    outputTail: harnessExit137OutputTail(input.result),
  });
}

function logHarnessExit137(input: {
  workspaceId: string;
  agentId: string;
  agentName: string;
  deploymentId: string;
  sandboxId: string;
  sandboxName?: string | null;
  sessionId: string;
  commandId?: string | null;
  result: SandboxCapturedOutput | null;
  retrying: boolean;
  attempt: number;
}): void {
  const streams = input.result as (SandboxCapturedOutput & {
    stdout?: unknown;
    stderr?: unknown;
  }) | null;
  console.warn("[harness] exited with code 137", {
    area: "harness-exit-137",
    diag: "harness-exit-137",
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    agentName: input.agentName,
    deploymentId: input.deploymentId,
    sandboxId: input.sandboxId,
    sandboxName: input.sandboxName ?? null,
    sessionId: input.sessionId,
    commandId: input.commandId ?? null,
    attempt: input.attempt,
    retrying: input.retrying,
    stdoutBytes: typeof streams?.stdout === "string" ? streams.stdout.length : 0,
    stderrBytes: typeof streams?.stderr === "string" ? streams.stderr.length : 0,
    outputFieldBytes: typeof input.result?.output === "string" ? input.result.output.length : 0,
    outputTail: harnessExit137OutputTail(input.result),
  });
}

async function destroyExit137SandboxBestEffort(input: {
  runtime: DeploymentSandboxRuntime;
  handle: RuntimeHandle | null;
  workspaceId: string;
  agentId: string;
  deploymentId: string;
}): Promise<void> {
  if (!input.handle) {
    return;
  }
  try {
    await input.runtime.destroy(input.handle);
  } catch (error) {
    console.warn("[harness] failed to destroy exit-137 sandbox before retry", {
      area: "harness-exit-137",
      diag: "harness-exit-137",
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      deploymentId: input.deploymentId,
      sandboxId: input.handle.id,
      error: errorMessage(error),
    });
  }
}

async function releaseExit137WarmLeaseBestEffort(input: {
  runtime: DeploymentSandboxRuntime;
  workspaceId: string;
  agentId: string;
  deploymentId: string;
  repoFullName: string;
  prNumber: number;
}): Promise<void> {
  try {
    const release = await releasePrSandboxSlot({
      runtime: input.runtime,
      key: {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        repoFullName: input.repoFullName,
        prNumber: input.prNumber,
      },
    });
    console.info("[harness] released warm sandbox lease after exit-137 retry handoff", {
      area: "harness-exit-137",
      diag: "harness-exit-137",
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      deploymentId: input.deploymentId,
      repoFullName: input.repoFullName,
      prNumber: input.prNumber,
      released: release.released,
      destroyed: release.destroyed,
      skippedActiveRun: release.skippedActiveRun,
      sandboxId: release.sandboxId,
    });
  } catch (error) {
    console.warn("[harness] failed to release warm sandbox lease after exit-137 retry handoff", {
      area: "harness-exit-137",
      diag: "harness-exit-137",
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      deploymentId: input.deploymentId,
      repoFullName: input.repoFullName,
      prNumber: input.prNumber,
      error: errorMessage(error),
    });
  }
}

async function markConversationWarmLeaseAvailableBestEffort(input: {
  workspaceId: string;
  agentId: string;
  deploymentId: string;
  conversationKey: string | null;
}): Promise<void> {
  if (!input.conversationKey) return;
  try {
    await markConversationSandboxLeaseAvailable({
      key: {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        deploymentId: input.deploymentId,
        conversationKey: input.conversationKey,
      },
    });
  } catch (error) {
    console.warn("[conversation-sandbox-lease] failed to mark warm lease available", {
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      deploymentId: input.deploymentId,
      conversationKey: input.conversationKey,
      error: errorMessage(error),
    });
  }
}

async function releaseExit137ConversationWarmLeaseBestEffort(input: {
  workspaceId: string;
  agentId: string;
  deploymentId: string;
  conversationKey: string | null;
}): Promise<void> {
  if (!input.conversationKey) return;
  try {
    const release = await releaseConversationSandboxLease({
      key: {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        deploymentId: input.deploymentId,
        conversationKey: input.conversationKey,
      },
    });
    console.info("[harness] released conversation warm sandbox lease after exit-137 retry handoff", {
      area: "harness-exit-137",
      diag: "harness-exit-137",
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      deploymentId: input.deploymentId,
      conversationKey: input.conversationKey,
      released: release.released,
      sandboxId: release.sandboxId,
    });
  } catch (error) {
    console.warn("[harness] failed to release conversation warm sandbox lease after exit-137 retry handoff", {
      area: "harness-exit-137",
      diag: "harness-exit-137",
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      deploymentId: input.deploymentId,
      conversationKey: input.conversationKey,
      error: errorMessage(error),
    });
  }
}

async function recordExit137AttemptBeforeRetry(input: {
  workspaceId: string;
  agentId: string;
  deploymentId: string;
  payload: unknown;
  handle: RuntimeHandle;
  sandboxName?: string | null;
  mountConfigured: boolean;
  startedAt: Date;
  result: SandboxCapturedOutput;
  error: HarnessExit137Error;
  envelopeJson: string | null;
  sessionId: string;
  commandId?: string | null;
}): Promise<void> {
  await postLinearAgentSessionTerminalWriteback({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    deploymentId: input.deploymentId,
    payload: input.payload,
    terminalStatus: "error",
    result: input.result,
    error: input.error,
    sandboxId: input.handle.id,
    sessionId: input.sessionId,
    commandId: input.commandId ?? null,
  });
  await appendDeploymentRunStructuredLogsBestEffort({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    deploymentId: input.deploymentId,
    eventSource: eventSourceForPayload(input.payload),
    sandboxId: input.handle.id,
    sessionId: input.sessionId,
    commandId: input.commandId ?? null,
    output: input.result.output ?? "",
  });
  await recordAgentDeploymentRun({
    deploymentId: input.deploymentId,
    agentId: input.agentId,
    eventSource: eventSourceForPayload(input.payload),
    handle: input.handle,
    sandboxName: input.sandboxName ?? null,
    mountConfigured: input.mountConfigured,
    startedAt: input.startedAt,
    endedAt: new Date(),
    result: input.result,
    error: input.error,
    envelopeJson: input.envelopeJson,
  });
}

function buildExit137RetrySandboxName(baseName: string, attempt: number): string {
  const suffix = `retry${attempt}`;
  const baseMax = Math.max(1, SANDBOX_NAME_MAX_LENGTH - suffix.length - 1);
  return `${baseName.slice(0, baseMax)}-${suffix}`;
}

function exit137RetryAttemptFromSandboxName(sandboxName: string | null | undefined): number {
  const match = sandboxName?.match(/-retry([1-9]\d*)$/u);
  if (!match) {
    return 0;
  }
  const attempt = Number(match[1]);
  return Number.isSafeInteger(attempt) ? attempt : 0;
}

function parseStoredEnvelopeJson(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// TEMPORARY DIAGNOSTIC — persona-run-exit instrumentation (instrument-dont-guess)
//
// WHY: the in-sandbox proactive persona run (issue→clone→edit→PR) does not
// finish within its budget for some personas, but the cause is invisible — the
// delivery layer fetches the run's exitCode + stdout/stderr (see
// `pollDeploymentTriggerRun`) and writes them ONLY to the `agent_deployment_runs`
// DB row, never to CloudWatch / `wrangler tail`. Daytona CLI OAuth is dead so
// the sandbox `runner.log` is unreadable directly. This emits ONE structured
// log line at each terminal branch so a re-probe can read the in-run cause from
// the tail, WITHOUT Daytona/DB access.
//
// REMOVE once the in-sandbox failure cause is identified (tracked for #1516).
// Observability-only: it never changes control flow, exit precedence, retry, or
// run-recording. Output is redacted (no secrets/tokens) and bounded.
// ---------------------------------------------------------------------------
const PERSONA_RUN_EXIT_DIAG_TAIL_LINES = 50;
const PERSONA_RUN_EXIT_DIAG_TAIL_MAX_BYTES = 4096;

// Redact, then keep only the last N lines, then hard byte-cap — so a noisy run
// cannot blow up the log line.
export function personaRunOutputTailForDiagnostics(output: string): string {
  return runOutputTailForDiagnostics(output, {
    maxLines: PERSONA_RUN_EXIT_DIAG_TAIL_LINES,
    maxBytes: PERSONA_RUN_EXIT_DIAG_TAIL_MAX_BYTES,
  });
}

export function logPersonaRunExitDiagnostic(fields: {
  terminalReason: "completed" | "error" | "timeout" | "sandbox_terminal";
  deploymentId: string;
  agentId: string;
  personaSlug: string | null;
  deployedName: string | null;
  sandboxId: string;
  sessionId: string;
  commandId: string;
  exitCode: number | null;
  durationMs: number;
  ageSeconds: number;
  maxAgeSeconds: number;
  output: string;
  // The raw getScriptLogs result, so we can report which stream (if any)
  // carried bytes. The symptom in the field is "runner.mjs failed" — which is
  // the EMPTY-output fallback (`new Error(output || "runner.mjs failed")`), so
  // an all-zero breakdown here means the runner's output is not being captured
  // at all (the gap is upstream in the runner/getScriptLogs), whereas a
  // non-zero stderr means the cause is now in `outputTail`.
  logs?: { output?: string; stdout?: string; stderr?: string } | null;
}): void {
  // One structured line. `diag: "persona-run-exit"` marks it as the temporary
  // instrument-dont-guess diagnostic so it is trivially grep-able for removal.
  console.info("[persona-run-exit] in-sandbox run terminal", {
    area: "integration-watch-delivery",
    diag: "persona-run-exit",
    terminalReason: fields.terminalReason,
    deploymentId: fields.deploymentId,
    agentId: fields.agentId,
    personaSlug: fields.personaSlug,
    deployedName: fields.deployedName,
    sandboxId: fields.sandboxId,
    sessionId: fields.sessionId,
    commandId: fields.commandId,
    exitCode: fields.exitCode,
    durationMs: fields.durationMs,
    ageSeconds: fields.ageSeconds,
    maxAgeSeconds: fields.maxAgeSeconds,
    // Per-stream byte breakdown: distinguishes "runner produced no captured
    // output" (all zero → look upstream of the delivery layer) from "stderr has
    // the cause" (now in outputTail).
    stdoutBytes: fields.logs?.stdout?.length ?? 0,
    stderrBytes: fields.logs?.stderr?.length ?? 0,
    outputFieldBytes: fields.logs?.output?.length ?? 0,
    combinedOutputBytes: fields.output.length,
    outputTail: personaRunOutputTailForDiagnostics(fields.output),
  });
}

function parseStartedAt(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new DeploymentTriggerDeliveryError(
      `Invalid deployment run startedAt timestamp: ${value}`,
      "deployment_run_invalid_started_at",
      500,
    );
  }
  return parsed;
}

export async function pollDeploymentTriggerRun(input: {
  workspaceId: string;
  agentId: string;
  payload: unknown;
  deliveryId?: string;
  deploymentId: string;
  sandboxId: string;
  sessionId: string;
  commandId: string;
  startedAt: string;
  sandboxName?: string | null;
  mountConfigured?: boolean | null;
  /** Exact delivered envelope JSON, from the pending row (cloud#1841). */
  envelopeJson?: string | null;
  options?: DeploymentTriggerDeliveryOptions;
}): Promise<void> {
  const runtime = createDeploymentSandboxRuntime();
  if (!runtime.getById || !runtime.getScriptStatus || !runtime.getScriptLogs) {
    throw new DeploymentTriggerDeliveryError(
      "Deployment runtime does not support async run polling",
      "deployment_run_poll_unsupported",
      500,
    );
  }
  const startedAt = parseStartedAt(input.startedAt);
  const target = await getAgentDeploymentTickTarget({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
  });
  const conversationKey = slackConversationKeyFromPayload(input.payload);
  const maxAgeSeconds = resolveRunScriptMaxSeconds({
    persona: target?.spec ?? null,
    options: input.options,
  });
  const ageSeconds = Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000));
  const handle = await runtime.getById(input.sandboxId, {
    states: null,
    owned: false,
  });
  if (!handle) {
    throw new DeploymentTriggerDeliveryError(
      `Deployment run sandbox ${input.sandboxId} was not found`,
      "deployment_run_sandbox_missing",
      502,
    );
  }

  let status = await runtime.getScriptStatus(handle, input.sessionId, input.commandId);
  // Lane-6 crash-recovery: exitCode is read FIRST (above) so a real just-landed
  // exit is always honored by the exitCode!=null path below. Only when there is
  // no exit AND the sandbox has entered a terminal state (STOPPED/ERROR/...) do
  // we short-circuit: a terminal box can never produce a non-null exitCode, so
  // re-polling it for up to `maxAgeSeconds` (~30min) is wasted. Mirror the
  // provisioning-poll's `isTerminalSandboxState` check and fail promptly through
  // the SAME bounded `markPendingDeliveryFailed` path the timeout below uses.
  if (status.exitCode == null && isTerminalSandboxState(handle.state)) {
    const terminalError = new DeploymentTriggerRunSandboxTerminalError(
      {
        deploymentId: input.deploymentId,
        sandboxId: input.sandboxId,
        sessionId: input.sessionId,
        commandId: input.commandId,
        startedAt: input.startedAt,
        sandboxName: input.sandboxName,
        mountConfigured: input.mountConfigured ?? undefined,
      },
      handle.state,
    );
    const logs = await runtime.getScriptLogs(handle, input.sessionId, input.commandId).catch(() => null);
    const output = logs ? deploymentRunOutputFromLogs(logs) : "";
    logPersonaRunExitDiagnostic({
      terminalReason: "sandbox_terminal",
      deploymentId: input.deploymentId,
      agentId: input.agentId,
      personaSlug: target?.personaSlug ?? null,
      deployedName: target?.deployedName ?? null,
      sandboxId: input.sandboxId,
      sessionId: input.sessionId,
      commandId: input.commandId,
      exitCode: null,
      durationMs: Math.max(0, Date.now() - startedAt.getTime()),
      ageSeconds,
      maxAgeSeconds,
      output,
      logs,
    });
    const result = new SandboxOrchestrator({
      runScript: runtime.runScript.bind(runtime),
    }).captureOutput(
      { output, exitCode: null, cmdId: input.commandId },
      startedAt.toISOString(),
      startedAt.getTime(),
    );
    await postLinearAgentSessionTerminalWriteback({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      deploymentId: input.deploymentId,
      payload: input.payload,
      terminalStatus: "sandbox_terminal",
      result,
      error: terminalError,
      sandboxId: input.sandboxId,
      sessionId: input.sessionId,
      commandId: input.commandId,
    });
    await postSlackConversationTerminalReply({
      workspaceId: input.workspaceId,
      payload: input.payload,
      outcome: { kind: "failed", reason: "sandbox_terminal" },
      delivery: {
        agentId: input.agentId,
        ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
      },
    });
    await appendDeploymentRunStructuredLogsBestEffort({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      deploymentId: input.deploymentId,
      eventSource: eventSourceForPayload(input.payload),
      sandboxId: input.sandboxId,
      sessionId: input.sessionId,
      commandId: input.commandId,
      output,
    });
    await recordAgentDeploymentRun({
      deploymentId: input.deploymentId,
      agentId: input.agentId,
      eventSource: eventSourceForPayload(input.payload),
      handle,
      sandboxName: input.sandboxName ?? null,
      mountConfigured: Boolean(input.mountConfigured),
      startedAt,
      endedAt: new Date(),
      result,
      error: terminalError,
      envelopeJson: input.envelopeJson ?? null,
    });
    await Promise.allSettled([
      markDeploymentFailed(input.deploymentId),
      markAgentDispatchResult({ agentId: input.agentId, error: terminalError.message }),
    ]);
    await markConversationWarmLeaseAvailableBestEffort({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      deploymentId: input.deploymentId,
      conversationKey,
    });
    throw terminalError;
  }
  if (status.exitCode == null && ageSeconds > maxAgeSeconds) {
    const timeoutError = new DeploymentTriggerRunTimedOutError({
      deploymentId: input.deploymentId,
      sandboxId: input.sandboxId,
      sessionId: input.sessionId,
      commandId: input.commandId,
      startedAt: input.startedAt,
      sandboxName: input.sandboxName,
      mountConfigured: input.mountConfigured ?? undefined,
    }, maxAgeSeconds);
    const logs = await runtime.getScriptLogs(handle, input.sessionId, input.commandId).catch(() => null);
    const output = logs ? deploymentRunOutputFromLogs(logs) : "";
    // TEMPORARY (instrument-dont-guess, #1516): surface WHY the in-sandbox run
    // never finished within budget — the last lines of its output + the fact it
    // had no exitCode when the budget elapsed — into the tail/CloudWatch.
    logPersonaRunExitDiagnostic({
      terminalReason: "timeout",
      deploymentId: input.deploymentId,
      agentId: input.agentId,
      personaSlug: target?.personaSlug ?? null,
      deployedName: target?.deployedName ?? null,
      sandboxId: input.sandboxId,
      sessionId: input.sessionId,
      commandId: input.commandId,
      exitCode: null,
      durationMs: Math.max(0, Date.now() - startedAt.getTime()),
      ageSeconds,
      maxAgeSeconds,
      output,
      logs,
    });
    const result = new SandboxOrchestrator({
      runScript: runtime.runScript.bind(runtime),
    }).captureOutput(
      { output, exitCode: null, cmdId: input.commandId },
      startedAt.toISOString(),
      startedAt.getTime(),
    );
    await postLinearAgentSessionTerminalWriteback({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      deploymentId: input.deploymentId,
      payload: input.payload,
      terminalStatus: "timeout",
      result,
      error: timeoutError,
      sandboxId: input.sandboxId,
      sessionId: input.sessionId,
      commandId: input.commandId,
    });
    await postSlackConversationTerminalReply({
      workspaceId: input.workspaceId,
      payload: input.payload,
      outcome: { kind: "failed", reason: "timeout" },
      delivery: {
        agentId: input.agentId,
        ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
      },
    });
    await appendDeploymentRunStructuredLogsBestEffort({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      deploymentId: input.deploymentId,
      eventSource: eventSourceForPayload(input.payload),
      sandboxId: input.sandboxId,
      sessionId: input.sessionId,
      commandId: input.commandId,
      output,
    });
    await recordAgentDeploymentRun({
      deploymentId: input.deploymentId,
      agentId: input.agentId,
      eventSource: eventSourceForPayload(input.payload),
      handle,
      sandboxName: input.sandboxName ?? null,
      mountConfigured: Boolean(input.mountConfigured),
      startedAt,
      endedAt: new Date(),
      result,
      error: timeoutError,
      envelopeJson: input.envelopeJson ?? null,
    });
    await Promise.allSettled([
      markDeploymentFailed(input.deploymentId),
      markAgentDispatchResult({ agentId: input.agentId, error: timeoutError.message }),
    ]);
    await markConversationWarmLeaseAvailableBestEffort({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      deploymentId: input.deploymentId,
      conversationKey,
    });
    throw timeoutError;
  }

  if (status.exitCode == null) {
    throw new DeploymentTriggerRunPendingError({
      deploymentId: input.deploymentId,
      sandboxId: input.sandboxId,
      sessionId: input.sessionId,
      commandId: input.commandId,
      startedAt: input.startedAt,
      sandboxName: input.sandboxName,
      mountConfigured: input.mountConfigured ?? undefined,
      envelopeJson: input.envelopeJson ?? null,
    });
  }

  const logs = await runtime.getScriptLogs(handle, input.sessionId, input.commandId);
  const output = deploymentRunOutputFromLogs(logs);
  // TEMPORARY (instrument-dont-guess, #1516): a finished run records its
  // outcome only to the DB row; surface the terminal reason + exitCode + output
  // tail to the tail/CloudWatch too. A non-zero exitCode here is the in-sandbox
  // run failing fast (vs. the budget timeout above).
  logPersonaRunExitDiagnostic({
    terminalReason: status.exitCode === 0 ? "completed" : "error",
    deploymentId: input.deploymentId,
    agentId: input.agentId,
    personaSlug: target?.personaSlug ?? null,
    deployedName: target?.deployedName ?? null,
    sandboxId: input.sandboxId,
    sessionId: input.sessionId,
    commandId: input.commandId,
    exitCode: status.exitCode,
    durationMs: Math.max(0, Date.now() - startedAt.getTime()),
    ageSeconds,
    maxAgeSeconds,
    output,
    logs,
  });
  const result = new SandboxOrchestrator({
    runScript: runtime.runScript.bind(runtime),
  }).captureOutput(
    { output, exitCode: status.exitCode, cmdId: input.commandId },
    startedAt.toISOString(),
    startedAt.getTime(),
  );
  const exit137RetryAttempt =
    input.options?.exit137RetryAttempt ??
    exit137RetryAttemptFromSandboxName(input.sandboxName);
  const exit137AgentName = target?.deployedName ?? target?.personaSlug ?? input.agentId;
  const exit137Error = isHarnessExit137(result)
    ? harnessExit137Error({
        agentName: exit137AgentName,
        deploymentId: input.deploymentId,
        sandboxId: input.sandboxId,
        sandboxName: input.sandboxName,
        sessionId: input.sessionId,
        commandId: input.commandId,
        result,
      })
    : null;
  // cloud#2029: parse the teardown cleanup status BEFORE computing runError so a
  // dropped writeback fails the run loudly — and, critically, BEFORE the
  // terminal Slack/Linear replies below, which otherwise post "completed" for a
  // run whose command draft never delivered.
  const cleanupStatus = parseMountCleanupStatus(
    output,
    Boolean(input.mountConfigured),
    extractMountLogTail(output),
    true,
  );
  const terminalOutputError = deploymentRunTerminalErrorFromOutput({
    output,
    relayWorkspaceId: input.workspaceId,
    agentId: input.agentId,
    deploymentId: input.deploymentId,
    eventSource: eventSourceForPayload(input.payload),
    sandboxId: input.sandboxId,
    sessionId: input.sessionId,
    commandId: input.commandId,
  });
  const writebackUndeliveredError = writebackUndeliveredErrorFromCleanup(cleanupStatus);
  const cleanupOnlySuccessfulHandlerExit = !terminalOutputError &&
    !exit137Error &&
    !writebackUndeliveredError &&
    isCleanupOnlySuccessfulHandlerExit({
      exitCode: status.exitCode,
      output,
      cleanupStatus,
      relayWorkspaceId: input.workspaceId,
      agentId: input.agentId,
      deploymentId: input.deploymentId,
      eventSource: eventSourceForPayload(input.payload),
      sandboxId: input.sandboxId,
      sessionId: input.sessionId,
      commandId: input.commandId,
    });
  if (cleanupOnlySuccessfulHandlerExit) {
    logCleanupNonzeroButComplete({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      deploymentId: input.deploymentId,
      deliveryId: input.deliveryId,
      commandId: input.commandId,
      flushExitCode: cleanupStatus.flushExitCode,
      killExitCode: cleanupStatus.killExitCode,
      phase: "poll",
    });
  }
  const runError =
    terminalOutputError ??
    exit137Error ??
    writebackUndeliveredError ??
    (status.exitCode === 0 || cleanupOnlySuccessfulHandlerExit ? null : new Error(output || "runner.mjs failed"));
  await postLinearAgentSessionTerminalWriteback({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    deploymentId: input.deploymentId,
    payload: input.payload,
    terminalStatus: runError ? "error" : "completed",
    result,
    error: runError,
    sandboxId: input.sandboxId,
    sessionId: input.sessionId,
    commandId: input.commandId,
  });
  await postSlackConversationTerminalReply({
    workspaceId: input.workspaceId,
    payload: input.payload,
    outcome: runError
      ? { kind: "failed", reason: "error" }
      : { kind: "completed", output },
    delivery: {
      agentId: input.agentId,
      ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
    },
  });
  await appendDeploymentRunStructuredLogsBestEffort({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    deploymentId: input.deploymentId,
    eventSource: eventSourceForPayload(input.payload),
    sandboxId: input.sandboxId,
    sessionId: input.sessionId,
    commandId: input.commandId,
    output,
  });
  await recordAgentDeploymentRun({
    deploymentId: input.deploymentId,
    agentId: input.agentId,
    eventSource: eventSourceForPayload(input.payload),
    handle,
    sandboxName: input.sandboxName ?? null,
    mountConfigured: Boolean(input.mountConfigured),
    startedAt,
    endedAt: new Date(),
    result,
    error: runError,
    envelopeJson: input.envelopeJson ?? null,
  });
  await markConversationWarmLeaseAvailableBestEffort({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    deploymentId: input.deploymentId,
    conversationKey,
  });
  if (exit137Error) {
    const envelope = parseStoredEnvelopeJson(input.envelopeJson) ?? buildEnvelope({
      workspaceId: input.workspaceId,
      deploymentId: input.deploymentId,
      payload: input.payload,
    });
    let pullRequestReviewerEnabled = false;
    let usesSandbox = false;
    let pullRequestWorkspaceBase: ReturnType<typeof githubPullRequestWorkspaceFromEnvelope> = null;
    if (target) {
      usesSandbox = !personaSkipsSandbox(target.spec);
      pullRequestReviewerEnabled =
        usesSandbox &&
        isPullRequestReviewerPersona(target.spec);
      pullRequestWorkspaceBase = pullRequestReviewerEnabled
        ? githubPullRequestWorkspaceFromEnvelope(envelope)
        : null;
      if (!pullRequestWorkspaceBase && isPullRequestWorkspaceEvent(envelope) && pullRequestReviewerEnabled) {
        pullRequestWorkspaceBase = await hydrateGithubPullRequestWorkspaceFromEnvelope({
          envelope,
          workspaceId: input.workspaceId,
          userId: target.deployedByUserId,
        });
      }
    }
    const retrying = Boolean(
      target &&
      usesSandbox &&
      exit137RetryAttempt < 1,
    );
    logHarnessExit137({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      agentName: exit137AgentName,
      deploymentId: input.deploymentId,
      sandboxId: input.sandboxId,
      sandboxName: input.sandboxName,
      sessionId: input.sessionId,
      commandId: input.commandId,
      result,
      retrying,
      attempt: exit137RetryAttempt + 1,
    });
    if (retrying && target) {
      await destroyExit137SandboxBestEffort({
        runtime,
        handle,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        deploymentId: input.deploymentId,
      });
      if (pullRequestWorkspaceBase && booleanInputValue(target.inputValues, PR_SANDBOX_WARM_LEASE_INPUT)) {
        await releaseExit137WarmLeaseBestEffort({
          runtime,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          deploymentId: input.deploymentId,
          repoFullName: `${pullRequestWorkspaceBase.owner}/${pullRequestWorkspaceBase.repo}`,
          prNumber: pullRequestWorkspaceBase.number,
        });
      }
      await releaseExit137ConversationWarmLeaseBestEffort({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        deploymentId: input.deploymentId,
        conversationKey,
      });
      await runDeploymentTrigger({
        workspaceId: input.workspaceId,
        target,
        deploymentId: input.deploymentId,
        triggerKind: triggerKindForPayload(input.payload),
        payload: input.payload,
        options: {
          ...input.options,
          asyncRunScript: true,
          exit137RetryAttempt: exit137RetryAttempt + 1,
        },
      });
      return;
    }
  }
  if (runError) {
    await Promise.allSettled([
      markDeploymentFailed(input.deploymentId),
      markAgentDispatchResult({ agentId: input.agentId, error: runError.message }),
    ]);
    throw runError;
  }
  await markAgentDispatchResult({ agentId: input.agentId, error: null });
}

async function deliverEnvelopeToSandbox(input: {
  workspaceId: string;
  agentId: string;
  deployedName: string;
  deployedByUserId: string;
  personaSlug: string;
  persona: Record<string, unknown> | null;
  agentSpec?: DeploymentAgentSpec | null;
  bundleSha256: string | null;
  inputValues: Record<string, string>;
  credentialSelections: Record<string, string>;
  deploymentId: string;
  triggerKind: "inbox" | "clock";
  payload: unknown;
  deliveryId?: string;
  resumeContext?: DeploymentResumeContext;
  provisioningSandboxId?: string | null;
  options?: DeploymentTriggerDeliveryOptions;
}): Promise<void> {
  const startedAt = new Date();
  let runtime = createDeploymentSandboxRuntime();
  let orchestrator = createDeploymentSandboxOrchestrator(runtime);
  let handle: RuntimeHandle | null = null;
  let sandboxName: string | null = null;
  let result: SandboxCapturedOutput | null = null;
  let mountConfigured = false;
  let runSandboxId: string | null = null;
  let runError: unknown;
  let envelopeJson: string | null = null;
  let conversationHarnessSession: DeploymentHarnessSession | null = null;
  let conversationKey: string | null = null;
  let prWarmLeaseAcquiredForAttempt = false;
  let conversationWarmLeaseAcquiredForAttempt = false;
  try {
    const runScriptMaxSeconds = resolveRunScriptMaxSeconds({
      persona: input.persona,
      options: input.options,
    });
    const sandboxLeaseTtlSeconds = runScriptMaxSeconds + SANDBOX_LEASE_BUFFER_SECONDS;
    let envelope = buildEnvelope({
      workspaceId: input.workspaceId,
      deploymentId: input.deploymentId,
      payload: input.payload,
      resumeContext: input.resumeContext,
    });
    // Byte-exact capture of what runner.mjs will receive (cloud#1841).
    // JSON.stringify is deterministic for the same object, so this matches
    // the script-embedded serialization byte-for-byte.
    envelopeJson = JSON.stringify(envelope);
    const lightweightSandbox = personaSkipsSandbox(input.persona);
    const usesSandbox = !lightweightSandbox;
    const conflictResolveEnabled =
      usesSandbox && isConflictResolvePersona(input.persona);
    const conflictResolveMode =
      conflictResolveEnabled && isConflictResolveDirectiveEnvelope(envelope);
    const exit137AgentName = input.deployedName ?? input.personaSlug ?? input.agentId;
    const pullRequestReviewerEnabled =
      usesSandbox && (isPullRequestReviewerPersona(input.persona) || conflictResolveEnabled);
    const pullRequestWritebackEnabled =
      usesSandbox && (personaWantsPullRequestWriteback(input.persona) || conflictResolveMode);
    let pullRequestWorkspaceBase = pullRequestReviewerEnabled
      ? githubPullRequestWorkspaceFromEnvelope(envelope)
      : null;
    const pullRequestWarmLeaseEnabled = booleanInputValue(
      input.inputValues,
      PR_SANDBOX_WARM_LEASE_INPUT,
    );
    conversationKey = slackConversationKeyFromPayload(input.payload);
    const conversationalWarmLeaseEnabled =
      usesSandbox &&
      conversationSandboxWarmEnabled() &&
      isConversationalPersona(input.persona) &&
      conversationKey !== null;
    if (!pullRequestWorkspaceBase && isPullRequestWorkspaceEvent(envelope) && pullRequestReviewerEnabled) {
      pullRequestWorkspaceBase = await hydrateGithubPullRequestWorkspaceFromEnvelope({
        envelope,
        workspaceId: input.workspaceId,
        userId: input.deployedByUserId,
      });
    }
    if (!pullRequestWorkspaceBase && isPullRequestWorkspaceEvent(envelope) && pullRequestReviewerEnabled) {
      throw new DeploymentTriggerDeliveryError(
        "pr-reviewer pull_request event did not contain enough repository/head/base data to materialize a checkout",
        "pr_reviewer_checkout_unavailable",
        422,
      );
    }
    if (pullRequestWorkspaceBase && pullRequestWarmLeaseEnabled && isPullRequestClosedEvent(envelope)) {
      runtime = createDeploymentSandboxRuntime({ snapshot: await getSnapshotName() });
      const release = await releasePrSandboxSlot({
        runtime,
        key: {
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          repoFullName: `${pullRequestWorkspaceBase.owner}/${pullRequestWorkspaceBase.repo}`,
          prNumber: pullRequestWorkspaceBase.number,
        },
      });
      console.info("[pr-sandbox-lease] pull request closed; released warm sandbox lease", {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        repoFullName: `${pullRequestWorkspaceBase.owner}/${pullRequestWorkspaceBase.repo}`,
        prNumber: pullRequestWorkspaceBase.number,
        released: release.released,
        destroyed: release.destroyed,
        skippedActiveRun: release.skippedActiveRun,
        sandboxId: release.sandboxId,
      });
      result = {
        output: release.released
          ? `[pr-sandbox-lease] released warm sandbox for closed pull request #${pullRequestWorkspaceBase.number}`
          : `[pr-sandbox-lease] no warm sandbox lease found for closed pull request #${pullRequestWorkspaceBase.number}`,
        chunks: [],
        exitCode: 0,
        startedAt: startedAt.toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - startedAt.getTime()),
      };
      return;
    }

    // S6 conflict-autofix execution hook (capability-gated; dormant unless a
    // persona declares `capabilities.conflictAutofix`). The dispatcher's
    // self-trigger suppression + #1491 PR-context cooldown have already gated
    // whether we get here at all. We classify + poll mergeability BEFORE
    // provisioning a sandbox so the (common) non-conflicting PR event resolves
    // to a cheap skip without ever paying for a box. Only a confirmed `dirty`
    // PR with a safe, same-repo, non-fork head yields a rebase plan that needs
    // the sandbox.
    const conflictAutofixEnabled = isConflictAutofixPersona(input.persona);
    let conflictAutofixPlan: Extract<ConflictAutofixPlan, { action: "rebase" }> | null = null;
    if (conflictAutofixEnabled) {
      const prPayload = isRecord(envelope.resource) ? envelope.resource : envelope;
      const identity = classifyPullRequestMergeState(prPayload);
      const plan = await resolveConflictAutofixPlan({
        payload: prPayload,
        // Mergeability reads go through the github-relay proxy, NOT the minted
        // installation write token: the write token reliably authorizes git
        // fetch/push but 403s on the PR detail read endpoint, whereas the proxy
        // path is confirmed to 200 on `/pulls/N` (see the github-token-scopes
        // lesson). A vanished PR (404) ends the poll as `unavailable`.
        fetchPullRequest: async () => {
          if (!identity.owner || !identity.repo || identity.number === null) {
            return null;
          }
          try {
            const body = await readGithubProxyPullRequest({
              userId: input.deployedByUserId,
              workspaceId: input.workspaceId,
              owner: identity.owner,
              repo: identity.repo,
              pullNumber: identity.number,
            });
            const head = isRecord(body.head) ? body.head : null;
            return {
              mergeable: typeof body.mergeable === "boolean" ? body.mergeable : null,
              mergeable_state: stringValue(body.mergeable_state),
              headSha: head ? stringValue(head.sha) : null,
            };
          } catch (error) {
            if (error instanceof GithubProxyPullRequestError && error.status === 404) {
              return null;
            }
            throw error;
          }
        },
      });
      if (plan.action === "skip") {
        if (plan.comment && identity.owner && identity.repo && identity.number !== null) {
          await postConflictAutofixComment({
            deployedByUserId: input.deployedByUserId,
            workspaceId: input.workspaceId,
            owner: identity.owner,
            repo: identity.repo,
            number: identity.number,
            body: plan.comment,
          });
        }
        console.info("[conflict-autofix] no rebase performed; skipping sandbox provisioning", {
          area: "conflict-autofix-delivery",
          reason: plan.reason,
          deploymentId: input.deploymentId,
          ...(identity.number !== null ? { pullRequest: identity.number } : {}),
        });
        // Record a clean no-op run (exitCode 0 → "succeeded") so the skip is
        // observable but is NOT a failure that retries.
        result = {
          output: `[conflict-autofix] skip: ${plan.reason}`,
          chunks: [],
          exitCode: 0,
          startedAt: startedAt.toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: Math.max(0, Date.now() - startedAt.getTime()),
        };
        return;
      }
      conflictAutofixPlan = plan;
    }

    const setConversationHarnessSession = (harnessSession: DeploymentHarnessSession): void => {
      conversationHarnessSession = harnessSession;
      envelope = buildEnvelope({
        workspaceId: input.workspaceId,
        deploymentId: input.deploymentId,
        payload: input.payload,
        resumeContext: input.resumeContext,
        harnessSession,
      });
      envelopeJson = JSON.stringify(envelope);
    };
    const clearConversationHarnessSession = (): void => {
      if (!conversationHarnessSession) return;
      conversationHarnessSession = null;
      envelope = buildEnvelope({
        workspaceId: input.workspaceId,
        deploymentId: input.deploymentId,
        payload: input.payload,
        resumeContext: input.resumeContext,
      });
      envelopeJson = JSON.stringify(envelope);
    };

    const acquireDeliverySandbox = async (attempt: number): Promise<void> => {
      prWarmLeaseAcquiredForAttempt = false;
      conversationWarmLeaseAcquiredForAttempt = false;
      clearConversationHarnessSession();
      let provisioningSandboxId = attempt === 1 ? input.provisioningSandboxId ?? null : null;
      if (provisioningSandboxId && await isDeploymentSandboxLeased({
          agentId: input.agentId,
          sandboxId: provisioningSandboxId,
          ttlSeconds: sandboxLeaseTtlSeconds,
        })) {
        provisioningSandboxId = null;
      }

      if (attempt > 1) {
        if (!input.bundleSha256 || !input.persona) {
          throw new DeploymentTriggerDeliveryError(
            "agent has no persisted bundle; redeploy under cold-start runtime",
            "bundle_unavailable",
            410,
          );
        }
        runtime = createDeploymentSandboxRuntime({ snapshot: await getSnapshotName() });
        orchestrator = createDeploymentSandboxOrchestrator(runtime);
        const baseSandboxName = buildPerFireSandboxName({
          personaSlug: input.personaSlug,
          deploymentId: input.deploymentId,
        });
        sandboxName = buildExit137RetrySandboxName(baseSandboxName, attempt - 1);
        handle = await provisionOnDemandSandbox({
          runtime,
          orchestrator,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          deployedName: input.deployedName,
          deployedByUserId: input.deployedByUserId,
          personaSlug: input.personaSlug,
          deploymentId: input.deploymentId,
          bundleSha256: input.bundleSha256,
          persona: input.persona,
          agentSpec: input.agentSpec,
          inputValues: input.inputValues,
          credentialSelections: input.credentialSelections,
          sandboxName,
          labels: { oomRetry: "exit-137", retryAttempt: String(attempt - 1) },
          options: input.options,
        });
        return;
      }

      if (pullRequestWorkspaceBase && pullRequestWarmLeaseEnabled && !provisioningSandboxId) {
        if (!input.bundleSha256 || !input.persona) {
          throw new DeploymentTriggerDeliveryError(
            "agent has no persisted bundle; redeploy under cold-start runtime",
            "bundle_unavailable",
            410,
          );
        }
        const pullRequestSnapshotVersion = await getSnapshotName();
        runtime = createDeploymentSandboxRuntime({ snapshot: pullRequestSnapshotVersion });
        orchestrator = createDeploymentSandboxOrchestrator(runtime);
        const acquired = await acquirePrSandbox({
          runtime,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          repoFullName: `${pullRequestWorkspaceBase.owner}/${pullRequestWorkspaceBase.repo}`,
          prNumber: pullRequestWorkspaceBase.number,
          leaseTtlSeconds: sandboxLeaseTtlSeconds,
          snapshotVersion: pullRequestSnapshotVersion,
          createSandbox: (createInput) => provisionOnDemandSandbox({
            runtime,
            orchestrator,
            workspaceId: input.workspaceId,
            agentId: input.agentId,
            deployedName: input.deployedName,
            deployedByUserId: input.deployedByUserId,
            personaSlug: input.personaSlug,
            deploymentId: input.deploymentId,
            bundleSha256: input.bundleSha256!,
            persona: input.persona!,
            agentSpec: input.agentSpec,
            inputValues: input.inputValues,
            credentialSelections: input.credentialSelections,
            sandboxName: createInput.sandboxName,
            labels: createInput.labels,
            options: input.options,
          }),
        });
        handle = acquired.handle;
        sandboxName = acquired.sandboxName;
        prWarmLeaseAcquiredForAttempt = true;
        if (acquired.reused) {
          await uploadDeploymentBundleToSandbox({
            orchestrator,
            handle,
            bundleSha256: input.bundleSha256,
            persona: input.persona,
          });
        }
      } else if (conversationalWarmLeaseEnabled && conversationKey && !provisioningSandboxId) {
        if (!input.bundleSha256 || !input.persona) {
          throw new DeploymentTriggerDeliveryError(
            "agent has no persisted bundle; redeploy under cold-start runtime",
            "bundle_unavailable",
            410,
          );
        }
        const conversationSnapshotVersion = await getSnapshotName();
        runtime = createDeploymentSandboxRuntime({ snapshot: conversationSnapshotVersion });
        orchestrator = createDeploymentSandboxOrchestrator(runtime);
        try {
          const acquired = await acquireConversationSandbox({
            runtime,
            workspaceId: input.workspaceId,
            deploymentId: input.deploymentId,
            agentId: input.agentId,
            conversationKey,
            leaseTtlSeconds: sandboxLeaseTtlSeconds,
            snapshotVersion: conversationSnapshotVersion,
            createSandbox: (createInput) => provisionOnDemandSandbox({
              runtime,
              orchestrator,
              workspaceId: input.workspaceId,
              agentId: input.agentId,
              deployedName: input.deployedName,
              deployedByUserId: input.deployedByUserId,
              personaSlug: input.personaSlug,
              deploymentId: input.deploymentId,
              bundleSha256: input.bundleSha256!,
              persona: input.persona!,
              agentSpec: input.agentSpec,
              inputValues: input.inputValues,
              credentialSelections: input.credentialSelections,
              sandboxName: createInput.sandboxName,
              labels: createInput.labels,
              options: input.options,
            }),
          });
          handle = acquired.handle;
          sandboxName = acquired.sandboxName;
          conversationWarmLeaseAcquiredForAttempt = true;
          setConversationHarnessSession({
            id: acquired.harnessSessionId,
            resume: acquired.reused,
          });
          if (acquired.reused) {
            await uploadDeploymentBundleToSandbox({
              orchestrator,
              handle,
              bundleSha256: input.bundleSha256,
              persona: input.persona,
            });
          }
        } catch (error) {
          if (!(error instanceof ConversationSandboxLeaseBusyError)) {
            throw error;
          }
          console.info("[conversation-sandbox-lease] warm lease is already in use; falling back to cold sandbox", {
            workspaceId: input.workspaceId,
            agentId: input.agentId,
            deploymentId: input.deploymentId,
            conversationKey,
          });
        }
      }
      if (!handle) {
        handle = provisioningSandboxId
          ? null
          : await resolveDeploymentSandbox({
              runtime,
              workspaceId: input.workspaceId,
              agentId: input.agentId,
              leaseTtlSeconds: sandboxLeaseTtlSeconds,
            });
        if (!handle) {
          if (!input.bundleSha256 || !input.persona) {
            throw new DeploymentTriggerDeliveryError(
              "agent has no persisted bundle; redeploy under cold-start runtime",
              "bundle_unavailable",
              410,
            );
          }
          runtime = createDeploymentSandboxRuntime({ snapshot: await getSnapshotName() });
          orchestrator = createDeploymentSandboxOrchestrator(runtime);
          sandboxName = buildPerFireSandboxName({
            personaSlug: input.personaSlug,
            deploymentId: input.deploymentId,
          });
          handle = await provisionOnDemandSandbox({
            runtime,
            orchestrator,
            workspaceId: input.workspaceId,
            agentId: input.agentId,
            deployedName: input.deployedName,
            deployedByUserId: input.deployedByUserId,
            personaSlug: input.personaSlug,
            deploymentId: input.deploymentId,
            bundleSha256: input.bundleSha256,
            persona: input.persona,
            agentSpec: input.agentSpec,
            inputValues: input.inputValues,
            credentialSelections: input.credentialSelections,
            provisioningSandboxId,
            options: input.options,
            // Persist the sandbox id and yield while it boots instead of blocking
            // the Worker — closes the duplicate-sandbox window where the claim
            // lease expiring mid-provision lets a re-claim spawn a second box (the
            // repeated-Slack-post bug). Gated on the tick drain's explicit option,
            // NOT on triggerKind: yielding is only safe when the caller catches
            // DeploymentSandboxProvisioningPendingError and persists
            // provisioning_sandbox_id (which only the deployment_tick_deliveries
            // drain does). Callers that can't persist — e.g. the direct inbox/vfs
            // deliver routes, which can see a clock-kind empty payload — keep the
            // in-process wait so a 503 retry never orphans a booting sandbox.
            yieldWhileProvisioning: input.options?.provisioningYieldEnabled === true,
          });
        } else {
          if (!input.bundleSha256 || !input.persona) {
            throw new DeploymentTriggerDeliveryError(
              "agent has no persisted bundle; redeploy under cold-start runtime",
              "bundle_unavailable",
              410,
            );
          }
          await uploadDeploymentBundleToSandbox({
            orchestrator,
            handle,
            bundleSha256: input.bundleSha256,
            persona: input.persona,
          });
        }
      }
    };

    const requestedExit137RetryAttempt = Math.min(
      1,
      Math.max(0, input.options?.exit137RetryAttempt ?? 0),
    );
    const initialExit137Attempt = requestedExit137RetryAttempt + 1;
    await acquireDeliverySandbox(initialExit137Attempt);
    const requireDeliveryHandle = (): RuntimeHandle => {
      if (!handle) {
        throw new DeploymentTriggerDeliveryError(
          "deployment sandbox handle is unavailable",
          "deployment_sandbox_unavailable",
          500,
        );
      }
      return handle;
    };

    // S6 conflict-autofix: run the deterministic safe-rebase shell in the
    // provisioned sandbox INSTEAD of the LLM `runner.mjs`. This deliberately
    // bypasses the harness-credential mount, relayfile mount, provider env and
    // envelope runner — the rebase is pure git + a minted GitHub installation
    // token, mirroring the deterministic deployment-invoke discipline (exit
    // precedence honoured by `buildConflictAutofixSandboxScript`).
    if (conflictAutofixEnabled && conflictAutofixPlan) {
      // Fail loud rather than mis-route: a resolved rebase plan MUST run the
      // deterministic autofix shell, never silently fall through to the LLM
      // runner path below. In practice provisioning throws before here so a
      // null handle is unreachable, but assert it so a future refactor that
      // breaks that invariant surfaces instead of running the wrong delivery.
      if (!handle) {
        throw new DeploymentTriggerDeliveryError(
          "conflict-autofix rebase plan resolved but no sandbox handle was provisioned",
          "conflict_autofix_sandbox_unavailable",
          500,
        );
      }
      const minted = await mintWorkflowGithubWriteToken({
        userId: input.deployedByUserId,
        workspaceId: input.workspaceId,
        repoOwner: conflictAutofixPlan.owner,
        repoName: conflictAutofixPlan.repo,
      });
      const command = withShellTimeout(
        buildConflictAutofixSandboxScript({
          plan: conflictAutofixPlan,
          // Plain (non-tokenized) remote; auth flows via the askpass prefix so
          // the token is never written into the persisted `origin` URL.
          remoteUrl: `https://github.com/${conflictAutofixPlan.owner}/${conflictAutofixPlan.repo}.git`,
          workspaceDir: DEPLOYMENT_WORKSPACE_DIR,
        }),
        runScriptMaxSeconds,
      );
      result = await orchestrator.runScript(handle, {
        command,
        sessionId: buildDeploymentRunSessionId(input.deploymentId),
        timeoutMs: input.options?.runScriptTimeoutMs ?? 120_000,
        env: { [CONFLICT_AUTOFIX_GIT_TOKEN_ENV]: minted.token },
      });
      const outcome = parseConflictAutofixOutcome(result.output);
      // Post the human-facing comment for every safety stand-down (conflict /
      // head-advanced / lease-rejected / fetch-failed). `pushed`/`rebased` need
      // none. Comments go through the github-relay proxy (worker side), not the
      // sandbox, so they don't depend on the sandbox holding proxy creds.
      if (outcome && !conflictAutofixOutcomeIsSuccess(outcome)) {
        const body = buildConflictAutofixComment({
          outcome,
          number: conflictAutofixPlan.number,
          baseBranch: conflictAutofixPlan.baseBranch,
          headRef: conflictAutofixPlan.headRef,
        });
        if (body) {
          await postConflictAutofixComment({
            deployedByUserId: input.deployedByUserId,
            workspaceId: input.workspaceId,
            owner: conflictAutofixPlan.owner,
            repo: conflictAutofixPlan.repo,
            number: conflictAutofixPlan.number,
            body,
          });
        }
      }
      // Outcome accounting: `pushed`/`rebased` are clean successes; every safety
      // stand-down is a RECORDED non-success (the run records exit 93–96 →
      // "failed") that must NOT throw — throwing would mark the delivery failed
      // and trigger a retry storm, defeating the deterministic stand-down. Only
      // a missing outcome (the script was killed before it emitted one) is an
      // unexpected failure we surface so it is retried/alerted.
      if (!outcome) {
        throw new Error(result.output || "conflict-autofix run produced no outcome");
      }
      return;
    }

    const relayWorkspaceId = await resolveRelayWorkspaceIdForDelivery({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      phase: "deliver",
    });
    const workflowEnv = await workflowEnvVars({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
    });
    const providerEnv = await resolveSelectedProviderEnv({
      workspaceId: input.workspaceId,
      deployedByUserId: input.deployedByUserId,
      credentialSelections: input.credentialSelections,
      persona: input.persona,
    });
    const personaIntegrationEnv = await resolvePersonaIntegrationEnv({
      deployedByUserId: input.deployedByUserId,
      persona: input.persona,
      inputValues: input.inputValues,
    });

    // Per-fire mount: every invocation mints a fresh path-scoped relayfile
    // token so that even when `resolveDeploymentSandbox` reuses a sandbox
    // across fires (label match on workspaceId + agentId), the relayfile-
    // mount daemon started for this fire has an unexpired token. The
    // mount config also drives the bash that starts the daemon (initial
    // sync) and flushes it after the runner exits — without these the
    // handler writes draft JSON files under
    // `/home/daytona/workspace/<provider>/...` that never reach
    // relayfile cloud / the upstream provider. Mirrors the workflow
    // executor pattern at `packages/core/src/executor/executor.ts`.
    const { relayfilePaths, syncPaths } = relayfileMountPathsForPersona(input.persona, input.agentSpec);
    const eventSyncPaths = eventScopedSyncPaths(envelope);
    const proactiveGitWorkspaceBase = lightweightSandbox || pullRequestWorkspaceBase || isPullRequestWorkspaceEvent(envelope)
      ? null
      : proactiveGitWorkspaceFromSources({
          envelope,
          relayfilePaths: [...relayfilePaths, ...syncPaths, ...eventSyncPaths],
        });
    let proactiveGitWorkspace: ProactiveGitWorkspaceConfig | null = null;
    let proactiveGitWorkspaceToken: string | null = null;
    if (proactiveGitWorkspaceBase) {
      const credentials = await resolveGitCloneCredentials({
        userId: input.deployedByUserId,
        workspaceId: input.workspaceId,
        remoteUrl: proactiveGitWorkspaceBase.remoteUrl,
      });
      if (!credentials) {
        console.warn("[proactive-runtime] git workspace source has no integration token; refusing proactive source clone", {
          repo: `${proactiveGitWorkspaceBase.owner}/${proactiveGitWorkspaceBase.repo}`,
          remoteUrl: proactiveGitWorkspaceBase.remoteUrl,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
        });
        throw new DeploymentTriggerDeliveryError(
          "GitHub integration token is required to clone proactive issue workspace source",
          "proactive_git_clone_token_unavailable",
          503,
        );
      }
      proactiveGitWorkspace = {
        ...proactiveGitWorkspaceBase,
        tokenEnvKey: PROACTIVE_GIT_WORKSPACE_TOKEN_ENV,
        username: credentials.username,
      };
      proactiveGitWorkspaceToken = credentials.token;
    }

    const prepareRunInvocation = async (): Promise<{
      invokeScript: string;
      runEnv: Record<string, string>;
    }> => {
      if (!handle) {
        throw new DeploymentTriggerDeliveryError(
          "deployment sandbox handle is unavailable",
          "deployment_sandbox_unavailable",
          500,
        );
      }
      const currentHandle = handle;
      const harnessCliCredentialMount = lightweightSandbox
        ? EMPTY_HARNESS_CLI_CREDENTIAL_MOUNT
        : await mountHarnessCliCredential({
            orchestrator,
            handle: currentHandle,
            persona: input.persona,
            deployedByUserId: input.deployedByUserId,
          });
      const envVars: Record<string, string> = {
        WORKFORCE_AGENT_ID: input.agentId,
        WORKFORCE_WORKSPACE_ID: input.workspaceId,
        WORKFORCE_SANDBOX_ROOT: DEPLOYMENT_WORKSPACE_DIR,
        WORKFORCE_WORKSPACE_DIR: DEPLOYMENT_WORKSPACE_DIR,
        WORKFORCE_AGENT_CONTEXT: runtimeAgentContext({
          agentId: input.agentId,
          deployedName: input.deployedName,
          inputValues: input.inputValues,
        }),
        WORKFORCE_DEPLOYMENT_CONTEXT: runtimeDeploymentContext({
          deploymentId: input.deploymentId,
          triggerKind: input.triggerKind,
        }),
        RELAY_AGENT_NAME: input.agentId,
        RELAY_DEFAULT_WORKSPACE: relayWorkspaceId,
        ...workflowEnv,
        // Harness-credential env derived from the SAME in-sandbox auth blob the
        // harness uses (CLAUDE_CODE_OAUTH_TOKEN for anthropic setup-tokens/
        // subscriptions, CODEX_OAUTH_CREDENTIAL for openai/codex). This is the
        // ctx.llm fallback: it lets ctx.llm run off the mounted credential even
        // when no explicit provider credential was selected. Spread BEFORE
        // providerEnv so an explicit credentialSelection (resolveSelectedProviderEnv)
        // still wins for ctx.llm. Setup-token blobs additionally REQUIRE this env
        // for the harness — mountCliCredentials skips their .credentials.json mount.
        ...harnessCliCredentialMount.env,
        ...providerEnv,
        ...personaIntegrationEnv,
        ...(conversationHarnessSession
          ? {
              [WORKFORCE_HARNESS_RESUME_SESSION_ID_ENV]: conversationHarnessSession.id,
              [WORKFORCE_HARNESS_RESUME_SESSION_RESUME_ENV]: conversationHarnessSession.resume ? "1" : "0",
            }
          : {}),
        ...(input.triggerKind === "clock" && input.deliveryId
          ? { [WORKFORCE_TICK_DELIVERY_ID_ENV]: input.deliveryId }
          : {}),
      };
      for (const key of harnessCliCredentialMount.ambientEnvKeysToUnset) {
        delete envVars[key];
      }
      const mount = await mintRelayfileMountConfig({
        workspaceId: relayWorkspaceId,
        agentId: input.agentId,
        relayfilePaths,
        syncPaths,
        eventSyncPaths,
      });
      mountConfigured = Boolean(mount?.token);
      if (mount) {
        envVars.RELAYFILE_TOKEN = mount.envToken ?? mount.token;
        envVars.RELAYFILE_URL = normalizeCredentialUrl(mount.baseUrl);
        envVars.RELAYFILE_WORKSPACE_ID = mount.workspaceId;
        envVars.RELAYFILE_MOUNT_PATHS = JSON.stringify(mount.mountPaths);
      } else {
        envVars.RELAYFILE_TOKEN = "";
        envVars.RELAYFILE_URL = "";
        envVars.RELAYFILE_WORKSPACE_ID = "";
        envVars.RELAYFILE_MOUNT_PATHS = "[]";
      }

      const runEnv: Record<string, string> = {};
      if (proactiveGitWorkspace && proactiveGitWorkspaceToken) {
        runEnv[PROACTIVE_GIT_WORKSPACE_TOKEN_ENV] = proactiveGitWorkspaceToken;
      }

      let pullRequestWorkspace: PullRequestWorkspaceConfig | null = null;
      let pullRequestWritebackWorkspace: PullRequestWorkspaceConfig | null = null;
      if (pullRequestWorkspaceBase) {
        pullRequestWorkspace = {
          ...pullRequestWorkspaceBase,
          tokenEnvKey: pullRequestWritebackEnabled
            ? GITHUB_PR_WORKSPACE_TOKEN_ENV
            : null,
          mode: conflictResolveMode ? "conflictResolve" : "review",
        };
      }
      if (pullRequestWorkspaceBase && pullRequestWritebackEnabled) {
        const minted = await mintWorkflowGithubWriteToken({
          userId: input.deployedByUserId,
          workspaceId: input.workspaceId,
          repoOwner: pullRequestWorkspaceBase.owner,
          repoName: pullRequestWorkspaceBase.repo,
        });
        if (minted.repositoryScoped === false) {
          console.warn("[pr-reviewer] GitHub token is installation-scoped; enforcing phase-separated exact-repo usage", {
            repo: `${pullRequestWorkspaceBase.owner}/${pullRequestWorkspaceBase.repo}`,
            installationId: minted.installationId,
          });
        }
        pullRequestWorkspace = {
          ...pullRequestWorkspaceBase,
          tokenEnvKey: GITHUB_PR_WORKSPACE_TOKEN_ENV,
          mode: conflictResolveMode ? "conflictResolve" : "review",
        };
        pullRequestWritebackWorkspace = pullRequestWorkspace;
        runEnv[GITHUB_PR_WORKSPACE_TOKEN_ENV] = minted.token;
      }
      const prReviewerPushPolicy = await resolvePrReviewerPushPolicy({
        envelope,
        inputValues: input.inputValues,
        pullRequestWorkspace: pullRequestWorkspaceBase,
        userId: input.deployedByUserId,
        workspaceId: input.workspaceId,
      });
      return {
        invokeScript: withShellTimeout(
          buildDeploymentInvokeScript({
            envVars,
            envUnsetKeys: harnessCliCredentialMount.ambientEnvKeysToUnset,
            envelope,
            inputValues: input.inputValues,
            prReviewerPushPolicy,
            mount,
            persona: input.persona,
            agentSpec: input.agentSpec,
            pullRequestWorkspace,
            pullRequestWritebackWorkspace,
            pullRequestWarmCheckoutEnabled: pullRequestWorkspaceBase
              ? pullRequestWarmLeaseEnabled
              : false,
            proactiveGitWorkspace,
          }),
          runScriptMaxSeconds,
        ),
        runEnv,
      };
    };

    let sessionId = buildDeploymentRunSessionId(input.deploymentId);
    if (input.options?.asyncRunScript) {
      if (!runtime.startScript) {
        throw new DeploymentTriggerDeliveryError(
          "Deployment runtime does not support async run submission",
          "deployment_run_start_unsupported",
          500,
        );
      }
      const invocation = await prepareRunInvocation();
      const currentHandle = requireDeliveryHandle();
      runSandboxId = currentHandle.id;
      const started = await runtime.startScript(currentHandle, {
        command: invocation.invokeScript,
        sessionId,
        timeoutMs: ASYNC_RUN_START_REQUEST_TIMEOUT_MS,
        env: Object.keys(invocation.runEnv).length > 0 ? invocation.runEnv : undefined,
        suppressInputEcho: true,
      });
      throw new DeploymentTriggerRunPendingError({
        deploymentId: input.deploymentId,
        sandboxId: currentHandle.id,
        sessionId: started.sessionId,
        commandId: started.commandId,
        startedAt: startedAt.toISOString(),
        sandboxName,
        mountConfigured,
        envelopeJson,
      });
    }

    const shouldRetryExit137 = usesSandbox;
    for (let attempt = initialExit137Attempt; attempt <= 2; attempt += 1) {
      const invocation = await prepareRunInvocation();
      const currentHandle = requireDeliveryHandle();
      runSandboxId = currentHandle.id;
      result = await orchestrator.runScript(
        currentHandle,
        {
          command: invocation.invokeScript,
          sessionId,
          timeoutMs: input.options?.runScriptTimeoutMs ?? 120_000,
          env: Object.keys(invocation.runEnv).length > 0 ? invocation.runEnv : undefined,
        },
      );
      if (!isHarnessExit137(result) || !shouldRetryExit137) {
        break;
      }
      const retrying = attempt === 1;
      logHarnessExit137({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        agentName: exit137AgentName,
        deploymentId: input.deploymentId,
        sandboxId: currentHandle.id,
        sandboxName,
        sessionId,
        commandId: result.cmdId ?? null,
        result,
        retrying,
        attempt,
      });
      if (!retrying) {
        throw harnessExit137Error({
          agentName: exit137AgentName,
          deploymentId: input.deploymentId,
          sandboxId: currentHandle.id,
          sandboxName,
          sessionId,
          commandId: result.cmdId ?? null,
          result,
        });
      }
      const retryError = harnessExit137Error({
        agentName: exit137AgentName,
        deploymentId: input.deploymentId,
        sandboxId: currentHandle.id,
        sandboxName,
        sessionId,
        commandId: result.cmdId ?? null,
        result,
      });
      await recordExit137AttemptBeforeRetry({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        deploymentId: input.deploymentId,
        payload: input.payload,
        handle: currentHandle,
        sandboxName,
        mountConfigured,
        startedAt,
        result,
        error: retryError,
        envelopeJson,
        sessionId,
        commandId: result.cmdId ?? null,
      });
      await destroyExit137SandboxBestEffort({
        runtime,
        handle: currentHandle,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        deploymentId: input.deploymentId,
      });
      if (prWarmLeaseAcquiredForAttempt && pullRequestWorkspaceBase) {
        await releaseExit137WarmLeaseBestEffort({
          runtime,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          deploymentId: input.deploymentId,
          repoFullName: `${pullRequestWorkspaceBase.owner}/${pullRequestWorkspaceBase.repo}`,
          prNumber: pullRequestWorkspaceBase.number,
        });
      }
      if (conversationWarmLeaseAcquiredForAttempt) {
        await releaseExit137ConversationWarmLeaseBestEffort({
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          deploymentId: input.deploymentId,
          conversationKey,
        });
      }
      handle = null;
      mountConfigured = false;
      await acquireDeliverySandbox(attempt + 1);
      sessionId = buildDeploymentRunSessionId(input.deploymentId);
    }
    if (!result) {
      throw new DeploymentTriggerDeliveryError(
        "deployment run did not produce a result",
        "deployment_run_result_missing",
        500,
      );
    }
    // Treat missing exitCode as failure rather than success. Coalescing
    // `result.exitCode ?? 0` would mask a SIGKILL/timeout/SDK-shape-skew
    // response where exitCode is undefined/null — the runner could have
    // crashed and we'd silently mark the deployment successful (Devin
    // review on #929).
    // cloud#2029: even on a clean handler, a command draft that never delivered
    // must fail the run loudly. Throwing here sets runError BEFORE the `finally`
    // posts its terminal Slack/Linear replies, so an undelivered writeback can
    // never ship a "completed" reply.
    const syncCleanupOutput = result.output ?? "";
    const syncCleanupStatus = parseMountCleanupStatus(
      syncCleanupOutput,
      mountConfigured,
      extractMountLogTail(syncCleanupOutput),
      true,
    );
    if (cleanupIndicatesWritebackUndelivered(syncCleanupStatus)) {
      throw new Error(WRITEBACK_UNDELIVERED_ERROR_MESSAGE);
    }
    const syncCleanupOnlySuccessfulHandlerExit = isCleanupOnlySuccessfulHandlerExit({
      exitCode: result.exitCode,
      output: syncCleanupOutput,
      cleanupStatus: syncCleanupStatus,
      relayWorkspaceId: input.workspaceId,
      agentId: input.agentId,
      deploymentId: input.deploymentId,
      eventSource: eventSourceForPayload(input.payload),
      sandboxId: runSandboxId,
      sessionId,
      commandId: result.cmdId ?? null,
    });
    if (syncCleanupOnlySuccessfulHandlerExit) {
      logCleanupNonzeroButComplete({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        deploymentId: input.deploymentId,
        deliveryId: input.deliveryId,
        commandId: result.cmdId ?? null,
        flushExitCode: syncCleanupStatus.flushExitCode,
        killExitCode: syncCleanupStatus.killExitCode,
        phase: "sync",
      });
    }
    if (
      result.exitCode == null ||
      (
        result.exitCode !== 0 &&
        !syncCleanupOnlySuccessfulHandlerExit
      )
    ) {
      throw new Error(result.output || "runner.mjs failed");
    }
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    if (
      !(runError instanceof DeploymentTriggerRunPendingError) &&
      !(runError instanceof DeploymentSandboxProvisioningPendingError)
    ) {
      await postLinearAgentSessionTerminalWriteback({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        deploymentId: input.deploymentId,
        payload: input.payload,
        terminalStatus: runError ? "error" : "completed",
        result,
        error: runError,
        sandboxId: runSandboxId,
        sessionId: null,
        commandId: result?.cmdId ?? null,
      });
      await postSlackConversationTerminalReply({
        workspaceId: input.workspaceId,
        payload: input.payload,
        outcome: runError
          ? { kind: "failed", reason: "error" }
          : { kind: "completed", output: result?.output ?? "" },
        delivery: {
          agentId: input.agentId,
          ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
        },
      });
      await appendDeploymentRunStructuredLogsBestEffort({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        deploymentId: input.deploymentId,
        eventSource: eventSourceForPayload(input.payload),
        sandboxId: runSandboxId,
        commandId: result?.cmdId ?? null,
        output: result?.output ?? "",
      });
      const runRecordError = await recordAgentDeploymentRun({
        deploymentId: input.deploymentId,
        agentId: input.agentId,
        eventSource: eventSourceForPayload(input.payload),
        handle,
        sandboxName,
        mountConfigured,
        startedAt,
        endedAt: new Date(),
        result,
        error: runError,
        envelopeJson,
      }).then(
        () => null,
        (error) => error,
      );
      if (runRecordError) {
        console.error(
          "[persona-bundle-deploy] failed to persist deployment run output:",
          runRecordError instanceof Error ? runRecordError.message : String(runRecordError),
        );
        if (!runError) {
          throw runRecordError;
        }
      }
      if (conversationWarmLeaseAcquiredForAttempt) {
        await markConversationWarmLeaseAvailableBestEffort({
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          deploymentId: input.deploymentId,
          conversationKey,
        });
      }
    }
  }
}

export async function runDeploymentTrigger(input: {
  workspaceId: string;
  target: NonNullable<Awaited<ReturnType<typeof getAgentDeploymentTickTarget>>>;
  deploymentId: string;
  triggerKind: "inbox" | "clock";
  payload: unknown;
  deliveryId?: string;
  provisioningSandboxId?: string | null;
  options?: DeploymentTriggerDeliveryOptions;
}): Promise<void> {
  try {
    const resumed = await maybeResumeContinuation(input);
    if (resumed) {
      await markAgentDispatchResult({ agentId: input.target.agentId, error: null });
      return;
    }
    await deliverEnvelopeToSandbox({
      workspaceId: input.workspaceId,
      agentId: input.target.agentId,
      deployedName: input.target.deployedName,
      deployedByUserId: input.target.deployedByUserId,
      personaSlug: input.target.personaSlug,
      persona: input.target.spec,
      agentSpec: input.target.agentSpec,
      bundleSha256: input.target.bundleSha256,
      inputValues: input.target.inputValues,
      credentialSelections: input.target.credentialSelections,
      deploymentId: input.deploymentId,
      triggerKind: input.triggerKind,
      payload: input.payload,
      deliveryId: input.deliveryId,
      provisioningSandboxId: input.provisioningSandboxId,
      options: input.options,
    });
    await markAgentDispatchResult({ agentId: input.target.agentId, error: null });
  } catch (error) {
    if (
      error instanceof DeploymentTriggerRunPendingError ||
      error instanceof DeploymentSandboxProvisioningPendingError
    ) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    await Promise.allSettled([
      markDeploymentFailed(input.deploymentId),
      markAgentDispatchResult({ agentId: input.target.agentId, error: message }),
    ]);
    throw error;
  }
}

async function maybeResumeContinuation(input: {
  workspaceId: string;
  target: NonNullable<Awaited<ReturnType<typeof getAgentDeploymentTickTarget>>>;
  deploymentId: string;
  triggerKind: "inbox" | "clock";
  payload: unknown;
  deliveryId?: string;
  provisioningSandboxId?: string | null;
  options?: DeploymentTriggerDeliveryOptions;
}): Promise<boolean> {
  if (!isContinuationResumeEnabled()) {
    return false;
  }

  const store = new PostgresContinuationStore();
  let continuationId: string | null = null;
  let trigger: ContinuationResumeTrigger | null = null;
  const wake = continuationWakePayload({
    payload: input.payload,
  });
  if (wake) {
    continuationId = wake.continuationId;
    trigger = wake.trigger;
  } else if (input.triggerKind === "inbox") {
    const correlationKey = slackUserReplyCorrelationKeyFromPayload(input.payload);
    if (!correlationKey) {
      return false;
    }
    continuationId = await store.findByCorrelation("user_reply", correlationKey);
    if (!continuationId) {
      return false;
    }
    trigger = userReplyTrigger(input.payload);
  }
  if (!continuationId || !trigger) {
    return false;
  }

  let pendingDeliveryError:
    | DeploymentTriggerRunPendingError
    | DeploymentSandboxProvisioningPendingError
    | null = null;
  const runtime = createContinuationRuntime({
    store,
    harness: {
      runResumedTurn: async (resumeInput) => {
        try {
          await deliverEnvelopeToSandbox({
            workspaceId: input.workspaceId,
            agentId: input.target.agentId,
            deployedName: input.target.deployedName,
            deployedByUserId: input.target.deployedByUserId,
            personaSlug: input.target.personaSlug,
            persona: input.target.spec,
            agentSpec: input.target.agentSpec,
            bundleSha256: input.target.bundleSha256,
            inputValues: input.target.inputValues,
            credentialSelections: input.target.credentialSelections,
            deploymentId: input.deploymentId,
            triggerKind: input.triggerKind,
            payload: input.payload,
            deliveryId: input.deliveryId,
            resumeContext: resumeContextForInput(resumeInput),
            provisioningSandboxId: input.provisioningSandboxId,
            options: input.options,
          });
        } catch (error) {
          if (
            error instanceof DeploymentTriggerRunPendingError ||
            error instanceof DeploymentSandboxProvisioningPendingError
          ) {
            pendingDeliveryError = error;
            return completedContinuationHarnessResult(resumeInput);
          }
          throw error;
        }
        return completedContinuationHarnessResult(resumeInput);
      },
    },
  });

  try {
    await runtime.resume({
      continuationId,
      trigger,
      metadata: {
        workspaceId: input.workspaceId,
        agentId: input.target.agentId,
        deploymentId: input.deploymentId,
        triggerKind: input.triggerKind,
      },
    });
    if (pendingDeliveryError) {
      throw pendingDeliveryError;
    }
    return true;
  } catch (error) {
    if (
      error instanceof ContinuationAlreadyTerminalError ||
      error instanceof ContinuationNotFoundError
    ) {
      console.info("[continuation-resume] duplicate wake ignored", {
        continuationId,
        error: error.name,
      });
      return true;
    }
    throw error;
  }
}

async function prepareDeploymentTrigger(input: DeploymentTriggerPayload): Promise<{
  target: NonNullable<Awaited<ReturnType<typeof getAgentDeploymentTickTarget>>>;
  deploymentId: string;
  triggerKind: "inbox" | "clock";
}> {
  const target = input.target ?? await getAgentDeploymentTickTarget({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
  });
  if (!target) {
    throw new DeploymentTriggerDeliveryError("Deployment target not found", "not_found", 404);
  }
  if (target.status !== "active") {
    throw new DeploymentTriggerDeliveryError("Deployment target is not active", "inactive", 409);
  }

  const triggerKind = triggerKindForPayload(input.payload);
  const deploymentId = await createInitialAgentDeployment({
    agentId: target.agentId,
    specHash: target.specHash,
    triggerKind,
    triggerPayload: input.payload,
  });

  return { target, deploymentId, triggerKind };
}

export async function deliverDeploymentTrigger(
  input: DeploymentTriggerPayload,
): Promise<DeploymentTriggerDeliveryResult> {
  const { target, deploymentId, triggerKind } = await prepareDeploymentTrigger(input);
  await runDeploymentTrigger({
    workspaceId: input.workspaceId,
    target,
    deploymentId,
    triggerKind,
    payload: input.payload,
    deliveryId: input.deliveryId,
    provisioningSandboxId: input.provisioningSandboxId,
    options: input.options,
  });

  return {
    agentId: target.agentId,
    workspaceId: input.workspaceId,
    deploymentId,
    status: "starting",
  };
}

export async function enqueueDeploymentTrigger(
  input: DeploymentTriggerPayload & {
    waitUntil: (promise: Promise<unknown>) => void;
    onDelivered?: () => Promise<unknown>;
  },
): Promise<DeploymentTriggerDeliveryResult> {
  const { target, deploymentId, triggerKind } = await prepareDeploymentTrigger(input);
  input.waitUntil(
    runDeploymentTrigger({
      workspaceId: input.workspaceId,
      target,
      deploymentId,
      triggerKind,
      payload: input.payload,
      deliveryId: input.deliveryId,
      options: input.options,
    })
      .then(() => input.onDelivered?.())
      .catch((error) => {
        console.error(
          "[persona-bundle-deploy] background tick delivery failed:",
          error instanceof Error ? error.message : String(error),
        );
      }),
  );

  return {
    agentId: target.agentId,
    workspaceId: input.workspaceId,
    deploymentId,
    status: "starting",
  };
}
