import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Daytona } from "@daytonaio/sdk";
import type { AgentPreset } from "@relayflows/core";
import { parse as parseYaml } from "yaml";
import { compileAgentPermissions } from "../permissions/compiler.js";
import { seedAgentPermissions } from "../permissions/seeder.js";
import {
  mintPathScopedRelayfileToken,
  mintRelayfileToken,
  mintScopedRelayfileToken,
} from "../relayfile/client.js";
import {
  relayfilePathTokenPaths,
  relayfilePathTokenScopes,
  relayfilePathsForIntegrations,
  relayfileScopesFromPaths,
} from "../relayfile/path-scopes.js";
import type { AgentPermissions } from "../types/permissions.js";
import type { CloudRelayYamlConfig } from "../types/workflows.js";
import { generateBootstrapScript } from "./script-generator.js";
import {
  applyDaytonaAuthEnv,
  resolveDaytonaAuthCredentials,
  type CredentialBundle,
} from "../auth/credentials.js";
import {
  resolveProxyEnvForProvider,
  resolveProxyProviderFromCredentialProvider,
} from "../auth/proxy-token.js";
import { deriveBrokerApiKey } from "../auth/broker-key.js";
import { generateWorkspaceId, isValidWorkspaceId } from "../workspace/id.js";
import { getSnapshotName } from "../config/snapshot.js";
import { LocalHttpRuntime } from "../runtime/local-http.js";
import type { RuntimeHandle, WorkflowRuntime } from "../runtime/types.js";
import {
  assertSafeMemberWritePath,
  validateMemberRelayfileAccessScopes,
} from "../proactive-runtime/member-token-scope.js";
import {
  buildInstallArtifacts,
  isHarness,
  materializeSkills,
  type PersonaSkill,
} from "@agentworkforce/persona-kit";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROAD_RELAYFILE_WORKSPACE_SCOPES = [
  "fs:read",
  "fs:write",
  "sync:read",
  "sync:trigger",
  "admin:acl",
] as const;
const RELAYFILE_WRITE_SCOPE_PREFIX = "relayfile:fs:write:";
export const SANDBOX_FALLBACK_DEPENDENCY_SPECS = [
  // Pinned EXACT (no `^`) so the box's lockfile-less `npm install` can't float
  // the AWS SDK or its transitive `@smithy/*` tree. Floating pulled
  // client-s3 >3.107x + smithy-client >4.12.13, and on the box's Node v25 the
  // newer smithy build throws "emitWarningIfUnsupportedVersion is not a
  // function" (a version skew, not a Node API gap). #2503's `^3.1004.0` was
  // insufficient because the caret re-floats on every fresh install.
  // @smithy/smithy-client must be pinned explicitly too: client-s3/sts depend
  // on it via "^4.12.13", so without an exact top-level pin the caret re-floats
  // to the broken build. Versions mirror this repo's package-lock.json
  // (known-good, CI-verified).
  "@aws-sdk/client-s3@3.1041.0",
  "@aws-sdk/client-sts@3.1037.0",
  "@aws-sdk/lib-storage@3.1037.0",
  "@smithy/smithy-client@4.12.13",
  "@agent-relay/sdk@9.1.4",
  "@agent-relay/config@9.1.4",
  "@agent-relay/credential-proxy@7.1.1",
  "@relayflows/core@1.0.1",
  "tar@^7.5.10",
  "ignore@^7.0.5",
  "@daytonaio/sdk@0.180.0",
  "drizzle-orm@^0.45.1",
  "pg@^8.16.3",
  "postgres@^3.4.9",
] as const;
const SANDBOX_FALLBACK_DEPENDENCY_INSTALL_ARGS = SANDBOX_FALLBACK_DEPENDENCY_SPECS.join(" ");

/** Resolve the monorepo root (contains the top-level package.json with workspaces). */
function findProjectRoot(): string {
  let dir = __dirname;
  while (dir !== path.dirname(dir)) {
    try {
      const pkg = JSON.parse(
        readFileSync(path.join(dir, "package.json"), "utf-8"),
      );
      if (pkg.workspaces) return dir;
    } catch {
      // no package.json here, keep searching
    }
    dir = path.dirname(dir);
  }
  // Fallback: assume lib/ is one level below root (works for both source and dist)
  return path.resolve(__dirname, "../..");
}

export interface LaunchOptions {
  credentialBundle: CredentialBundle;
  callbackUrl?: string;
  callbackToken?: string;
  runId: string;
  /** Explicit CLI harness for a directly launched member, e.g. "claude". */
  memberHarness?: string;
  /** Explicit model for a directly launched member, e.g. "claude-sonnet-4-6". */
  memberModel?: string;
  credentialProxyUrl?: string;
  credentialProxyToken?: string;
  workspaceId?: string;
  relayfileUrl?: string;
  relayAuthUrl?: string;
  relayAuthApiKey?: string;
  /** Scoped relay_pa_ token to place in the sandbox instead of a broad workspace token. */
  relayfileMemberAccess?: RelayfileMemberAccess;
  /** Remote Relayfile roots to mount in the sandbox. */
  relayfileMountPaths?: string[];
  /** Sandbox path where the code bundle is mounted and non-path launches run. Defaults to /project. */
  codeMountPath?: string;
  s3CodeKey?: string;
  paths?: PathSubmission[];
  /**
   * Repo-relative path to the workflow file inside the synced tarball
   * (e.g. `workflows/security-runtime/01-broker-runtime-execution.ts`).
   *
   * When provided alongside `s3CodeKey`, the launcher points
   * WORKFLOW_FILE at `${codeMountPath}/${workflowPath}` and skips the
   * `$HOME` upload, so sibling-relative imports like `../shared/models.ts`
   * resolve against the repo layout without needing any runtime
   * rediscovery.
   *
   * When absent (no sync-code, or CLI versions that pre-date this
   * field), the launcher falls back to uploading `workflowFileContent`
   * to `$HOME/${workflowFileName}` — same behaviour as before.
   */
  workflowPath?: string;
  fileType: "yaml" | "typescript" | "python" | "config";
  workflowConfig?: string;
  workflowFileContent?: string;
  workflowFileName?: string;
  /**
   * Override interactive mode. When omitted, derived from the workflow config:
   * true if any agent has interactive: true, role: "lead", or no explicit
   * interactive: false set (default is interactive).
   */
  interactive?: boolean;
  snapshot?: string;
  /** Caller-provided secrets injected as env vars in the sandbox (e.g. ANTHROPIC_API_KEY). */
  envSecrets?: Record<string, string>;
  /** Non-secret run metadata injected as env vars for supervisors and orchestration. */
  metadata?: Record<string, string>;
  /** Resume a prior workflow run inside the sandbox using the SDK runner. */
  resumeRunId?: string;
  /** Start execution from a named workflow step, skipping predecessors. */
  startFrom?: string;
  /** Prior run whose cached step outputs should satisfy skipped predecessors. */
  previousRunId?: string;
  /** Server secret used to derive broker API keys via HMAC.  When provided
   *  the broker inside the sandbox will listen on 0.0.0.0:9800 for remote
   *  terminal connections from the desktop app. */
  brokerSecret?: string;
  /** Relayauth identity token for scoped access during workflow run. */
  relayauthToken?: string;
  /** CLI names extracted from script workflow source (e.g. ["claude", "codex"]). */
  agentClis?: string[];
  /** Controls whether agent steps run in isolated per-step sandboxes or the orchestrator sandbox. */
  executionMode?: WorkflowExecutionMode;
  /** Raw runtime config forwarded to the sandbox for context materialization. */
  runtimeConfig?: unknown;
  /** Caller-provided workflow inputs, for example the MSD review request payload. */
  runInputs?: unknown;
  /** Observer URL returned to callers and included in shared-sandbox lifecycle events. */
  observerUrl?: string;
  /** Preloaded orchestrator-lib.tar.gz bytes from the web Worker ASSETS binding. Preferred over disk/URL lookups. */
  orchestratorLibTarball?: Uint8Array;
  /** Absolute URL to orchestrator-lib.tar.gz served as a static asset (Workers runtime, where readFileSync of public/ does not work). Tried only after the on-disk candidates miss. */
  orchestratorLibUrl?: string;
  /** Called immediately after Daytona returns a sandbox id, before setup commands run. */
  onSandboxCreated?: (sandboxId: string) => Promise<void> | void;
  /**
   * Resume setup for a Daytona sandbox whose create request already returned an
   * id but whose start was not complete yet.
   */
  provisioningSandboxId?: string;
  /** Called as soon as detached Daytona creation returns an id, before startup polling. */
  onProvisioningSandboxCreated?: (sandboxId: string) => Promise<void> | void;
  /**
   * Persona-declared skills to install into the sandbox.  Supports prpm bare
   * refs (`scope/name`), prpm.dev URLs, GitHub `#skill-name` fragments (npx
   * skills), and local `.md` paths.  Skills are installed once per sandbox
   * setup and land in `${codeMountPath}/.skills/<id>/SKILL.md` via the
   * `~/.claude/skills` symlink so they persist in the relayfile VFS.
   */
  personaSkills?: readonly PersonaSkill[];
}

export interface RelayfileMemberAccess {
  agentName: string;
  token: string;
  scopes: string[];
}

export interface PathSubmission {
  name: string;
  s3CodeKey: string;
  repoOwner?: string;
  repoName?: string;
}

export interface LaunchResult {
  sandboxId: string;
  runId: string;
  workspaceId: string;
  executionMode?: WorkflowExecutionMode;
  observerUrl?: string;
  workdir?: string;
}

export type WorkflowExecutionMode = "per-step-sandbox" | "shared-sandbox";

interface LauncherSandbox {
  id: string;
  getUserHomeDir(): Promise<string | null | undefined>;
  fs: {
    uploadFile(source: string | Buffer, destination: string): Promise<void>;
  };
  process: {
    executeCommand(
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeoutSeconds?: number,
    ): Promise<{ exitCode?: number | null; result?: string }>;
  };
}

type Sandbox = LauncherSandbox;

export class WorkflowSandboxProvisioningPendingError extends Error {
  readonly sandboxId: string;
  readonly state?: string;

  constructor(sandboxId: string, state?: string) {
    super(
      state
        ? `Workflow sandbox ${sandboxId} is still provisioning (${state})`
        : `Workflow sandbox ${sandboxId} is still provisioning`,
    );
    this.name = "WorkflowSandboxProvisioningPendingError";
    this.sandboxId = sandboxId;
    this.state = state;
  }
}

/**
 * A resume attempt referenced a provisioning sandbox id that no longer exists
 * (deleted operator-side or consumed by the org auto-reaper). Typed so callers
 * can clear their persisted id and burn a retry attempt instead of resuming a
 * dead id forever — the cross-box leg of the #1820 sibling-PR storm.
 */
export class WorkflowSandboxResumeMissingError extends Error {
  readonly sandboxId: string;

  constructor(sandboxId: string) {
    super(`Workflow provisioning sandbox ${sandboxId} was not found`);
    this.name = "WorkflowSandboxResumeMissingError";
    this.sandboxId = sandboxId;
  }
}

export interface CredentialProxyConfig {
  credentialProxyUrl?: string;
  credentialProxyToken?: string;
}

export interface WorkflowAgentAccessConfig {
  name: string;
  cli?: string;
  constraints?: {
    model?: string;
  };
  scopes?: string[];
  integrations?: Record<string, { triggers?: string[] }>;
  permissions?: AgentPermissions;
  interactive?: boolean;
  preset?: AgentPreset;
  role?: string;
}

export interface LauncherRelayfileAccessConfig {
  relayfileUrl: string;
  relayAuthUrl: string;
  relayWorkspaceId: string;
  relayAuthApiKey: string;
  workspaceToken?: string;
  memberAccess?: RelayfileMemberAccess;
  agents: WorkflowAgentAccessConfig[];
}

export interface LauncherRelayfileAccess {
  relayfileWorkspaceToken: string;
  relayfileAgentAccess: Map<string, { token: string; scopes: string[] }>;
  envToken: string;
  seededAclCount: number;
}

export interface LauncherRelayfileAccessDeps {
  mintRelayfileToken?: typeof mintRelayfileToken;
  provisionAgentAccess?: typeof provisionAgentAccess;
  seedAgentPermissions?: typeof seedAgentPermissions;
}

interface MintBroadRelayfileWorkspaceTokenConfig {
  workspaceId: string;
  relayAuthUrl: string;
  relayAuthApiKey: string;
}

interface WorkflowConfigDocument {
  agents?: WorkflowAgentAccessConfig[];
  workflows?: CloudRelayYamlConfig["workflows"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = [
    ...new Set(
      value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];

  return normalized.length > 0 ? normalized : undefined;
}

function mergeStringArrays(
  ...values: Array<string[] | undefined>
): string[] | undefined {
  const merged = [...new Set(values.flatMap((value) => value ?? []))];
  return merged.length > 0 ? merged : undefined;
}

function triggerValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }

  if (!isRecord(value)) {
    return null;
  }

  for (const key of ["on", "event", "type", "name", "trigger"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return triggerValue(value.trigger);
}

function normalizeIntegrationTriggers(value: unknown): string[] | undefined {
  const rawTriggers = isRecord(value) ? value.triggers : value;
  if (!Array.isArray(rawTriggers)) {
    return undefined;
  }

  const triggers = [
    ...new Set(
      rawTriggers
        .map((entry) => triggerValue(entry))
        .filter((entry): entry is string => entry !== null),
    ),
  ];

  return triggers.length > 0 ? triggers : undefined;
}

function normalizeWorkflowIntegrations(
  value: unknown,
): Record<string, { triggers?: string[] }> | undefined {
  const integrations = new Map<string, { triggers?: string[] }>();
  const addIntegration = (
    providerValue: unknown,
    triggersValue: unknown,
  ): void => {
    const provider =
      typeof providerValue === "string"
        ? providerValue.trim().toLowerCase()
        : "";
    if (!provider) {
      return;
    }

    const triggers = normalizeIntegrationTriggers(triggersValue);
    const existing = integrations.get(provider);
    integrations.set(provider, {
      triggers: mergeStringArrays(existing?.triggers, triggers),
    });
  };

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isRecord(entry)) {
        continue;
      }
      addIntegration(entry.provider, entry);
    }
  } else if (isRecord(value)) {
    for (const [provider, config] of Object.entries(value)) {
      addIntegration(provider, config);
    }
  }

  return integrations.size > 0 ? Object.fromEntries(integrations) : undefined;
}

function relayfileScopesForIntegrations(
  integrations?: Record<string, { triggers?: string[] }>,
): string[] | undefined {
  const scopes = relayfileScopesFromPaths(
    relayfilePathsForIntegrations(integrations),
  );
  return scopes.length > 0 ? scopes : undefined;
}

function normalizeAgentPermissions(
  value: unknown,
): AgentPermissions | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const ignored = normalizeStringArray(value.ignored);
  const readonly = normalizeStringArray(value.readonly);

  if (!ignored && !readonly) {
    return undefined;
  }

  return {
    ...(ignored ? { ignored } : {}),
    ...(readonly ? { readonly } : {}),
  };
}

function isAgentPreset(value: string): value is AgentPreset {
  return (
    value === "lead" ||
    value === "worker" ||
    value === "reviewer" ||
    value === "analyst"
  );
}

function normalizeWorkflowAgent(
  value: unknown,
): WorkflowAgentAccessConfig | null {
  if (!isRecord(value)) {
    return null;
  }

  const name = typeof value.name === "string" ? value.name.trim() : "";
  const preset = typeof value.preset === "string" ? value.preset.trim() : "";
  if (!name) {
    return null;
  }

  const integrations = normalizeWorkflowIntegrations(value.integrations);
  const constraints = normalizeWorkflowAgentConstraints(value.constraints);

  return {
    name,
    ...(typeof value.cli === "string" && value.cli.trim()
      ? { cli: value.cli.trim() }
      : {}),
    ...(constraints ? { constraints } : {}),
    scopes: mergeStringArrays(
      normalizeStringArray(value.scopes),
      relayfileScopesForIntegrations(integrations),
    ),
    ...(integrations ? { integrations } : {}),
    permissions: normalizeAgentPermissions(value.permissions),
    ...(typeof value.interactive === "boolean"
      ? { interactive: value.interactive }
      : {}),
    ...(preset && isAgentPreset(preset) ? { preset } : {}),
    ...(typeof value.role === "string" && value.role.trim()
      ? { role: value.role.trim() }
      : {}),
  };
}

function normalizeWorkflowAgentConstraints(
  value: unknown,
): WorkflowAgentAccessConfig["constraints"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const model = typeof value.model === "string" ? value.model.trim() : "";
  return model ? { model } : undefined;
}

function mergeWorkflowAgents(
  existing: WorkflowAgentAccessConfig | undefined,
  incoming: WorkflowAgentAccessConfig,
): WorkflowAgentAccessConfig {
  if (!existing) {
    return incoming;
  }

  const integrations: Record<string, { triggers?: string[] }> = {};
  for (const [provider, config] of Object.entries(
    existing.integrations ?? {},
  )) {
    integrations[provider] = { triggers: config.triggers };
  }
  for (const [provider, config] of Object.entries(
    incoming.integrations ?? {},
  )) {
    const previous = integrations[provider];
    integrations[provider] = {
      triggers: mergeStringArrays(previous?.triggers, config.triggers),
    };
  }

  return {
    ...existing,
    ...incoming,
    scopes: mergeStringArrays(existing.scopes, incoming.scopes),
    ...(Object.keys(integrations).length > 0 ? { integrations } : {}),
    permissions: {
      ...(existing.permissions ?? {}),
      ...(incoming.permissions ?? {}),
      ignored: mergeStringArrays(
        existing.permissions?.ignored,
        incoming.permissions?.ignored,
      ),
      readonly: mergeStringArrays(
        existing.permissions?.readonly,
        incoming.permissions?.readonly,
      ),
    },
  };
}

function parseWorkflowConfigDocument(
  workflowConfig?: string,
): WorkflowConfigDocument | null {
  if (!workflowConfig?.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(workflowConfig) as unknown;
    return isRecord(parsed) ? (parsed as WorkflowConfigDocument) : null;
  } catch {
    try {
      const parsed = parseYaml(workflowConfig) as unknown;
      return isRecord(parsed) ? (parsed as WorkflowConfigDocument) : null;
    } catch {
      return null;
    }
  }
}

export function collectWorkflowAgentConfigs(
  workflowConfig?: string,
): WorkflowAgentAccessConfig[] {
  const parsed = parseWorkflowConfigDocument(workflowConfig);
  if (!parsed) {
    return [];
  }

  const agents = new Map<string, WorkflowAgentAccessConfig>();
  const registerAgents = (rawAgents: unknown): void => {
    if (!Array.isArray(rawAgents)) {
      return;
    }

    for (const rawAgent of rawAgents) {
      const normalized = normalizeWorkflowAgent(rawAgent);
      if (!normalized) {
        continue;
      }
      agents.set(
        normalized.name,
        mergeWorkflowAgents(agents.get(normalized.name), normalized),
      );
    }
  };

  registerAgents(parsed.agents);
  const workflows = Array.isArray(parsed.workflows) ? parsed.workflows : [];
  for (const workflow of workflows) {
    registerAgents(workflow?.agents);
  }

  return [...agents.values()];
}

function resolveUnifiedWorkspaceId(
  requestedWorkspaceId?: string,
  bundledWorkspaceId?: string,
): string {
  const requested = requestedWorkspaceId?.trim() ?? "";
  if (isValidWorkspaceId(requested)) {
    return requested;
  }

  const bundled = bundledWorkspaceId?.trim() ?? "";
  if (isValidWorkspaceId(bundled)) {
    return bundled;
  }

  return generateWorkspaceId();
}

function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return undefined;
}

function normalizeCredentialProxyUrl(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.replace(/\/+$/, "");
}

function normalizeExecutionMode(
  value?: WorkflowExecutionMode,
): WorkflowExecutionMode {
  return value === "shared-sandbox" ? "shared-sandbox" : "per-step-sandbox";
}

function normalizeSharedSandboxTtlMinutes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 120;
  }
  return Math.max(15, Math.min(24 * 60, Math.trunc(value)));
}

function resolveLocalSandboxUrl(): string | null {
  const provider = (process.env.SANDBOX_PROVIDER ?? "").trim().toLowerCase();
  if (provider !== "local" && provider !== "local-docker") {
    return null;
  }
  const baseUrl = (
    process.env.LOCAL_SANDBOX_URL ??
    process.env.LOCAL_SANDBOX_RUNNER_URL ??
    ""
  ).trim();
  if (!baseUrl) {
    throw new Error(
      "LOCAL_SANDBOX_URL is required when SANDBOX_PROVIDER=local",
    );
  }
  return baseUrl;
}

function sandboxFromRuntimeHandle(
  runtime: WorkflowRuntime,
  handle: RuntimeHandle,
): Sandbox {
  return {
    id: handle.id,
    getUserHomeDir: async () => handle.homeDir ?? "/home/daytona",
    fs: {
      uploadFile: (source, destination) =>
        runtime.uploadFile(handle, source, destination),
    },
    process: {
      executeCommand: async (command, cwd, env, timeoutSeconds) => {
        const result = await runtime.exec(handle, command, {
          cwd,
          env,
          timeoutMs: timeoutSeconds ? timeoutSeconds * 1000 : undefined,
        });
        return {
          exitCode: result.exitCode,
          result: result.output,
        };
      },
    },
  };
}

function readSandboxState(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const raw =
    typeof record.state === "string"
      ? record.state
      : typeof record.status === "string"
        ? record.status
        : undefined;
  return raw?.trim() || undefined;
}

function normalizeSandboxState(value: string | undefined): string | null {
  return value?.trim().replace(/-/g, "_").toUpperCase() || null;
}

function isStartedSandboxState(value: string | undefined): boolean {
  const state = normalizeSandboxState(value);
  return state === "STARTED" || state === "RUNNING";
}

function isTerminalSandboxState(value: string | undefined): boolean {
  const state = normalizeSandboxState(value);
  return Boolean(
    state &&
    ["ARCHIVED", "BUILD_FAILED", "DESTROYED", "ERROR", "STOPPED"].includes(
      state,
    ),
  );
}

function isSnapshotNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const candidate = err as {
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
  };
  const status =
    typeof candidate.status === "number"
      ? candidate.status
      : typeof candidate.statusCode === "number"
        ? candidate.statusCode
        : undefined;
  if (status === 404) return true;
  const message =
    typeof candidate.message === "string"
      ? candidate.message.toLowerCase()
      : "";
  return Boolean(
    message.includes("snapshot") &&
    (message.includes("not found") ||
      message.includes("does not exist") ||
      message.includes("no such")),
  );
}

function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const candidate = err as {
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
  };
  const status =
    typeof candidate.status === "number"
      ? candidate.status
      : typeof candidate.statusCode === "number"
        ? candidate.statusCode
        : undefined;
  if (status === 404) return true;
  const message =
    typeof candidate.message === "string"
      ? candidate.message.toLowerCase()
      : "";
  return Boolean(
    message &&
    (message.includes("not found") ||
      message.includes("does not exist") ||
      message.includes("no such")),
  );
}

async function resolveStartedDaytonaSandbox(input: {
  daytona: Daytona;
  sandboxId: string;
}): Promise<Sandbox> {
  let sandbox: Sandbox;
  try {
    sandbox = (await input.daytona.get(input.sandboxId)) as Sandbox;
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new WorkflowSandboxResumeMissingError(input.sandboxId);
    }
    throw error;
  }
  const state = readSandboxState(sandbox);
  if (isStartedSandboxState(state)) {
    return sandbox;
  }
  if (isTerminalSandboxState(state)) {
    throw new Error(
      `Workflow provisioning sandbox ${input.sandboxId} reached terminal state ${state}`,
    );
  }
  throw new WorkflowSandboxProvisioningPendingError(input.sandboxId, state);
}

/**
 * True when a Daytona API error is a rate-limit / throttle response that is
 * safe to retry. The retry storm from a fleet-wide failure (e.g. the smithy
 * skew) hammers Daytona's createSandbox endpoint, which then returns
 * "ThrottlerException: Too Many Requests" (HTTP 429) and turns a transient
 * limit into a hard run failure. Treat those as retryable.
 */
export function isDaytonaThrottleError(err: unknown): boolean {
  const record = (v: unknown): Record<string, unknown> | undefined =>
    typeof v === "object" && v !== null
      ? (v as Record<string, unknown>)
      : undefined;
  const root = record(err);
  const response = record(root?.response);
  const data = record(response?.data);
  const status =
    (root?.status as number | undefined) ??
    (root?.statusCode as number | undefined) ??
    (response?.status as number | undefined);
  if (status === 429) return true;
  // Daytona's axios-based SDK wraps API errors as
  // `{ response: { data: { message } } }`; other call sites surface `{ error }`,
  // `{ message }`, or a raw Error/string. `String(err)` alone yields
  // "[object Object]" for the wrapped shapes, so probe each field explicitly.
  const haystack = [
    root?.message,
    root?.error,
    data?.message,
    data?.error,
    response?.statusText,
    typeof err === "string" ? err : undefined,
  ]
    .filter((c): c is string => typeof c === "string")
    .join(" ")
    .toLowerCase();
  return (
    haystack.includes("throttlerexception") ||
    haystack.includes("too many requests") ||
    haystack.includes("rate limit") ||
    haystack.includes("429")
  );
}

const CREATE_SANDBOX_THROTTLE_MAX_RETRIES = 4;
const CREATE_SANDBOX_THROTTLE_BASE_DELAY_MS = 1_000;

/** Exponential backoff with full jitter, capped, used only for throttle retries. */
function throttleBackoffDelayMs(attempt: number): number {
  const exp = CREATE_SANDBOX_THROTTLE_BASE_DELAY_MS * 2 ** attempt;
  const capped = Math.min(exp, 15_000);
  // Full jitter avoids a synchronized thundering-herd retry across the fleet.
  return Math.floor(Math.random() * capped);
}

export async function createDaytonaSandboxDetached(input: {
  daytona: Daytona;
  params: Record<string, unknown>;
  timeoutSeconds: number;
  onProvisioningSandboxCreated?: (sandboxId: string) => Promise<void> | void;
}): Promise<Sandbox> {
  const client = input.daytona as unknown as {
    sandboxApi?: {
      createSandbox: (
        params: Record<string, unknown>,
        organizationId?: string,
        options?: { timeout?: number },
      ) => Promise<{ data?: { id?: string; state?: string; status?: string } }>;
    };
    target?: string;
  };
  if (!client.sandboxApi?.createSandbox) {
    throw new Error("Daytona detached create API is unavailable");
  }

  const language =
    typeof input.params.language === "string" && input.params.language.trim()
      ? input.params.language.trim()
      : "python";
  const labels =
    input.params.labels && typeof input.params.labels === "object"
      ? { ...(input.params.labels as Record<string, string>) }
      : {};
  labels["code-toolbox-language"] = language;
  const createParams = { ...input.params };
  delete createParams.envVars;
  const createSandboxArgs: [
    Record<string, unknown>,
    undefined,
    { timeout: number },
  ] = [
    {
      ...createParams,
      snapshot: input.params.snapshot,
      env: input.params.envVars ?? {},
      labels,
      target: client.target,
    },
    undefined,
    { timeout: Math.min(input.timeoutSeconds, 15) * 1000 },
  ];
  let response: Awaited<
    ReturnType<NonNullable<typeof client.sandboxApi>["createSandbox"]>
  >;
  for (let attempt = 0; ; attempt++) {
    try {
      response = await client.sandboxApi.createSandbox(...createSandboxArgs);
      break;
    } catch (err) {
      if (
        !isDaytonaThrottleError(err) ||
        attempt >= CREATE_SANDBOX_THROTTLE_MAX_RETRIES
      ) {
        throw err;
      }
      const delayMs = throttleBackoffDelayMs(attempt);
      console.warn(
        `[launcher] Daytona createSandbox throttled (attempt ${attempt + 1}/${
          CREATE_SANDBOX_THROTTLE_MAX_RETRIES + 1
        }), backing off ${delayMs}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  const sandboxId = response.data?.id;
  if (!sandboxId) {
    throw new Error("Daytona createSandbox did not return a sandbox id");
  }
  await input.onProvisioningSandboxCreated?.(sandboxId);
  const state = response.data?.state ?? response.data?.status;
  if (!isStartedSandboxState(state)) {
    if (isTerminalSandboxState(state)) {
      throw new Error(
        `Workflow provisioning sandbox ${sandboxId} reached terminal state ${state}`,
      );
    }
    throw new WorkflowSandboxProvisioningPendingError(sandboxId, state);
  }
  return resolveStartedDaytonaSandbox({ daytona: input.daytona, sandboxId });
}

async function resolveOrCreateDaytonaSandbox(input: {
  daytona: Daytona;
  snapshotName: string;
  sandboxCreateOptions: Record<string, unknown>;
  provisioningSandboxId?: string;
  onSandboxCreated?: (sandboxId: string) => Promise<void> | void;
  onProvisioningSandboxCreated?: (sandboxId: string) => Promise<void> | void;
}): Promise<Sandbox> {
  if (input.provisioningSandboxId?.trim()) {
    return resolveStartedDaytonaSandbox({
      daytona: input.daytona,
      sandboxId: input.provisioningSandboxId.trim(),
    });
  }

  try {
    const sandbox = await createDaytonaSandboxDetached({
      daytona: input.daytona,
      params: {
        snapshot: input.snapshotName,
        ...input.sandboxCreateOptions,
      },
      timeoutSeconds: 120,
      onProvisioningSandboxCreated: input.onProvisioningSandboxCreated,
    });
    console.log(
      `[launcher] Created sandbox from snapshot "${input.snapshotName}"`,
    );
    return sandbox;
  } catch (snapshotErr) {
    if (
      snapshotErr instanceof WorkflowSandboxProvisioningPendingError ||
      !isSnapshotNotFoundError(snapshotErr)
    ) {
      throw snapshotErr;
    }
  }

  console.warn(
    `[launcher] Snapshot "${input.snapshotName}" not found, falling back to fresh sandbox`,
  );
  return createDaytonaSandboxDetached({
    daytona: input.daytona,
    params: {
      language: "javascript",
      ...input.sandboxCreateOptions,
    },
    timeoutSeconds: 120,
    onProvisioningSandboxCreated: input.onProvisioningSandboxCreated,
  });
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Build the MSD_REVIEW_INPUT_JSON payload the shared-sandbox bootstrap reads.
 *
 * Normalizes `runtimeConfig` and `runInputs` so the sandbox always sees a
 * record-or-null shape, regardless of caller hygiene. The route handler
 * sanitizes inputs (allowlisting + credential-key stripping), but other
 * callers (CLI tooling, tests) may pass arbitrary values and we don't want
 * `runtime.config: 42` or `inputs: ["unexpected"]` to reach the sandbox.
 *
 * - Not provided (`undefined`/`null`)         → `null`.
 * - Provided but not a plain record            → `{}`.
 * - Provided plain record                      → forwarded as-is.
 */
export function buildMsdReviewInputJson(
  executionMode: WorkflowExecutionMode,
  runtimeConfig: unknown,
  runInputs: unknown,
): string {
  return JSON.stringify({
    runtime: {
      executionMode,
      config: runtimeConfig == null ? null : readRecord(runtimeConfig),
    },
    inputs: runInputs == null ? null : readRecord(runInputs),
  });
}

export function resolveCredentialProxyConfig(
  config: CredentialProxyConfig = {},
): CredentialProxyConfig {
  const credentialProxyUrl = normalizeCredentialProxyUrl(
    firstNonEmpty(
      config.credentialProxyUrl,
      process.env.RELAY_LLM_PROXY,
      process.env.RELAY_LLM_PROXY_URL,
    ),
  );
  const credentialProxyToken = firstNonEmpty(
    config.credentialProxyToken,
    process.env.CREDENTIAL_PROXY_TOKEN,
    process.env.RELAY_LLM_PROXY_TOKEN,
  );

  return {
    ...(credentialProxyUrl ? { credentialProxyUrl } : {}),
    ...(credentialProxyToken ? { credentialProxyToken } : {}),
  };
}

export function applyCredentialProxyEnv(
  env: Record<string, string>,
  config: CredentialProxyConfig,
): void {
  const credentialProxyUrl = normalizeCredentialProxyUrl(
    config.credentialProxyUrl,
  );
  const credentialProxyToken = config.credentialProxyToken?.trim() ?? "";

  // No-op unless both url AND token are present. Two reasons:
  //   1. Without a token, redirecting SDK base URLs at the proxy would
  //      drop the agent onto an endpoint that 401s every request — worse
  //      than leaving the mounted upstream credentials alone.
  //   2. Provider-specific base URL overrides (OPENAI_BASE_URL,
  //      ANTHROPIC_BASE_URL, etc.) are written by the credentialProxyTokens
  //      loop in launchOrchestratorSandbox via resolveProxyEnvForProvider,
  //      which emits bare proxy URLs matching the credential-proxy
  //      Worker's routing convention. This function only writes the
  //      generic proxy discovery env vars.
  if (!credentialProxyUrl || !credentialProxyToken) {
    return;
  }

  env.RELAY_LLM_PROXY = credentialProxyUrl;
  env.RELAY_LLM_PROXY_URL = credentialProxyUrl;
  env.CREDENTIAL_PROXY_TOKEN = credentialProxyToken;
  env.RELAY_LLM_PROXY_TOKEN = credentialProxyToken;
}

export async function provisionAgentAccess(config: {
  workspaceId: string;
  relayfileUrl: string;
  relayAuthUrl: string;
  relayAuthApiKey: string;
  workspaceToken?: string;
  agents: Array<{
    name: string;
    scopes?: string[];
    permissions?: AgentPermissions;
  }>;
}): Promise<Map<string, { token: string; scopes: string[] }>> {
  if (!config.relayfileUrl.trim()) {
    throw new Error("relayfileUrl is required for agent access provisioning");
  }

  const agentGrants = config.agents.map((agent) => {
    const compiled = compileAgentPermissions(
      agent.name,
      agent.permissions ?? {},
      undefined,
      agent.scopes,
    );
    const pathScopes = relayfilePathTokenScopes(agent.scopes);
    const paths = relayfilePathTokenPaths(pathScopes);
    return { agent, compiled, pathScopes, paths };
  });

  const result = new Map<string, { token: string; scopes: string[] }>();
  const workspaceToken = config.workspaceToken?.trim();
  for (const grant of agentGrants) {
    const token =
      workspaceToken && grant.paths.length > 0 && grant.pathScopes.length > 0
        ? await mintPathScopedRelayfileToken({
            workspaceId: config.workspaceId,
            agentName: grant.agent.name,
            paths: grant.paths,
            scopes: grant.pathScopes,
            relayAuthUrl: config.relayAuthUrl,
            workspaceToken,
          })
        : await mintScopedRelayfileToken({
            workspaceId: config.workspaceId,
            agentName: grant.agent.name,
            relayAuthUrl: config.relayAuthUrl,
            relayAuthApiKey: config.relayAuthApiKey,
            scopes: grant.compiled.scopes,
          });

    result.set(grant.agent.name, { token, scopes: grant.compiled.scopes });
  }

  return result;
}

async function mintBroadRelayfileWorkspaceToken(
  config: MintBroadRelayfileWorkspaceTokenConfig,
): Promise<string> {
  return mintRelayfileToken({
    workspaceId: config.workspaceId,
    relayAuthUrl: config.relayAuthUrl,
    relayAuthApiKey: config.relayAuthApiKey,
    scopes: [...BROAD_RELAYFILE_WORKSPACE_SCOPES],
  });
}

export async function prepareLauncherRelayfileAccess(
  config: LauncherRelayfileAccessConfig,
  deps: LauncherRelayfileAccessDeps = {},
): Promise<LauncherRelayfileAccess> {
  const mintWorkspaceToken = deps.mintRelayfileToken ?? mintRelayfileToken;
  const provisionAccess = deps.provisionAgentAccess ?? provisionAgentAccess;
  const seedPermissions = deps.seedAgentPermissions ?? seedAgentPermissions;

  if (config.memberAccess) {
    const memberAccess = normalizeRelayfileMemberAccess(config.memberAccess);
    return {
      relayfileWorkspaceToken: "",
      relayfileAgentAccess: new Map([
        [
          memberAccess.agentName,
          {
            token: memberAccess.token,
            scopes: memberAccess.scopes,
          },
        ],
      ]),
      envToken: memberAccess.token,
      seededAclCount: 0,
    };
  }

  const relayfileWorkspaceToken =
    mintWorkspaceToken === mintRelayfileToken
      ? await mintBroadRelayfileWorkspaceToken({
          workspaceId: config.relayWorkspaceId,
          relayAuthUrl: config.relayAuthUrl,
          relayAuthApiKey: config.relayAuthApiKey,
        })
      : await mintWorkspaceToken({
          workspaceId: config.relayWorkspaceId,
          relayAuthUrl: config.relayAuthUrl,
          relayAuthApiKey: config.relayAuthApiKey,
          scopes: [...BROAD_RELAYFILE_WORKSPACE_SCOPES],
        });

  const compiledPermissions = config.agents
    .map((agent) =>
      compileAgentPermissions(
        agent.name,
        agent.permissions ?? {},
        undefined,
        agent.scopes,
      ),
    )
    .filter((compiled) => Object.keys(compiled.aclRules).length > 0);

  if (compiledPermissions.length > 0) {
    await seedPermissions(
      config.relayfileUrl,
      config.relayWorkspaceId,
      relayfileWorkspaceToken,
      compiledPermissions,
    );
    console.log(
      `[launcher] Seeded relayfile ACLs for ${compiledPermissions.length} agent(s)`,
    );
  }

  const relayfileAgentAccess = await provisionAccess({
    workspaceId: config.relayWorkspaceId,
    relayfileUrl: config.relayfileUrl,
    relayAuthUrl: config.relayAuthUrl,
    relayAuthApiKey: config.relayAuthApiKey,
    workspaceToken: config.workspaceToken,
    agents: config.agents,
  });
  console.log(
    `[launcher] Provisioned relayfile access for ${relayfileAgentAccess.size} agent(s)`,
  );

  return {
    relayfileWorkspaceToken,
    relayfileAgentAccess,
    envToken: relayfileWorkspaceToken,
    seededAclCount: compiledPermissions.length,
  };
}

function normalizeRelayfileMemberAccess(
  access: RelayfileMemberAccess,
): RelayfileMemberAccess {
  const token = access.token.trim();
  if (!token.startsWith("relay_pa_")) {
    throw new Error(
      "relayfileMemberAccess token must be a path-scoped relay_pa_ token",
    );
  }

  const scopes = access.scopes.map((scope) => scope.trim()).filter(Boolean);
  let hasNarrowWriteScope = false;
  for (const scope of scopes) {
    if (
      scope === "admin" ||
      scope.startsWith("admin:") ||
      scope === "fs:read" ||
      scope.startsWith("fs:read:") ||
      scope === "fs:write" ||
      scope.startsWith("fs:write:") ||
      scope === "fs:manage" ||
      scope.startsWith("fs:manage:") ||
      scope === "sync:trigger" ||
      scope.startsWith("relayfile:admin:") ||
      scope.startsWith("relayfile:sync:trigger") ||
      scope === "relayfile:fs:write" ||
      scope === "relayfile:fs:read" ||
      scope === "relayfile:fs:read:*" ||
      scope === "relayfile:fs:read:/*" ||
      scope === "relayfile:fs:read:/**" ||
      scope === "relayfile:fs:manage" ||
      scope.startsWith("relayfile:fs:manage:")
    ) {
      throw new Error(
        `relayfileMemberAccess scope "${scope}" is too broad for member mode`,
      );
    }
    if (scope.startsWith(RELAYFILE_WRITE_SCOPE_PREFIX)) {
      assertSafeMemberWritePath(
        scope.slice(RELAYFILE_WRITE_SCOPE_PREFIX.length),
      );
    }
    hasNarrowWriteScope ||= scope.startsWith(RELAYFILE_WRITE_SCOPE_PREFIX);
  }

  if (!hasNarrowWriteScope) {
    throw new Error(
      "relayfileMemberAccess must include at least one narrow relayfile write scope",
    );
  }

  return {
    agentName: access.agentName,
    token,
    scopes,
  };
}

function normalizeRelayfileMemberMountRoots(
  mountPaths: readonly string[] | undefined,
): string[] {
  if (!mountPaths || mountPaths.length === 0) {
    throw new Error(
      "relayfileMountPaths is required when relayfileMemberAccess is set",
    );
  }
  return [
    ...new Set(mountPaths.map((root) => assertSafeMemberWritePath(root))),
  ];
}

function deriveWorkforceSandboxRoot(input: {
  codeMountPath: string;
  memberMountRoots?: readonly string[];
}): string {
  const codeMountPath = input.codeMountPath.replace(/\/+$/u, "") || "/";
  for (const root of input.memberMountRoots ?? []) {
    const suffix = root.replace(/\/+$/u, "");
    if (suffix && suffix !== "/" && codeMountPath.endsWith(suffix)) {
      return codeMountPath.slice(0, -suffix.length).replace(/\/+$/u, "") || "/";
    }
  }
  return codeMountPath;
}

export async function launchOrchestratorSandbox(
  options: LaunchOptions,
): Promise<LaunchResult> {
  const {
    credentialBundle,
    callbackUrl,
    callbackToken,
    runId,
    workspaceId,
    relayfileUrl,
    relayAuthUrl,
    relayAuthApiKey,
    s3CodeKey,
    paths,
    fileType,
  } = options;
  const resolvedS3CodeKey = s3CodeKey ?? credentialBundle.s3CodeKey;
  const resolvedRelayfileUrl = (relayfileUrl ?? "").trim();
  if (!resolvedRelayfileUrl) {
    throw new Error(
      "RelayfileUrl is required. Set RelayfileUrl or RELAYFILE_URL in config.",
    );
  }
  const resolvedRelayAuthUrl =
    relayAuthUrl?.trim() || "https://api.relayauth.dev";
  const resolvedRelayAuthApiKey = relayAuthApiKey?.trim() ?? "";
  if (!resolvedRelayAuthApiKey && !options.relayfileMemberAccess) {
    throw new Error("relayAuthApiKey is required");
  }
  const relayWorkspaceId = resolveUnifiedWorkspaceId(
    workspaceId,
    credentialBundle.workspaceId,
  );
  const executionMode = normalizeExecutionMode(options.executionMode);
  const codeMountPath = options.codeMountPath?.trim() || "/project";
  const memberMountRoots = options.relayfileMemberAccess
    ? normalizeRelayfileMemberMountRoots(options.relayfileMountPaths)
    : undefined;
  if (options.relayfileMemberAccess && memberMountRoots) {
    validateMemberRelayfileAccessScopes(
      options.relayfileMemberAccess.scopes,
      memberMountRoots,
    );
  }

  // Derive interactive from workflow config if not explicitly set.
  // Interactive if any agent has interactive: true, role: "lead", or
  // doesn't explicitly opt out (interactive defaults to true per relay SDK).
  const interactive =
    options.interactive ??
    deriveInteractive(
      options.workflowConfig ?? credentialBundle.workflowConfig,
    );

  const localSandboxUrl = resolveLocalSandboxUrl();
  const daytonaAuth = localSandboxUrl
    ? null
    : resolveDaytonaAuthCredentials({
        apiKey: credentialBundle.daytonaApiKey,
        jwtToken: credentialBundle.daytonaJwtToken,
        organizationId: credentialBundle.daytonaOrganizationId,
      });

  const daytona = daytonaAuth ? new Daytona(daytonaAuth) : null;
  // Fail fast before sandbox creation when relayfile is unavailable.
  const healthy = await fetch(`${resolvedRelayfileUrl}/health`, {
    signal: AbortSignal.timeout(5000),
  })
    .then((response) => response.ok)
    .catch(() => false);
  if (!healthy) {
    throw new Error(`Relayfile service not healthy at ${resolvedRelayfileUrl}`);
  }

  const snapshotName = options.snapshot ?? (await getSnapshotName());
  const runtimeConfig = readRecord(options.runtimeConfig);
  const sandboxCreateOptions = {
    autoStopInterval:
      executionMode === "shared-sandbox"
        ? normalizeSharedSandboxTtlMinutes(runtimeConfig.ttlMinutes)
        : 60,
  };
  let sandbox: Sandbox;
  if (localSandboxUrl) {
    const runtime = new LocalHttpRuntime({ baseUrl: localSandboxUrl });
    const handle = await runtime.launch({
      label: "workflow-orchestrator",
      workdir: codeMountPath,
    });
    sandbox = sandboxFromRuntimeHandle(runtime, handle);
    console.log(
      `[launcher] Created local workflow sandbox via ${localSandboxUrl}`,
    );
  } else {
    if (!daytona) {
      throw new Error("Daytona runtime is unavailable");
    }
    sandbox = await resolveOrCreateDaytonaSandbox({
      daytona,
      snapshotName,
      sandboxCreateOptions,
      provisioningSandboxId: options.provisioningSandboxId,
      onSandboxCreated: options.onSandboxCreated,
      onProvisioningSandboxCreated: options.onProvisioningSandboxCreated,
    });
  }
  await options.onSandboxCreated?.(sandbox.id);

  const home = (await sandbox.getUserHomeDir()) ?? "/home/daytona";

  // Check if deps are already present (snapshot includes them)
  const depsCheck = await sandbox.process.executeCommand(
    "node -e \"for (const dep of ['@agent-relay/sdk', '@agent-relay/credential-proxy', '@relayflows/core', 'drizzle-orm', 'pg', 'postgres']) require(dep)\" 2>/dev/null",
    home,
  );
  const needsSetup = depsCheck.exitCode !== 0;

  if (needsSetup) {
    // Install runtime deps in the sandbox, then upload the compiled orchestrator lib
    const depInstall = await sandbox.process.executeCommand(
      `cd ${home} && npm init -y 2>/dev/null && npm install --legacy-peer-deps --no-audit --no-fund ${SANDBOX_FALLBACK_DEPENDENCY_INSTALL_ARGS} 2>&1`,
      home,
      undefined,
      120,
    );
    if (depInstall.exitCode !== 0) {
      const installOutput = String(depInstall.result ?? "")
        .split("\n")
        .slice(-20)
        .join("\n");
      throw new Error(`Dependency install failed: ${installOutput}`);
    }

    // Configure CLI tools: trust directories, auto-approve, skip onboarding
    await configureSandboxCLIs(sandbox, home, codeMountPath);
  } else {
    console.log("[launcher] Snapshot has deps pre-installed — skipping setup");
  }

  // Install persona-declared skills (prpm / npx skills / local) into the VFS
  // skills mount.  Runs outside needsSetup so skills are available even when
  // the sandbox boots from a snapshot that already has npm deps cached.
  if (options.personaSkills?.length) {
    await installPersonaSkills(
      sandbox,
      home,
      options.personaSkills,
      options.memberHarness ?? "claude",
    );
  }

  // Always upload the orchestrator lib — it's built from the local monorepo
  // and not included in the snapshot (which only has npm dependencies).
  await uploadLibDirectory(
    sandbox,
    home,
    options.orchestratorLibTarball,
    options.orchestratorLibUrl,
  );

  const workflowConfig =
    options.workflowConfig ?? credentialBundle.workflowConfig;
  const agents = collectWorkflowAgentConfigs(workflowConfig);
  const { relayfileAgentAccess, envToken: relayfileEnvToken } =
    await prepareLauncherRelayfileAccess({
      relayfileUrl: resolvedRelayfileUrl,
      relayAuthUrl: resolvedRelayAuthUrl,
      relayAuthApiKey: resolvedRelayAuthApiKey,
      workspaceToken: options.relayauthToken,
      relayWorkspaceId,
      memberAccess: options.relayfileMemberAccess,
      agents,
    });

  // Interactive mode: mount CLI credentials for every required provider.
  if (interactive && credentialBundle.cliCredentials) {
    const {
      mountCliCredentials,
      extractProviderCredentials,
      resolveCredentialProvider,
      resolveCredentialProviderFromCli,
    } = await import("../auth/cli-credentials.js");
    const { CLI_AUTH_CONFIG } =
      await import("@agent-relay/config/cli-auth-config");

    const seen = new Set<keyof typeof CLI_AUTH_CONFIG>();

    for (const agent of agents) {
      if (agent.cli) {
        seen.add(resolveCredentialProviderFromCli(agent.cli));
      }
    }

    if (seen.size === 0 && options.agentClis?.length) {
      for (const cli of options.agentClis) {
        seen.add(resolveCredentialProviderFromCli(cli));
      }
    }

    if (seen.size === 0) {
      try {
        const parsed = JSON.parse(credentialBundle.cliCredentials) as Record<
          string,
          unknown
        >;
        for (const key of Object.keys(parsed)) {
          if (key in CLI_AUTH_CONFIG) {
            seen.add(key as keyof typeof CLI_AUTH_CONFIG);
          }
        }
      } catch {
        // Not valid JSON — single-provider raw credential
      }
      // If bundle keys didn't match CLI_AUTH_CONFIG (e.g. single-provider
      // raw credential like {"claudeAiOauth":...}), fall back to deriving
      // the provider from the workflow config or default to anthropic.
      if (seen.size === 0) {
        seen.add(resolveCredentialProvider(workflowConfig ?? ""));
      }
    }

    for (const provider of seen) {
      const providerCredentials = extractProviderCredentials(
        credentialBundle.cliCredentials,
        provider,
      );
      await mountCliCredentials(
        sandbox as unknown as Parameters<typeof mountCliCredentials>[0],
        home,
        providerCredentials,
        provider,
      );
    }

    console.log(
      `[launcher] Mounted CLI credentials for ${seen.size} provider(s): ${[...seen].join(", ")}`,
    );
  }

  // 6. Set env from credential bundle + orchestrator settings
  const envVars = credentialsToEnv(credentialBundle, resolvedS3CodeKey, paths);
  // Anthropic setup-token (auth_type='oauth_token') credentials authenticate
  // the genuine Claude binary via CLAUDE_CODE_OAUTH_TOKEN — no
  // ~/.claude/.credentials.json mount. Detect that shape in the bundle and
  // surface the token as an env var. Legacy refreshable provider_oauth
  // ({ claudeAiOauth: ... }) yields no token here and is left untouched.
  if (credentialBundle.cliCredentials) {
    const { applyAnthropicOauthTokenEnv } =
      await import("../auth/cli-credentials.js");
    applyAnthropicOauthTokenEnv(envVars, credentialBundle.cliCredentials);
  }
  envVars.RUN_ID = runId;
  if (options.memberHarness?.trim()) {
    envVars.LAUNCH_MEMBER_HARNESS = options.memberHarness.trim();
  }
  if (options.memberModel?.trim()) {
    envVars.LAUNCH_MEMBER_MODEL = options.memberModel.trim();
  }
  envVars.WORKFLOW_EXECUTION_MODE = executionMode;
  envVars.DAYTONA_SANDBOX_ID = sandbox.id;
  envVars.SANDBOX_ID = sandbox.id;
  if (localSandboxUrl) {
    envVars.SANDBOX_PROVIDER = "local";
    envVars.LOCAL_SANDBOX_URL = localSandboxUrl;
    envVars.LOCAL_SANDBOX_RUNNER_URL = localSandboxUrl;
  }
  if (options.observerUrl?.trim()) {
    envVars.WORKFLOW_OBSERVER_URL = options.observerUrl.trim();
  }
  if (executionMode === "shared-sandbox") {
    envVars.MSD_REVIEW_INPUT_JSON = buildMsdReviewInputJson(
      executionMode,
      options.runtimeConfig,
      options.runInputs,
    );
  }
  if (daytonaAuth) {
    applyDaytonaAuthEnv(envVars, daytonaAuth);
  }
  applyCredentialProxyEnv(
    envVars,
    resolveCredentialProxyConfig({
      credentialProxyUrl: options.credentialProxyUrl,
      credentialProxyToken: options.credentialProxyToken,
    }),
  );
  envVars.AWS_REGION =
    process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
  envVars.RELAYFILE_URL = resolvedRelayfileUrl;
  envVars.RELAY_WORKSPACE_ID = relayWorkspaceId;
  envVars.RELAYFILE_WORKSPACE = relayWorkspaceId;
  envVars.RELAYFILE_WORKSPACE_ID = relayWorkspaceId;
  envVars.RELAYFILE_TOKEN =
    relayfileEnvToken ||
    (await mintBroadRelayfileWorkspaceToken({
      workspaceId: relayWorkspaceId,
      relayAuthUrl: resolvedRelayAuthUrl,
      relayAuthApiKey: resolvedRelayAuthApiKey,
    }));
  const relayfileMountPaths = memberMountRoots ?? options.relayfileMountPaths;
  if (relayfileMountPaths && relayfileMountPaths.length > 0) {
    envVars.RELAYFILE_MOUNT_PATHS = JSON.stringify(relayfileMountPaths);
  }
  if (options.relayfileMemberAccess) {
    envVars.WORKFORCE_SANDBOX_ROOT = deriveWorkforceSandboxRoot({
      codeMountPath,
      memberMountRoots,
    });
  }
  envVars.RELAY_SANDBOX_SNAPSHOT = snapshotName;
  const resolvedCallbackUrl = callbackUrl ?? credentialBundle.callbackUrl;
  const resolvedCallbackToken = callbackToken ?? credentialBundle.callbackToken;

  if (resolvedCallbackUrl) {
    envVars.CALLBACK_URL = resolvedCallbackUrl;
  }
  if (resolvedCallbackToken) {
    envVars.CALLBACK_TOKEN = resolvedCallbackToken;
  }
  if (workflowConfig) {
    envVars.WORKFLOW_CONFIG = workflowConfig;
  }
  if (options.resumeRunId) {
    envVars.RESUME_RUN_ID = options.resumeRunId;
  }
  if (options.startFrom) {
    envVars.START_FROM = options.startFrom;
  }
  if (options.previousRunId) {
    envVars.PREVIOUS_RUN_ID = options.previousRunId;
  }
  if (credentialBundle.cliCredentials) {
    envVars.CLI_CREDENTIALS = credentialBundle.cliCredentials;
  }
  if (credentialBundle.credentialProxyUrl) {
    envVars.CREDENTIAL_PROXY_URL = credentialBundle.credentialProxyUrl;
  }
  if (credentialBundle.credentialProxyTokens) {
    envVars.CREDENTIAL_PROXY_TOKENS = JSON.stringify(
      credentialBundle.credentialProxyTokens,
    );

    for (const [providerName, token] of Object.entries(
      credentialBundle.credentialProxyTokens,
    )) {
      const provider = resolveProxyProviderFromCredentialProvider(providerName);
      if (
        !provider ||
        token.length === 0 ||
        !credentialBundle.credentialProxyUrl
      ) {
        continue;
      }

      Object.assign(
        envVars,
        resolveProxyEnvForProvider(
          provider,
          credentialBundle.credentialProxyUrl,
          token,
        ),
      );
    }
  }

  // For typescript/python workflows, pick the WORKFLOW_FILE path:
  //
  //   1. `workflowPath` + sync-code: point to the in-tree copy. The file
  //      already lives at its repo location after the tarball extract, so
  //      sibling-relative imports (e.g. `../shared/models.ts`) resolve
  //      without any rediscovery hack.
  //
  //   2. Legacy fallback: upload workflowFileContent to $HOME. Used when
  //      the caller is on an older CLI that doesn't send workflowPath,
  //      or when sync-code is off (no tarball to find the file in). In
  //      that case relative imports may still break — that's the
  //      pre-existing behaviour this PR preserves for backward-compat.
  if (
    options.workflowPath &&
    (options.s3CodeKey || (options.paths && options.paths.length > 0)) &&
    options.workflowFileContent
  ) {
    if (options.paths && options.paths.length > 0) {
      envVars.WORKFLOW_FILE = resolveMultiPathWorkflowFile(
        options.workflowPath,
        options.paths,
      );
    } else {
      envVars.WORKFLOW_FILE = `${codeMountPath}/${options.workflowPath}`;
    }
  } else if (options.workflowFileContent && options.workflowFileName) {
    const remotePath = `${home}/${options.workflowFileName}`;
    await sandbox.fs.uploadFile(
      Buffer.from(options.workflowFileContent),
      remotePath,
    );
    envVars.WORKFLOW_FILE = remotePath;
  }

  if (interactive) {
    envVars.INTERACTIVE = "true";
  }

  // Enable broker HTTP API for remote terminal connections
  if (interactive && options.brokerSecret) {
    const brokerPort = "9800";
    envVars.RELAY_BROKER_API_PORT = brokerPort;
    envVars.RELAY_BROKER_API_KEY = deriveBrokerApiKey(
      options.brokerSecret,
      sandbox.id,
    );
  }

  // Inject caller-provided secrets as env vars (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY)
  if (options.envSecrets) {
    for (const [key, value] of Object.entries(options.envSecrets)) {
      if (key in envVars) {
        continue;
      }
      envVars[key] = value;
    }
  }
  if (options.metadata) {
    for (const [key, value] of Object.entries(options.metadata)) {
      if (key in envVars || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        continue;
      }
      envVars[key] = value;
    }
  }
  envVars.RELAY_AGENT_TOKENS = JSON.stringify(
    Object.fromEntries(relayfileAgentAccess),
  );

  const shellEscape = (value: string): string =>
    "'" + value.replace(/'/g, "'\\''") + "'";

  const envFile = Object.entries(envVars)
    .filter(
      ([key, value]) =>
        value.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key),
    )
    .map(([key, value]) => `export ${key}=${shellEscape(value)}`)
    .join("\n");

  await sandbox.fs.uploadFile(Buffer.from(envFile), `${home}/.bootstrap-env`);

  // 7. Generate and upload bootstrap script
  const scripts = generateBootstrapScript({
    fileType,
    codeMountPath,
    interactive,
    executionMode,
  });
  await sandbox.fs.uploadFile(
    Buffer.from(scripts.wrapper),
    `${home}/bootstrap.mjs`,
  );
  await sandbox.fs.uploadFile(
    Buffer.from(scripts.inner),
    `${home}/bootstrap-inner.mjs`,
  );

  // 8. Launch in background
  await sandbox.process.executeCommand(
    `. ${home}/.bootstrap-env && nohup node ${home}/bootstrap.mjs > ${home}/runner.log 2>&1 &`,
    home,
  );

  // 9. Return response. The bootstrap script picks brokerCwd dynamically:
  // when path mounts are configured, it runs under /home/daytona/workspace,
  // otherwise under codeMountPath (/project). Mirror that selection here so
  // the launch response and shared-sandbox metadata match the actual
  // execution directory observers will see.
  const hasPathMounts = (options.paths?.length ?? 0) > 0;
  const launchedWorkdir = hasPathMounts
    ? "/home/daytona/workspace"
    : codeMountPath;
  return {
    sandboxId: sandbox.id,
    runId,
    workspaceId: relayWorkspaceId,
    executionMode,
    observerUrl: options.observerUrl,
    workdir: launchedWorkdir,
  };
}

/** Presets that imply non-interactive (subprocess) mode. */
const NON_INTERACTIVE_PRESETS = new Set(["worker", "reviewer", "analyst"]);

/**
 * Determine whether a single agent definition is interactive.
 *
 * Resolution order:
 *   1. Explicit `interactive` flag beats everything.
 *   2. `preset: worker | reviewer | analyst` implies non-interactive.
 *   3. `role: lead` implies interactive.
 *   4. Default: interactive (relay SDK default).
 */
function agentIsInteractive(a: {
  interactive?: boolean;
  preset?: string;
  role?: string;
}): boolean {
  if (a.interactive === true) return true;
  if (a.interactive === false) return false;
  if (a.preset && NON_INTERACTIVE_PRESETS.has(a.preset)) return false;
  if (a.role === "lead") return true;
  return true; // relay SDK default
}

/**
 * Derive interactive mode from workflow config.
 * Returns true if ANY agent is interactive.
 * An empty agents array (deterministic-only workflows) defaults to true
 * so that WorkflowRunner uses its built-in broker.
 */
export function deriveInteractive(workflowConfig?: string): boolean {
  const agents = collectWorkflowAgentConfigs(workflowConfig);
  if (agents.length === 0) return true;
  return agents.some(agentIsInteractive);
}

/**
 * Multi-path workflows: pick the WORKFLOW_FILE from the path mount whose
 * `name` is the leading segment of the workflowPath. Falling back to
 * `paths[0]` unconditionally produced WORKFLOW_FILE values that pointed at a
 * non-existent file when the workflow lived in any path other than the
 * first declared mount. The fallback now logs a warning so the next agent
 * can investigate when relay-sent paths drift out of sync with workflowPath.
 */
export function resolveMultiPathWorkflowFile(
  workflowPath: string,
  paths: PathSubmission[],
): string {
  const matched = paths.find(
    (p) => workflowPath === p.name || workflowPath.startsWith(`${p.name}/`),
  );
  if (matched) {
    const relativeInPath =
      workflowPath === matched.name
        ? ""
        : workflowPath.slice(matched.name.length + 1);
    return relativeInPath
      ? `/home/daytona/workspace/${matched.name}/${relativeInPath}`
      : `/home/daytona/workspace/${matched.name}`;
  }
  console.warn(
    `[launcher] workflowPath "${workflowPath}" did not match any declared paths[].name; ` +
      `falling back to paths[0] (${paths[0].name}). Verify the relay ` +
      `is sending workflowPath relative to the correct repo root.`,
  );
  return `/home/daytona/workspace/${paths[0].name}/${workflowPath}`;
}

export function pathsToEnvValue(paths?: PathSubmission[]): string {
  if (!paths || paths.length === 0) {
    return "";
  }
  return JSON.stringify(
    paths.map((entry) => ({
      name: entry.name,
      s3CodeKey: entry.s3CodeKey,
      ...(entry.repoOwner ? { repoOwner: entry.repoOwner } : {}),
      ...(entry.repoName ? { repoName: entry.repoName } : {}),
    })),
  );
}

function credentialsToEnv(
  bundle: CredentialBundle,
  s3CodeKey?: string,
  paths?: PathSubmission[],
): Record<string, string> {
  return {
    WORKFLOW_STORAGE_BACKEND: bundle.s3Credentials.backend ?? "s3",
    WORKFLOW_STORAGE_CLOUD_API_URL:
      bundle.s3Credentials.cloudApiUrl ?? bundle.cloudApiUrl ?? "",
    WORKFLOW_STORAGE_CLOUD_API_ACCESS_TOKEN:
      bundle.s3Credentials.cloudApiAccessToken ??
      bundle.cloudApiAccessToken ??
      "",
    S3_ACCESS_KEY_ID: bundle.s3Credentials.accessKeyId,
    S3_SECRET_ACCESS_KEY: bundle.s3Credentials.secretAccessKey,
    S3_SESSION_TOKEN: bundle.s3Credentials.sessionToken,
    S3_BUCKET: bundle.s3Credentials.bucket,
    S3_PREFIX: bundle.s3Credentials.prefix,
    S3_CODE_KEY: s3CodeKey ?? "",
    S3_PATHS: pathsToEnvValue(paths),
    RELAY_API_KEY: bundle.relayApiKey,
    RELAY_BASE_URL: bundle.relayBaseUrl,
    RELAY_WORKSPACE_ID: bundle.workspaceId,
    RUN_ID: bundle.runId,
    USER_ID: bundle.userId,
    CLOUD_API_URL: bundle.cloudApiUrl ?? "",
    CLOUD_API_ACCESS_TOKEN: bundle.cloudApiAccessToken ?? "",
    CLOUD_API_REFRESH_TOKEN:
      bundle.s3Credentials.cloudApiRefreshToken ??
      bundle.cloudApiRefreshToken ??
      "",
    CLOUD_API_ACCESS_TOKEN_EXPIRES_AT:
      bundle.cloudApiAccessTokenExpiresAt ?? "",
    CREDENTIAL_PROXY_URL: bundle.credentialProxyUrl ?? "",
    CREDENTIAL_PROXY_TOKENS: bundle.credentialProxyTokens
      ? JSON.stringify(bundle.credentialProxyTokens)
      : "",
  };
}

/**
 * Configure all CLI tools in the sandbox: trust directories, auto-approve,
 * skip onboarding prompts. Called once per sandbox creation.
 */
async function configureSandboxCLIs(
  sandbox: Sandbox,
  home: string,
  codeMountPath: string,
): Promise<void> {
  const trustedDirs = [home, "/project", `${home}/workspace`];

  // Codex: trust working directories to skip "Do you trust this directory?" prompt
  const codexConfig =
    [
      'approval_policy = "never"',
      "",
      "[projects]",
      ...trustedDirs.map((d) => `"${d}" = { trust_level = "trusted" }`),
    ].join("\n") + "\n";
  await sandbox.process.executeCommand(`mkdir -p ${home}/.codex`);
  await sandbox.fs.uploadFile(
    Buffer.from(codexConfig),
    `${home}/.codex/config.toml`,
  );

  // Claude: skip onboarding, auto-approve tools, trust directories
  const claudeSettings = JSON.stringify(
    {
      permissions: {
        allow: [
          "Read",
          "Edit",
          "Write",
          "Bash",
          "Glob",
          "Grep",
          "Task",
          "WebFetch",
          "WebSearch",
          "NotebookEdit",
          "TodoWrite",
          "mcp__relaycast__*",
        ],
        deny: [],
      },
      autoApproveApiRequest: true,
    },
    null,
    2,
  );
  await sandbox.process.executeCommand(`mkdir -p ${home}/.claude`);
  await sandbox.fs.uploadFile(
    Buffer.from(claudeSettings),
    `${home}/.claude/settings.json`,
  );

  // Symlink ~/.claude/skills and ~/.agents/skills to the relayfile VFS .skills
  // directory so workspace-layout, writeback-as-files, and any future runtime
  // skill files are available to Claude Code and opencode without a prpm fetch.
  // The mount daemon populates ${codeMountPath}/.skills/ from the DO at runtime.
  const skillsMount = `${codeMountPath}/.skills`;
  await sandbox.process.executeCommand(
    `mkdir -p ${home}/.agents && rm -rf ${home}/.claude/skills ${home}/.agents/skills && ln -s ${skillsMount} ${home}/.claude/skills && ln -s ${skillsMount} ${home}/.agents/skills`,
  );

  const claudeConfig = JSON.stringify({
    hasCompletedOnboarding: true,
    firstStartTime: new Date().toISOString(),
  });
  await sandbox.fs.uploadFile(
    Buffer.from(claudeConfig),
    `${home}/.claude.json`,
  );
}

/**
 * Install persona-declared skills into the sandbox.
 *
 * Supports all three source kinds from @agentworkforce/persona-kit:
 *   - prpm    — bare `scope/name` or https://prpm.dev/... URL → `npx prpm install`
 *   - skill.sh — GitHub `org/repo#skill-name` fragment URL    → `npx skills add`
 *   - local   — repo-relative `.md` path                      → cp into skills dir
 *
 * Skills land at `${codeMountPath}/.skills/<id>/SKILL.md` via the
 * `~/.claude/skills → ${codeMountPath}/.skills` symlink set up by
 * configureSandboxCLIs.  Because that path is inside the relayfile VFS mount
 * the files persist across sandbox restarts — subsequent runs read from the
 * mount with zero download latency.
 */
async function installPersonaSkills(
  sandbox: Sandbox,
  home: string,
  skills: readonly PersonaSkill[],
  harness: string,
): Promise<void> {
  if (skills.length === 0) return;
  const resolvedHarness = isHarness(harness) ? harness : "claude";
  const plan = materializeSkills(skills, resolvedHarness);
  const { installCommandString } = buildInstallArtifacts(plan);
  const result = await sandbox.process.executeCommand(
    `cd ${home} && ${installCommandString}`,
    home,
    undefined,
    120,
  );
  if (result.exitCode !== 0) {
    // Log but don't throw — a missing optional skill should not prevent the
    // agent from running; the harness will just not have that skill loaded.
    console.warn(`[launcher] persona skill install exited ${result.exitCode}: ${result.result}`);
  }
}

export async function uploadLibDirectory(
  sandbox: Sandbox,
  home: string,
  orchestratorLibTarball?: Uint8Array,
  orchestratorLibUrl?: string,
): Promise<void> {
  // The bootstrap script imports from ./lib/... with .js extensions.
  // The pre-built tarball is placed in public/orchestrator-lib.tar.gz at build time
  // and ships with the Lambda bundle. Find it relative to known paths.
  const candidates = [
    path.join(
      findProjectRoot(),
      "packages",
      "web",
      "public",
      "orchestrator-lib.tar.gz",
    ),
    path.join(findProjectRoot(), "public", "orchestrator-lib.tar.gz"),
    path.resolve(
      __dirname,
      "..",
      "..",
      "..",
      "web",
      "public",
      "orchestrator-lib.tar.gz",
    ),
    // Lambda bundle: /var/task/packages/web/.next/static or similar
    "/var/task/packages/web/public/orchestrator-lib.tar.gz",
  ];

  let tarBuf: Buffer | null = null;
  let source = "";
  if (orchestratorLibTarball !== undefined) {
    tarBuf = Buffer.from(orchestratorLibTarball);
    source = "provided bytes";
  } else {
    for (const candidate of candidates) {
      try {
        tarBuf = readFileSync(candidate);
        source = `filesystem:${candidate}`;
        break;
      } catch {
        // try next
      }
    }
  }

  if (!tarBuf && orchestratorLibUrl) {
    const res = await fetch(orchestratorLibUrl);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch orchestrator-lib.tar.gz from ${orchestratorLibUrl}: ${res.status} ${res.statusText}`,
      );
    }
    tarBuf = Buffer.from(await res.arrayBuffer());
    source = `fetch:${orchestratorLibUrl}`;
  }

  if (!tarBuf) {
    throw new Error(
      `Could not find orchestrator-lib.tar.gz. Searched: ${candidates.join(", ")} ` +
        `(also tried fetch: ${orchestratorLibUrl ?? "<none>"})`,
    );
  }

  console.log(`[launcher] Using orchestrator-lib.tar.gz from ${source}`);
  await sandbox.fs.uploadFile(tarBuf, `${home}/orchestrator-lib.tar.gz`);

  const extract = await sandbox.process.executeCommand(
    `cd ${home} && tar xzf orchestrator-lib.tar.gz && rm orchestrator-lib.tar.gz`,
    home,
  );
  if (extract.exitCode !== 0) {
    throw new Error(`Lib directory extraction failed: ${extract.result}`);
  }
}
