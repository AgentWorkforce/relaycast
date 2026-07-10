import {
  assertMountedLocalRootWithinAssigned,
  assertSafeMemberWritePath,
  memberWritePath,
  pathScope,
  validateMemberRelayfileAccessScopes,
} from "@cloud/core/proactive-runtime/member-token-scope.js";
import {
  capabilityConfig,
  isTeamSolvePersona,
} from "@cloud/core/proactive-runtime/capabilities.js";
import { deploymentPersonaSpec } from "@cloud/core/proactive-runtime/agent-spec.js";
import {
  mintWorkspacePathScopedRelayfileToken,
} from "@cloud/core/relayfile/client.js";
import {
  buildCredentialBundle,
  type CredentialBundle,
} from "@cloud/core/auth/credentials.js";
import { getCliCredentials } from "@cloud/core/auth/cli-credentials.js";
import { Resource } from "sst";
import { optionalEnv, tryResourceValue } from "@/lib/env";
import { resolveRelayfileConfig } from "@/lib/relayfile";
import { mintScopedS3Credentials } from "@/lib/aws/sts-credentials";
import { isWorkerRuntime } from "@/lib/aws/runtime";
import {
  buildCloudApiWorkflowStorageCredentials,
  getWorkflowStorageBackend,
} from "@/lib/storage";
import { createApiTokenSession } from "@/lib/auth/api-token-store";
import { ensureRelayWorkspace } from "@/lib/relay-workspaces";
import { resolveOrProvisionRelayWorkspace } from "@/lib/workflows/relay-workspace";
import { readBoundRelayWorkspaceId } from "@/lib/workspaces/relay-workspace-binding";
import { resolveRelaycastUrl } from "@/lib/workspace-registry";
import { toAbsoluteAppUrl, toAppPath } from "@/lib/app-path";
import { getCloudflareContext } from "@/lib/cloudflare-context";
import { logger } from "@/lib/logger";
import { mintWorkflowGithubWriteToken } from "@/lib/integrations/github-workflow-write-token";
import type { TeamRosterMemberConfig } from "@/lib/proactive-runtime/team-roster";
import {
  createDefaultFactoryFleetEmitter,
  type FactoryFleetEmitter,
  type FactorySpawnCapability,
  type FactorySpawnInput,
  type FactorySpawnResult,
} from "@/lib/proactive-runtime/factory-fleet-emitter";

export type TeamLaunchN1Payload = Record<string, unknown>;

export type TeamLaunchN1Input = {
  workspaceId: string;
  agentId: string;
  deliveryId: string;
  payload: TeamLaunchN1Payload;
  provisioningSandboxId?: string | null;
};

export type BuildTeamLaunchPayloadInput = TeamLaunchN1Input & {
  deployedByUserId?: string | null;
  organizationId?: string | null;
  appOrigin?: string | null;
  memberConfig?: TeamRosterMemberConfig | null;
};

export type BuildLegacyTeamLaunchPayloadDeps = {
  buildCredentialBundleForLaunch?: (input: {
    workspaceId: string;
    deployedByUserId: string;
    organizationId: string;
    deliveryId: string;
    runId: string;
    workflowConfig: string;
    appOrigin?: string | null;
    assignedRoot: string;
  }) => Promise<CredentialBundle | LaunchCredentialBundle>;
};

export type BuildTeamLaunchPayloadDeps = BuildLegacyTeamLaunchPayloadDeps;

type LaunchCredentialBundle = {
  credentialBundle: CredentialBundle;
  envSecrets?: Record<string, string>;
};

type LaunchMemberOptions = {
  memberName: string;
  role: string;
  channel: string;
  assignedRoot: string;
  localRoot: string;
  workspaceId: string;
  relayfileUrl: string;
  relayAuthUrl: string;
  relayAuthApiKey?: string;
  relayfileToken?: string;
  runId: string;
  harness?: string;
  model?: string;
  credentialBundle: CredentialBundle;
  fileType: "yaml" | "typescript" | "python" | "config";
  workflowConfig?: string;
  workflowPath?: string;
  workflowFileContent?: string;
  workflowFileName?: string;
  s3CodeKey?: string;
  snapshot?: string;
  envSecrets?: Record<string, string>;
  orchestratorLibTarball?: Uint8Array;
  orchestratorLibUrl?: string;
  onSandboxCreated?: (sandboxId: string) => Promise<void> | void;
  provisioningSandboxId?: string;
  onProvisioningSandboxCreated?: (sandboxId: string) => Promise<void> | void;
};

type LaunchMemberResult = {
  memberName: string;
  role: string;
  channel: string;
  sandboxId: string;
  assignedRoot: string;
  localRoot: string;
  relayfileToken: string;
  writeScopes: string[];
};

export type TeamLaunchN1LaunchedResult = {
  status: "launched";
  workspaceId: string;
  agentId: string;
  deliveryId: string;
  memberName: string;
  role: string;
  channel: string;
  invocationId: string;
  capability: FactorySpawnCapability;
  persona: string;
  sessionRef?: string;
  sandboxId?: string | null;
  assignedRoot: string;
  localRoot?: string;
  writeScopes?: string[];
};

export type TeamLaunchN1SkippedResult = {
  status: "skipped";
  reason:
    | "disabled"
    | "launch-deps-unavailable"
    | "unsupported-event"
    | "missing-issue-root"
    | "missing-target";
  workspaceId: string;
  agentId: string;
  deliveryId: string;
};

export type TeamLaunchN1Result =
  | TeamLaunchN1LaunchedResult
  | TeamLaunchN1SkippedResult;

export type TeamLaunchMemberOptions = LaunchMemberOptions;
export type TeamLaunchMemberResult = LaunchMemberResult;

export type TeamLaunchN1Deps = {
  isEnabled?: () => boolean;
  fleet?: FactoryFleetEmitter;
  createFleetEmitter?: () => Promise<FactoryFleetEmitter>;
  buildSpawnInput?: (input: FactorySpawnInput) => FactorySpawnInput | Promise<FactorySpawnInput>;
  /**
   * Legacy sandbox launch seams. Kept in the type so older callers/tests can
   * compile while dispatchTeamLaunchN1 emits fleet spawns instead.
   */
  launchMember?: LaunchMemberFn;
  buildLaunchOptions?: (input: {
    workspaceId: string;
    agentId: string;
    deliveryId: string;
    payload: TeamLaunchN1Payload;
    assignedRoot: string;
    localRoot: string;
  }) => Promise<TeamLaunchMemberOptions>;
};

type LaunchMemberFn = (
  options: TeamLaunchMemberOptions,
) => Promise<TeamLaunchMemberResult>;

export type BuildTeamLaunchMemberOptionsInput = {
  workspaceId: string;
  agentId: string;
  deliveryId: string;
  payload: TeamLaunchN1Payload;
  assignedRoot: string;
  localRoot: string;
  memberConfig?: TeamRosterMemberConfig | null;
  provisioningSandboxId?: string | null;
  onSandboxCreated?: LaunchMemberOptions["onSandboxCreated"];
  onProvisioningSandboxCreated?: LaunchMemberOptions["onProvisioningSandboxCreated"];
};

export class TeamLaunchOptionsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamLaunchOptionsUnavailableError";
  }
}

export async function buildTeamLaunchMemberOptions(
  input: BuildTeamLaunchMemberOptionsInput,
): Promise<TeamLaunchMemberOptions> {
  assertTeamLaunchN1ReadSurface({
    assignedRoot: input.assignedRoot,
    localRoot: input.localRoot,
  });
  const assignedRoot = assertConcreteGithubIssueRoot(input.assignedRoot);
  const launchConfig = launchConfigFromPayload(input.payload);
  const relayfile = resolveRelayfileConfig();
  if (!relayfile.relayAuthApiKey) {
    throw new TeamLaunchOptionsUnavailableError(
      "teamLaunchN1 launch options unavailable: RelayAuth API key is not configured",
    );
  }

  const memberConfig = resolveMemberConfig({
    rosterConfig: input.memberConfig,
  });
  const memberName = memberConfig.memberName;
  const relayWorkspaceId = await readBoundRelayWorkspaceId(input.workspaceId);
  if (!relayWorkspaceId) {
    await logger.warn("teamLaunchN1 RelayFile workspace binding not found", {
      area: "team-launch-n1",
      diag: "relay-workspace-binding-missing",
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      deliveryId: input.deliveryId,
      assignedRoot,
    });
    throw new TeamLaunchOptionsUnavailableError(
      `teamLaunchN1 launch options unavailable: RelayFile workspace binding not found for app workspace ${input.workspaceId}`,
    );
  }
  const relayfileToken = await mintDirectMemberRelayfileToken({
    workspaceId: relayWorkspaceId,
    agentId: input.agentId,
    memberName,
    assignedRoot,
    relayAuthUrl: relayfile.relayAuthUrl,
    relayAuthApiKey: relayfile.relayAuthApiKey,
  });
  const orchestratorLibUrl = toAbsoluteAppUrl(
    resolveCloudApiUrl(),
    "/orchestrator-lib.tar.gz",
  ).toString();
  const orchestratorLibTarball = await loadOrchestratorLibTarballFromAssets(
    orchestratorLibUrl,
    input,
  );

  return {
    memberName,
    role: memberConfig.role,
    channel: memberConfig.channel,
    assignedRoot,
    localRoot: input.localRoot,
    workspaceId: input.workspaceId,
    relayfileUrl: relayfile.relayfileUrl,
    relayAuthUrl: relayfile.relayAuthUrl,
    relayAuthApiKey: relayfile.relayAuthApiKey,
    relayfileToken,
    runId: launchConfig.runId ?? input.deliveryId,
    credentialBundle: launchConfig.credentialBundle,
    fileType: launchConfig.fileType ?? "typescript",
    harness: memberConfig.harness,
    ...(memberConfig.model ? { model: memberConfig.model } : {}),
    ...(launchConfig.workflowConfig ? { workflowConfig: launchConfig.workflowConfig } : {}),
    ...(launchConfig.workflowPath ? { workflowPath: launchConfig.workflowPath } : {}),
    ...(launchConfig.workflowFileContent ? { workflowFileContent: launchConfig.workflowFileContent } : {}),
    ...(launchConfig.workflowFileName ? { workflowFileName: launchConfig.workflowFileName } : {}),
    ...(launchConfig.s3CodeKey ? { s3CodeKey: launchConfig.s3CodeKey } : {}),
    ...(launchConfig.snapshot ? { snapshot: launchConfig.snapshot } : {}),
    ...(launchConfig.envSecrets ? { envSecrets: launchConfig.envSecrets } : {}),
    orchestratorLibUrl,
    ...(orchestratorLibTarball ? { orchestratorLibTarball } : {}),
    ...(input.onSandboxCreated ? { onSandboxCreated: input.onSandboxCreated } : {}),
    ...(input.provisioningSandboxId ? { provisioningSandboxId: input.provisioningSandboxId } : {}),
    ...(input.onProvisioningSandboxCreated
      ? { onProvisioningSandboxCreated: input.onProvisioningSandboxCreated }
      : {}),
  };
}

export const launchTeamMember: LaunchMemberFn = async () => {
  throw new TeamLaunchOptionsUnavailableError(
    "teamLaunchN1 legacy Daytona launch path is disabled; fleet emitter path is required",
  );
};

const ENABLED_RESOURCE = "CloudTeamLaunchN1Enabled";
const ENABLED_ENV = "CLOUD_TEAM_LAUNCH_N1_ENABLED";
const TEST_ENABLED_ENV = "TEAM_LAUNCH_N1_TEST_MODE";
// Separate flag for the multi-member (maxMembers > 1) dispatcher leg so the
// proven N=1 path cannot be destabilized by a roster with extra rows. Default
// off: maxMembers > 1 personas keep today's teamIssue stand-down until this
// is flipped. The SST resource is intentionally NOT registered yet — flip via
// env until the go-live PR adds the infra link (documented in the PR body).
const MULTI_ENABLED_RESOURCE = "CloudTeamLaunchMultiEnabled";
const MULTI_ENABLED_ENV = "CLOUD_TEAM_LAUNCH_MULTI_ENABLED";
const MULTI_TEST_ENABLED_ENV = "TEAM_LAUNCH_MULTI_TEST_MODE";
const MEMBER_TOKEN_TTL_SECONDS = 3600;
const FALLBACK_MEMBER_NAME = "cloud-team-issue-n1";
const FALLBACK_MEMBER_ROLE = "implementer";
const FALLBACK_MEMBER_CHANNEL = "team-launch-n1-agent";
const FALLBACK_MEMBER_HARNESS = "claude";
const FALLBACK_MEMBER_MODEL = "claude-sonnet-4-6";
const MEMBER_WORKFLOW_NAME = "cloud-team-issue-n1";
// In-box run lock claimed by the workflow's first (deterministic) step.
// /tmp survives for the sandbox lifetime and is writable regardless of the
// read-only bundle materialization (#1832).
const MEMBER_RUN_LOCK_DIR = "/tmp/.team-launch-run-lock";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scopesFromRelayfileAccessToken(accessToken: string): string[] {
  if (!accessToken.startsWith("relay_pa_")) {
    throw new Error("relayfile member access token must use the relay_pa_ prefix");
  }

  const token = accessToken.slice("relay_pa_".length);
  const parts = token.split(".");
  if (parts.length < 2) {
    throw new Error("relay_pa_ token is not a JWT");
  }

  let payload: unknown;
  try {
    const payloadJson = Buffer.from(parts[1]!, "base64url").toString("utf8");
    payload = JSON.parse(payloadJson) as unknown;
  } catch (error) {
    throw new Error(
      `relay_pa_ token payload is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(payload)) {
    throw new Error("relay_pa_ token payload must be an object");
  }

  const scopes = payload.scopes;
  if (Array.isArray(scopes)) {
    return scopes.filter((scope): scope is string => typeof scope === "string");
  }

  const scope = payload.scope;
  if (typeof scope === "string") {
    return scope
      .split(/\s+/u)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return [];
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function truthyFlag(value: string | null | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "enabled";
}

function readProcessEnvString(name: string): string | undefined {
  if (typeof process === "undefined") {
    return undefined;
  }
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function isTeamLaunchN1Enabled(): boolean {
  return truthyFlag(
    tryResourceValue(ENABLED_RESOURCE) ??
      readProcessEnvString(ENABLED_ENV) ??
      readProcessEnvString(TEST_ENABLED_ENV),
  );
}

export function isTeamLaunchMultiEnabled(): boolean {
  return truthyFlag(
    tryResourceValue(MULTI_ENABLED_RESOURCE) ??
      readProcessEnvString(MULTI_ENABLED_ENV) ??
      readProcessEnvString(MULTI_TEST_ENABLED_ENV),
  );
}

/**
 * Single definition for the teamSolve member cap — the dispatcher gate and
 * the delivery drain MUST read the same persona-level resolver (the wrapped
 * `{persona, agent}` spec snapshot made raw `spec.capabilities` reads
 * silently false; see the #1649 capability-reader regression).
 */
export function teamSolveMaxMembers(spec: unknown): number | null {
  if (!isTeamSolvePersona(spec)) {
    return null;
  }
  return capabilityConfig(spec, "teamSolve").maxMembers;
}

// Fleet payload builder used by the hot delivery drain
// (`integration-watch-deliveries.ts`). It writes only fields consumed by
// `dispatchTeamLaunchN1` to shape the fleet spawn. Credential provisioning is
// owned by the fleet node, so this path must not mint Cloud API sessions,
// workflow storage credentials, Relayfile workspace credentials, or GitHub
// write tokens before emitting `spawn:*`.
export async function buildTeamLaunchPayload(
  input: BuildTeamLaunchPayloadInput,
): Promise<TeamLaunchN1Payload> {
  const assignedRoot = deriveGithubIssueAssignedRoot(input.payload);
  if (!assignedRoot) {
    return input.payload;
  }

  const memberConfig = resolveMemberConfig({
    rosterConfig: input.memberConfig,
  });
  const runId = crypto.randomUUID();

  return {
    ...input.payload,
    launchMember: {
      memberName: memberConfig.memberName,
      role: memberConfig.role,
      channel: memberConfig.channel,
      harness: memberConfig.harness,
      ...(memberConfig.model ? { model: memberConfig.model } : {}),
      runId,
    },
  };
}

export async function buildLegacyTeamLaunchPayload(
  input: BuildTeamLaunchPayloadInput,
  deps: BuildLegacyTeamLaunchPayloadDeps = {},
): Promise<TeamLaunchN1Payload> {
  const assignedRoot = deriveGithubIssueAssignedRoot(input.payload);
  if (!assignedRoot) {
    return input.payload;
  }

  const deployedByUserId = stringValue(input.deployedByUserId);
  if (!deployedByUserId) {
    throw new TeamLaunchOptionsUnavailableError(
      "teamLaunchN1 launch payload unavailable: deployedByUserId is missing",
    );
  }
  const organizationId = stringValue(input.organizationId) ?? input.workspaceId;
  const localRoot = memberLocalRootForAssignedRoot(assignedRoot);
  const memberConfig = resolveMemberConfig({
    rosterConfig: input.memberConfig,
  });
  const workflowConfig = buildMemberWorkflowConfig({
    assignedRoot,
    localRoot,
    memberConfig,
  });
  const runId = crypto.randomUUID();
  const credentials = normalizeLaunchCredentialBundle(
    await (deps.buildCredentialBundleForLaunch ?? buildDefaultLaunchCredentialBundle)({
      workspaceId: input.workspaceId,
      deployedByUserId,
      organizationId,
      deliveryId: input.deliveryId,
      runId,
      workflowConfig,
      appOrigin: input.appOrigin,
      assignedRoot,
    }),
  );

  return {
    ...input.payload,
    launchMember: {
      memberName: memberConfig.memberName,
      role: memberConfig.role,
      channel: memberConfig.channel,
      harness: memberConfig.harness,
      ...(memberConfig.model ? { model: memberConfig.model } : {}),
      runId,
      credentialBundle: credentials.credentialBundle,
      workflowConfig,
      fileType: "config",
      ...(credentials.envSecrets ? { envSecrets: credentials.envSecrets } : {}),
    },
  };
}

function normalizeLaunchCredentialBundle(
  value: CredentialBundle | LaunchCredentialBundle,
): LaunchCredentialBundle {
  if (isRecord(value) && isRecord(value.credentialBundle)) {
    return {
      credentialBundle: value.credentialBundle as unknown as CredentialBundle,
      envSecrets: recordOfStrings(value.envSecrets),
    };
  }
  return { credentialBundle: value as CredentialBundle };
}

export function deriveGithubIssueAssignedRoot(payload: TeamLaunchN1Payload): string | null {
  if (payload.provider !== "github" || payload.eventType !== "issues.labeled") {
    return null;
  }

  const paths = Array.isArray(payload.paths)
    ? payload.paths.filter((path): path is string => typeof path === "string")
    : [];
  assertNoUnsafeEventPaths(paths);
  for (const path of paths) {
    const root = githubIssueRootFromPath(path);
    if (root) return root;
  }

  const resource = isRecord(payload.resource) ? payload.resource : {};
  const issue = isRecord(resource.issue) ? resource.issue : resource;
  const repository = isRecord(resource.repository)
    ? resource.repository
    : isRecord(issue.repository)
    ? issue.repository
    : {};
  const fullName = stringValue(repository.full_name);
  const issueNumber = stringValue(issue.number ?? resource.number);
  if (!fullName || !issueNumber) {
    return null;
  }
  const parts = fullName.split("/");
  if (parts.length !== 2) {
    return null;
  }
  const owner = cleanPathSegment(parts[0] ?? "");
  const repo = cleanPathSegment(parts[1] ?? "");
  const issueId = cleanIssueId(issueNumber);
  if (!owner || !repo || !issueId) {
    return null;
  }
  return `/github/repos/${owner}/${repo}/issues/${issueId}`;
}

export function memberLocalRootForAssignedRoot(assignedRoot: string): string {
  // Fleet nodes own materialization. The proactive runtime keeps only the
  // Relayfile root contract and never chooses a provider-local mount prefix.
  return assertSafeMemberWritePath(assignedRoot);
}

export function assertTeamLaunchN1ReadSurface(input: {
  assignedRoot: string;
  localRoot: string;
}): void {
  const assignedRoot = assertSafeMemberWritePath(input.assignedRoot);
  const expectedLocalRoot = memberLocalRootForAssignedRoot(assignedRoot);
  if (input.localRoot !== expectedLocalRoot) {
    throw new Error("teamLaunchN1 localRoot must be bounded to the assigned issue root");
  }
  assertMountedLocalRootWithinAssigned([assignedRoot], [assignedRoot]);
}

export function assertExactSingleWriteScope(input: {
  assignedRoot: string;
  writeScopes: readonly string[];
}): string[] {
  const expected = pathScope(input.assignedRoot);
  const scopes = input.writeScopes.map((scope) => scope.trim());
  const writeScopes = scopes.filter((scope) => scope.startsWith("relayfile:fs:write:"));
  if (writeScopes.length !== 1 || writeScopes[0] !== expected) {
    throw new Error("teamLaunchN1 relay_pa write scope must exactly match the assigned root");
  }
  validateMemberRelayfileAccessScopes(scopes, [input.assignedRoot]);
  return [expected];
}

// Rollout / rollback (Finding A):
// This is a hard cutover from the legacy Daytona `launchMember` path to fleet
// spawn emission — but it is dormant-by-default and gated by the SAME existing
// `CLOUD_TEAM_LAUNCH_N1_ENABLED` (SST `CloudTeamLaunchN1Enabled`) flag, which is
// OFF in prod (proven by the "keeps the N=1 launch flag default-off" test).
// Flipping that flag IS the cutover; rollback is flag-off (or revert). We do not
// add a second fleet-specific flag because the existing flag already makes the
// fleet path dark-launched: with it off, `dispatchTeamLaunchN1` stands down at
// the guard below before any spawn is emitted, so the change ships inert.
export async function dispatchTeamLaunchN1(
  input: TeamLaunchN1Input,
  deps: TeamLaunchN1Deps = {},
): Promise<TeamLaunchN1Result> {
  if (!(deps.isEnabled ?? isTeamLaunchN1Enabled)()) {
    return skipped(input, "disabled");
  }

  const assignedRoot = deriveGithubIssueAssignedRoot(input.payload);
  if (!assignedRoot) {
    return skipped(input, "missing-issue-root");
  }
  const safeAssignedRoot = assertSafeMemberWritePath(assignedRoot);
  const memberConfig = resolveDispatchMemberConfig(input.payload);
  const spawnInput = buildTeamLaunchFleetSpawnInput({
    input,
    assignedRoot: safeAssignedRoot,
    memberConfig,
  });
  const fleet = deps.fleet ?? await (deps.createFleetEmitter ?? createDefaultFactoryFleetEmitter)();
  const emitted = await fleet.spawn(await (deps.buildSpawnInput ?? ((value) => value))(spawnInput));

  await logger.info("teamLaunchN1 emitted fleet spawn", {
    area: "team-launch-n1",
    diag: "fleet-spawn-emitted",
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    deliveryId: input.deliveryId,
    assignedRoot: safeAssignedRoot,
    invocationId: emitted.invocationId,
    capability: spawnInput.capability,
    persona: spawnInput.persona,
  });

  return sanitizeFleetSpawnResult({
    input,
    emitted,
    assignedRoot: safeAssignedRoot,
    memberConfig,
    capability: spawnInput.capability,
    persona: spawnInput.persona ?? memberConfig.memberName,
  });
}

function sanitizeFleetSpawnResult({
  input,
  emitted,
  assignedRoot,
  memberConfig,
  capability,
  persona,
}: {
  input: TeamLaunchN1Input;
  emitted: FactorySpawnResult;
  assignedRoot: string;
  memberConfig: ResolvedMemberConfig;
  capability: FactorySpawnCapability;
  persona: string;
}): TeamLaunchN1LaunchedResult {
  return {
    status: "launched",
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    deliveryId: input.deliveryId,
    memberName: memberConfig.memberName,
    role: memberConfig.role,
    channel: memberConfig.channel,
    invocationId: emitted.invocationId,
    capability,
    persona,
    ...(emitted.sessionRef ? { sessionRef: emitted.sessionRef } : {}),
    sandboxId: null,
    assignedRoot,
  };
}

export async function mintDirectMemberRelayfileToken(input: {
  workspaceId: string;
  agentId: string;
  memberName: string;
  assignedRoot: string;
  relayAuthUrl: string;
  relayAuthApiKey: string;
}): Promise<string> {
  const assignedRoot = assertConcreteGithubIssueRoot(input.assignedRoot);
  const expectedWriteScope = pathScope(assignedRoot);
  const token = await mintWorkspacePathScopedRelayfileToken({
    workspaceId: input.workspaceId,
    relayAuthUrl: input.relayAuthUrl,
    relayAuthApiKey: input.relayAuthApiKey,
    agentName: input.memberName,
    agentId: input.agentId,
    paths: [memberWritePath(assignedRoot)],
    scopes: [expectedWriteScope],
    ttlSeconds: MEMBER_TOKEN_TTL_SECONDS,
  });
  const decodedScopes = scopesFromRelayfileAccessToken(token);
  const writeScopes = assertExactSingleWriteScope({
    assignedRoot,
    writeScopes: decodedScopes,
  });
  if (writeScopes[0] !== expectedWriteScope) {
    throw new Error("teamLaunchN1 decoded relay_pa write scope did not byte-match requested scope");
  }
  assertTokenTtlHonored(token, MEMBER_TOKEN_TTL_SECONDS);
  return token;
}

function skipped(input: TeamLaunchN1Input, reason: TeamLaunchN1SkippedResult["reason"]): TeamLaunchN1SkippedResult {
  return {
    status: "skipped",
    reason,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    deliveryId: input.deliveryId,
  };
}

function launchConfigFromPayload(payload: TeamLaunchN1Payload): {
  runId?: string;
  credentialBundle: CredentialBundle;
  fileType?: LaunchMemberOptions["fileType"];
  workflowConfig?: string;
  workflowPath?: string;
  workflowFileContent?: string;
  workflowFileName?: string;
  s3CodeKey?: string;
  snapshot?: string;
  envSecrets?: Record<string, string>;
} {
  const rawConfig = isRecord(payload.launchMember)
    ? payload.launchMember
    : isRecord(payload.launch)
    ? payload.launch
    : null;
  if (!rawConfig) {
    throw new TeamLaunchOptionsUnavailableError(
      "teamLaunchN1 launch options unavailable: launch credentials are missing",
    );
  }
  const credentialBundle = rawConfig.credentialBundle;
  if (!isRecord(credentialBundle)) {
    throw new TeamLaunchOptionsUnavailableError(
      "teamLaunchN1 launch options unavailable: credentialBundle is missing",
    );
  }

  return {
    runId: stringValue(rawConfig.runId) ?? undefined,
    credentialBundle: credentialBundle as unknown as CredentialBundle,
    fileType: fileTypeValue(rawConfig.fileType),
    workflowConfig: stringValue(rawConfig.workflowConfig) ?? undefined,
    workflowPath: stringValue(rawConfig.workflowPath) ?? undefined,
    workflowFileContent: stringValue(rawConfig.workflowFileContent) ?? undefined,
    workflowFileName: stringValue(rawConfig.workflowFileName) ?? undefined,
    s3CodeKey: stringValue(rawConfig.s3CodeKey) ?? undefined,
    snapshot: stringValue(rawConfig.snapshot) ?? undefined,
    envSecrets: recordOfStrings(rawConfig.envSecrets),
  };
}

type ResolvedMemberConfig = {
  memberName: string;
  role: string;
  channel: string;
  harness: string;
  model?: string;
};

function configFromPersonaSpec(spec: unknown): Partial<ResolvedMemberConfig> {
  const persona = deploymentPersonaSpec(spec);
  if (!persona) {
    return {};
  }

  return {
    memberName: stringValue(persona.slug) ??
      stringValue(persona.name) ??
      stringValue(persona.id) ??
      undefined,
    role: stringValue(persona.role) ??
      capabilityConfig(persona, "teamSolve").roles[0],
    channel: stringValue(persona.channel) ?? undefined,
    harness: stringValue(persona.harness) ?? undefined,
    ...(stringValue(persona.model) ? { model: stringValue(persona.model)! } : {}),
  };
}

function resolveMemberConfig(input: {
  rosterConfig?: TeamRosterMemberConfig | null;
}): ResolvedMemberConfig {
  const rosterConfig = input.rosterConfig ?? null;
  const personaConfig = configFromPersonaSpec(rosterConfig?.personaSpec);
  const model = stringValue(rosterConfig?.model) ??
    personaConfig.model ??
    (rosterConfig ? undefined : FALLBACK_MEMBER_MODEL);
  const memberName =
    stringValue(rosterConfig?.memberName) ??
    personaConfig.memberName ??
    FALLBACK_MEMBER_NAME;

  return {
    memberName,
    role: stringValue(rosterConfig?.role) ??
      personaConfig.role ??
      FALLBACK_MEMBER_ROLE,
    channel: stringValue(rosterConfig?.channel) ??
      personaConfig.channel ??
      FALLBACK_MEMBER_CHANNEL,
    harness: stringValue(rosterConfig?.harness) ??
      personaConfig.harness ??
      FALLBACK_MEMBER_HARNESS,
    ...(model ? { model } : {}),
  };
}

function resolveDispatchMemberConfig(payload: TeamLaunchN1Payload): ResolvedMemberConfig {
  const rawConfig = isRecord(payload.launchMember)
    ? payload.launchMember
    : isRecord(payload.launch)
    ? payload.launch
    : null;
  const fallback = resolveMemberConfig({});
  if (!rawConfig) {
    return fallback;
  }

  return {
    memberName: stringValue(rawConfig.memberName) ?? fallback.memberName,
    role: stringValue(rawConfig.role) ?? fallback.role,
    channel: stringValue(rawConfig.channel) ?? fallback.channel,
    harness: stringValue(rawConfig.harness) ?? fallback.harness,
    ...(stringValue(rawConfig.model) ?? fallback.model
      ? { model: stringValue(rawConfig.model) ?? fallback.model }
      : {}),
  };
}

function buildTeamLaunchFleetSpawnInput(input: {
  input: TeamLaunchN1Input;
  assignedRoot: string;
  memberConfig: ResolvedMemberConfig;
}): FactorySpawnInput {
  const repo = githubRepoFromAssignedRoot(input.assignedRoot);
  const repoName = repo ? `${repo.owner}/${repo.name}` : undefined;
  const runId = readLaunchRunId(input.input.payload);
  return {
    name: input.memberConfig.memberName,
    capability: capabilityForHarness(input.memberConfig.harness),
    workspaceId: input.input.workspaceId,
    invocationId: teamLaunchInvocationId({
      workspaceId: input.input.workspaceId,
      agentId: input.input.agentId,
      deliveryId: input.input.deliveryId,
      memberName: input.memberConfig.memberName,
    }),
    persona: input.memberConfig.memberName,
    recipe: "single",
    ...(input.memberConfig.model ? { model: input.memberConfig.model } : {}),
    ...(repoName ? { repo: repoName } : {}),
    channel: input.memberConfig.channel,
    issue: githubIssueMetadata(input.input.payload, input.assignedRoot),
    task: buildMemberFleetTask({
      assignedRoot: input.assignedRoot,
      memberConfig: input.memberConfig,
    }),
    inputs: {
      deliveryId: input.input.deliveryId,
      agentId: input.input.agentId,
      assignedRoot: input.assignedRoot,
      role: input.memberConfig.role,
      ...(runId ? { runId } : {}),
    },
  };
}

function capabilityForHarness(harness: string): FactorySpawnCapability {
  return harness === "codex" ? "spawn:codex" : "spawn:claude";
}

function readLaunchRunId(payload: TeamLaunchN1Payload): string | undefined {
  const rawConfig = isRecord(payload.launchMember)
    ? payload.launchMember
    : isRecord(payload.launch)
    ? payload.launch
    : null;
  return stringValue(rawConfig?.runId) ?? undefined;
}

// Credential ownership on the fleet path (Findings B/C):
// The emitted `spawn:claude`/`spawn:codex` deliberately carries NO GitHub token
// and NO scoped Relayfile token. Cloud no longer mints `relay_pa` write tokens
// or `mintWorkflowGithubWriteToken` for the spawned member here. Instead — exactly
// as the sibling fleet path `factory-cloud-orchestrator.ts` does for its
// `spawn:claude` implementers/reviewers — the fleet NODE provisions the persona's
// GitHub auth and the assigned-root-scoped Relayfile write token when it
// materializes the box. The dispatcher's only write-boundary contribution is to
// (a) pin the assigned issue root in `inputs.assignedRoot` and (b) instruct the
// member, via the task prompt below, to keep all Relayfile reads/writes inside
// that root. The hard `relay_pa` single-write-scope enforcement
// (`assertExactSingleWriteScope`) is retained on the legacy seam and is the
// contract the node re-establishes per persona.
function buildMemberFleetTask(input: {
  assignedRoot: string;
  memberConfig: ResolvedMemberConfig;
}): string {
  const repo = githubRepoFromAssignedRoot(input.assignedRoot);
  const cloneTarget = repo ? `${repo.owner}/${repo.name}` : "the assigned GitHub repository";
  // PR base is derived from the assigned repo, NOT hardcoded to AgentWorkforce/cloud,
  // so an issue in any other owner/repo opens its PR against the correct base
  // (Finding E). Falls back to the gh default base when the repo can't be derived.
  const prBaseClause = repo
    ? `create the pull request with gh pr create against ${cloneTarget}`
    : `create the pull request with gh pr create`;
  return [
    `Read the assigned Relayfile issue root ${input.assignedRoot}.`,
    `Run gh auth setup-git, then gh repo clone ${cloneTarget}, check out a new branch, implement the requested change, run relevant checks, commit, git push the branch, and ${prBaseClause}.`,
    `Stay within the assigned Relayfile root ${input.assignedRoot} for Relayfile reads and writes only.`,
  ].join(" ");
}

function teamLaunchInvocationId(input: {
  workspaceId: string;
  agentId: string;
  deliveryId: string;
  memberName: string;
}): string {
  return [
    "proactive",
    sanitizeInvocationPart(input.workspaceId),
    sanitizeInvocationPart(input.agentId),
    sanitizeInvocationPart(input.deliveryId),
    sanitizeInvocationPart(input.memberName),
  ].join(":");
}

function sanitizeInvocationPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
}

function githubIssueMetadata(
  payload: TeamLaunchN1Payload,
  assignedRoot: string,
): FactorySpawnInput["issue"] {
  const resource = isRecord(payload.resource) ? payload.resource : {};
  const issue = isRecord(resource.issue) ? resource.issue : resource;
  const match = assignedRoot.match(/^\/github\/repos\/[^/]+\/[^/]+\/issues\/([^/]+)$/u);
  const key = stringValue(issue.number ?? resource.number) ??
    (match ? decodeURIComponent(match[1] ?? "") : assignedRoot);
  return {
    id: stringValue(issue.id) ?? key,
    key,
    title: stringValue(issue.title) ?? `GitHub issue ${key}`,
    path: `${assignedRoot}.json`,
  };
}

function buildMemberWorkflowConfig(input: {
  assignedRoot: string;
  localRoot: string;
  memberConfig: ResolvedMemberConfig;
}): string {
  const repo = githubRepoFromAssignedRoot(input.assignedRoot);
  const cloneTarget = repo ? `${repo.owner}/${repo.name}` : "the assigned GitHub repository";
  // Mirror the fleet task's repo-derived PR base (Finding E): never hardcode
  // AgentWorkforce/cloud, so a non-cloud issue opens its PR against its own repo.
  const prBaseClause = repo
    ? `create the pull request with gh pr create against ${cloneTarget}`
    : `create the pull request with gh pr create`;
  const agent: Record<string, unknown> = {
    name: input.memberConfig.memberName,
    cli: input.memberConfig.harness,
    preset: "worker",
    role: input.memberConfig.role,
    interactive: false,
  };
  if (input.memberConfig.model) {
    agent.constraints = { model: input.memberConfig.model };
  }
  return JSON.stringify({
    version: "1.0",
    name: MEMBER_WORKFLOW_NAME,
    swarm: {
      pattern: "pipeline",
      channel: input.memberConfig.channel,
      maxConcurrency: 1,
      timeoutMs: 3600_000,
    },
    agents: [agent],
    workflows: [
      {
        name: MEMBER_WORKFLOW_NAME,
        steps: [
          // Run lock — deterministic, not prompt-dependent. A legacy sandbox
          // exec proxy can time out long bootstraps while the dispatched
          // process keeps running in-box; the queue's retry then dispatches a SIBLING
          // bootstrap into the same sandbox. On #1820 this produced 8 member
          // runs / 8 PRs from one labeled event. `mkdir` is atomic: the first
          // workflow creates the lock and proceeds; any sibling's mkdir exits
          // non-zero, failing this step and aborting its workflow before the
          // agent step spawns. Crash-before-lock leaves no lock, so a genuine
          // retry of a never-started run still proceeds.
          {
            name: "acquire-run-lock",
            type: "deterministic",
            command: `mkdir ${MEMBER_RUN_LOCK_DIR}`,
          },
          {
            name: "implement",
            agent: input.memberConfig.memberName,
            task: [
              `Read the assigned issue mounted at ${input.localRoot}.`,
              `Run gh auth setup-git, then gh repo clone ${cloneTarget}, check out a new branch, implement the requested change, run relevant checks, commit, git push the branch, and ${prBaseClause}.`,
              `Stay within the assigned Relayfile root ${input.assignedRoot} for Relayfile reads and writes only.`,
            ].join(" "),
          },
        ],
      },
    ],
  });
}

async function buildDefaultLaunchCredentialBundle(input: {
  workspaceId: string;
  deployedByUserId: string;
  organizationId: string;
  deliveryId: string;
  runId: string;
  workflowConfig: string;
  appOrigin?: string | null;
  assignedRoot: string;
}): Promise<LaunchCredentialBundle> {
  const runId = input.runId;
  const apiUrl = resolveCloudApiUrl(input.appOrigin);
  const storageBackend = getWorkflowStorageBackend();
  const tokenSession = await createApiTokenSession({
    subjectType: "sandbox",
    userId: input.deployedByUserId,
    workspaceId: input.workspaceId,
    organizationId: input.organizationId,
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
  const s3Credentials = storageBackend === "r2"
    ? buildCloudApiWorkflowStorageCredentials({
      userId: input.deployedByUserId,
      runId,
      apiUrl,
      accessToken: tokenSession.accessToken,
      refreshToken: tokenSession.refreshToken,
    })
    : await mintScopedS3Credentials({
      userId: input.deployedByUserId,
      runId,
      roleArn: isWorkerRuntime() ? undefined : safeWorkflowStorageResource("stsRoleArn"),
      bucket: isWorkerRuntime() ? undefined : safeWorkflowStorageResource("bucketName"),
    });

  let cliCredentials = "";
  try {
    cliCredentials = await getCliCredentials(
      input.deployedByUserId,
      "anthropic",
      Resource.CredentialEncryptionKey.value,
    );
  } catch (error) {
    await logger.warn("teamLaunchN1 CLI credentials unavailable", {
      area: "team-launch-n1",
      diag: "cli-credentials-unavailable",
      workspaceId: input.workspaceId,
      deliveryId: input.deliveryId,
      userId: input.deployedByUserId,
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : undefined,
    });
    cliCredentials = "";
  }

  const resolvedRelayWorkspace = await resolveOrProvisionRelayWorkspace({
    userId: input.deployedByUserId,
    appWorkspaceId: input.workspaceId,
  });
  await ensureRelayWorkspace(resolvedRelayWorkspace.id, { ignored: [], readonly: [] });
  const githubRepo = githubRepoFromAssignedRoot(input.assignedRoot);
  const envSecrets: Record<string, string> = {};
  if (githubRepo) {
    const githubToken = await mintWorkflowGithubWriteToken({
      userId: input.deployedByUserId,
      workspaceId: input.workspaceId,
      repoOwner: githubRepo.owner,
      repoName: githubRepo.name,
    });
    envSecrets.GITHUB_TOKEN = githubToken.token;
  }

  return {
    credentialBundle: buildCredentialBundle({
      s3Credentials,
      cliCredentials,
      workspaceId: resolvedRelayWorkspace.id,
      relayApiKey: resolvedRelayWorkspace.relaycastApiKey,
      relayBaseUrl: resolveRelaycastUrl(),
      runId,
      userId: input.deployedByUserId,
      cloudApiUrl: apiUrl,
      cloudApiAccessToken: tokenSession.accessToken,
      cloudApiRefreshToken: tokenSession.refreshToken,
      cloudApiAccessTokenExpiresAt: tokenSession.accessTokenExpiresAt,
      workflowConfig: input.workflowConfig,
    }),
    ...(Object.keys(envSecrets).length > 0 ? { envSecrets } : {}),
  };
}

function resolveCloudApiUrl(appOrigin?: string | null): string {
  const origin = appOrigin?.trim()
    || optionalEnv("NEXT_PUBLIC_APP_URL")
    || optionalEnv("APP_URL")
    || optionalEnv("CLOUD_APP_URL")
    || "https://cloud.agentrelay.com";
  return toAbsoluteAppUrl(origin, "/").toString();
}

type AssetsBinding = {
  fetch(input: string | URL): Promise<Response>;
};

async function loadOrchestratorLibTarballFromAssets(
  orchestratorLibUrl: string,
  input: Pick<BuildTeamLaunchMemberOptionsInput, "workspaceId" | "agentId" | "deliveryId">,
): Promise<Uint8Array | undefined> {
  let assets: AssetsBinding | undefined;
  try {
    const env = getCloudflareContext({ async: false }).env as
      | { ASSETS?: AssetsBinding }
      | undefined;
    assets = env?.ASSETS;
  } catch {
    return undefined;
  }
  if (!assets) {
    return undefined;
  }

  try {
    const assetUrl = new URL(toAppPath("/orchestrator-lib.tar.gz"), orchestratorLibUrl);
    const res = await assets.fetch(assetUrl);
    if (!res.ok) {
      await logger.warn("teamLaunchN1 ASSETS orchestrator-lib fetch not ok", {
        area: "team-launch-n1",
        diag: "orchestrator-lib-assets-fetch-not-ok",
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        deliveryId: input.deliveryId,
        status: res.status,
      });
      return undefined;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > 1 && buf[0] === 0x1f && buf[1] === 0x8b) {
      return buf;
    }
    await logger.warn("teamLaunchN1 ASSETS orchestrator-lib body not a valid gzip", {
      area: "team-launch-n1",
      diag: "orchestrator-lib-assets-invalid-gzip",
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      deliveryId: input.deliveryId,
      sizeBytes: buf.byteLength,
    });
  } catch (error) {
    await logger.warn("teamLaunchN1 ASSETS orchestrator-lib load failed", {
      area: "team-launch-n1",
      diag: "orchestrator-lib-assets-load-failed",
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      deliveryId: input.deliveryId,
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : undefined,
    });
  }
  return undefined;
}

function safeWorkflowStorageResource(prop: "bucketName" | "stsRoleArn"): string | undefined {
  try {
    const resource = Resource.WorkflowStorage as unknown as Record<string, unknown>;
    const value = resource?.[prop];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function fileTypeValue(value: unknown): LaunchMemberOptions["fileType"] | undefined {
  return value === "yaml" || value === "typescript" || value === "python" || value === "config"
    ? value
    : undefined;
}

function recordOfStrings(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] =>
    typeof entry[1] === "string"
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function githubRepoFromAssignedRoot(assignedRoot: string): { owner: string; name: string } | null {
  const normalized = assertSafeMemberWritePath(assignedRoot);
  const match = normalized.match(/^\/github\/repos\/([^/]+)\/([^/]+)\/issues\/[^/]+$/u);
  if (!match) return null;
  const owner = match[1]?.trim();
  const name = match[2]?.trim();
  return owner && name ? { owner, name } : null;
}

function assertConcreteGithubIssueRoot(assignedRoot: string): string {
  const normalized = assertSafeMemberWritePath(assignedRoot);
  if (normalized.includes("*")) {
    throw new Error("teamLaunchN1 assigned issue root must be wildcard-free");
  }
  if (!/^\/github\/repos\/[^/]+\/[^/]+\/issues\/[^/]+$/u.test(normalized)) {
    throw new Error("teamLaunchN1 assigned root must be a concrete GitHub issue path");
  }
  return normalized;
}

function assertTokenTtlHonored(token: string, maxTtlSeconds: number): void {
  const claims = jwtPayload(token);
  const issuedAt = numericClaim(claims.iat);
  const expiresAt = numericClaim(claims.exp);
  if (issuedAt === null || expiresAt === null || expiresAt <= issuedAt) {
    throw new Error("teamLaunchN1 relay_pa token must include valid iat/exp claims");
  }
  if (expiresAt - issuedAt > maxTtlSeconds) {
    throw new Error("teamLaunchN1 relay_pa token TTL exceeded requested short TTL");
  }
}

function jwtPayload(token: string): Record<string, unknown> {
  if (!token.startsWith("relay_pa_")) {
    throw new Error("teamLaunchN1 direct member token must be relay_pa_");
  }
  const payloadPart = token.slice("relay_pa_".length).split(".")[1];
  if (!payloadPart) {
    throw new Error("teamLaunchN1 relay_pa token is not a JWT");
  }
  const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as unknown;
  if (!isRecord(payload)) {
    throw new Error("teamLaunchN1 relay_pa token payload must be an object");
  }
  return payload;
}

function numericClaim(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function githubIssueRootFromPath(path: string): string | null {
  const canonical = path.match(/^\/github\/repos\/([^/]+)\/([^/]+)\/issues\/([^/]+)/u);
  if (!canonical) return null;
  const owner = cleanPathSegment(canonical[1] ?? "");
  const repo = cleanPathSegment(canonical[2] ?? "");
  const issueId = cleanIssueId(canonical[3] ?? "");
  if (!owner || !repo || !issueId) return null;
  return `/github/repos/${owner}/${repo}/issues/${issueId}`;
}

function assertNoUnsafeEventPaths(paths: readonly string[]): void {
  for (const path of paths) {
    for (const rawSegment of path.split("/")) {
      const segment = decodePathSegment(rawSegment).trim();
      if (
        segment === ".." ||
        segment.includes("/") ||
        segment.includes("\\")
      ) {
        throw new Error("teamLaunchN1 event path contains unsafe traversal");
      }
    }
  }
}

function cleanPathSegment(value: string): string {
  const cleaned = decodePathSegment(value).trim();
  if (
    !cleaned ||
    cleaned === "*" ||
    cleaned.includes("*") ||
    cleaned.includes("/") ||
    cleaned.includes("\\")
  ) {
    return "";
  }
  return encodePathSegment(cleaned);
}

function cleanIssueId(value: string): string {
  const cleaned = decodePathSegment(value)
    .replace(/\.json$/u, "")
    .trim();
  if (!cleaned || cleaned === "_index" || cleaned.includes("*")) return "";
  if (cleaned.includes("/") || cleaned.includes("\\")) return "";
  return encodePathSegment(cleaned);
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}
