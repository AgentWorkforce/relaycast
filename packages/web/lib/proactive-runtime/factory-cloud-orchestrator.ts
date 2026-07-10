import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { tryResourceValue } from "@/lib/env";
import { agents, personas, teamEvents, teamMembers, teams } from "@/lib/db/schema";
import {
  executeRelayfileProviderWriteback,
  type RelayfileWritebackExecutionResult,
} from "@/lib/integrations/relayfile-writeback-bridge";
import { logger } from "@/lib/logger";
import {
  createDefaultFactoryFleetEmitter,
  spawnCapabilityForCli,
  type FactoryFleetEmitter,
  type FactorySpawnCapability,
  type FactorySpawnInput,
} from "@/lib/proactive-runtime/factory-fleet-emitter";
import {
  createFactoryStateStore,
  type FactoryInFlightRecord,
  type FactorySpawnTerminalStatus,
  type FactoryStateStore,
  type FactoryWritebackRecord,
} from "@/lib/proactive-runtime/factory-state-store-do";

type FactoryRecipe = "single" | "workflow" | "team";

type LinearIssueForFactory = {
  id: string;
  key: string;
  title: string;
  description: string;
  labels: string[];
  stateName?: string;
  stateId?: string;
  team?: string;
  project?: string;
  path: string;
  raw: Record<string, unknown>;
};

export type FactoryBrainDeliveryInput = {
  workspaceId: string;
  agentId: string;
  deliveryId: string;
  payload: Record<string, unknown>;
  deployedByUserId?: string | null;
};

export type FactoryBrainDeliveryResult = {
  issueKey: string;
  recipe: FactoryRecipe;
  emitted: number;
  invocationIds: string[];
};

export type FactoryBrainDeps = {
  fleet?: FactoryFleetEmitter;
  stateStore?: FactoryStateStore;
  now?: () => Date;
};

export type FactoryInvocationCompletionInput = {
  workspaceId: string;
  invocationId: string;
  status: FactorySpawnTerminalStatus;
  output?: string;
  error?: string;
  completedAt?: string;
};

export type FactoryCompletionWriteback = {
  postLinear(input: {
    record: FactoryInFlightRecord;
    message: string;
  }): Promise<void>;
  postSlack?(input: {
    record: FactoryInFlightRecord;
    message: string;
  }): Promise<void>;
};

export type FactoryInvocationCompletionDeps = {
  stateStore?: FactoryStateStore;
  now?: () => Date;
  writeback?: Partial<FactoryCompletionWriteback>;
};

export type FactoryInvocationCompletionResult =
  | {
      status: "not_found";
      invocationId: string;
    }
  | {
      status: "updated" | "all_terminal";
      invocationId: string;
      issueKey: string;
      mergeGate?: FactoryInFlightRecord["mergeGate"];
      linearWriteback?: FactoryWritebackRecord;
      slackWriteback?: FactoryWritebackRecord;
    };

const FACTORY_MARKER = "factoryBrain";
const FACTORY_LABEL = "factory";
const FACTORY_TITLE_PREFIX = "[factory]";
// Dormant-flip gate for the cloud factory brain dispatch path. Default OFF so
// matching a `[factory]` Linear issue does NOT divert a teamSolve/factory
// persona into the live fleet emitter until an operator flips this. Mirrors the
// team-launch flags (`CloudTeamLaunchN1Enabled` / `CloudTeamLaunchMultiEnabled`):
// the SST resource is registered and default-seeded to false. Rollback = clear
// the flag; no code revert is needed.
const FACTORY_BRAIN_ENABLED_RESOURCE = "CloudFactoryBrainEnabled";
const FACTORY_BRAIN_ENABLED_ENV = "CLOUD_FACTORY_BRAIN_ENABLED";
const FACTORY_BRAIN_TEST_ENABLED_ENV = "FACTORY_BRAIN_TEST_MODE";
const REPO_LABELS = new Set([
  "cloud",
  "relay",
  "relayfile",
  "pear",
  "agents",
  "factory",
]);

export function markFactoryBrainPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return { ...payload, [FACTORY_MARKER]: true };
}

export function isFactoryBrainPayload(payload: Record<string, unknown>): boolean {
  return payload[FACTORY_MARKER] === true;
}

export function isFactoryIssuePayload(payload: Record<string, unknown>): boolean {
  const issue = parseLinearIssueFromPayload(payload);
  return Boolean(issue && isFactoryIssue(issue));
}

export function isFactoryBrainCandidateSpec(spec: unknown): boolean {
  const record = unwrapSpecRecord(spec);
  const id = readString(record.id) ?? readString(record.slug) ?? readString(record.name);
  const capabilities = asRecord(record.capabilities);
  const factoryBrain = asRecord(capabilities?.factoryBrain);
  const teamSolve = asRecord(capabilities?.teamSolve);
  return Boolean(
    factoryBrain?.enabled === true ||
    teamSolve?.enabled === true ||
    id?.includes("factory") ||
    id?.includes("cloud-team-issue"),
  );
}

/**
 * Dormant-flip gate for the factory-brain dispatch arm. Reads the SST resource
 * first (deployed worker), then the env vars (local/staging/test). Default OFF.
 */
export function isFactoryBrainEnabled(): boolean {
  return truthyFlag(
    tryResourceValue(FACTORY_BRAIN_ENABLED_RESOURCE) ??
      readProcessEnvString(FACTORY_BRAIN_ENABLED_ENV) ??
      readProcessEnvString(FACTORY_BRAIN_TEST_ENABLED_ENV),
  );
}

export async function ingestFactoryInvocationCompletion(
  input: FactoryInvocationCompletionInput,
  deps: FactoryInvocationCompletionDeps = {},
): Promise<FactoryInvocationCompletionResult> {
  const stateStore = deps.stateStore ?? createFactoryStateStore();
  const records = await stateStore.listInFlight(input.workspaceId);
  const record = records.find((candidate) =>
    candidate.spawns.some((spawn) => spawn.invocationId === input.invocationId),
  );
  if (!record) {
    await logger.warn("Factory invocation completion did not match an in-flight record", {
      area: "factory-cloud-brain",
      diag: "completion-not-found",
      workspaceId: input.workspaceId,
      invocationId: input.invocationId,
    });
    return { status: "not_found", invocationId: input.invocationId };
  }

  const now = (deps.now?.() ?? new Date()).toISOString();
  const spawns = record.spawns.map((spawn) =>
    spawn.invocationId === input.invocationId
      ? {
          ...spawn,
          status: input.status,
          completedAt: input.completedAt ?? now,
          ...(input.output ? { output: input.output } : {}),
          ...(input.error ? { error: input.error } : {}),
        }
      : spawn,
  );
  let updated: FactoryInFlightRecord = {
    ...record,
    spawns,
    updatedAt: now,
  };
  const allTerminal = spawns.every((spawn) =>
    spawn.status === "completed" || spawn.status === "failed",
  );
  if (!allTerminal) {
    await stateStore.putInFlight(updated);
    await logger.info("Factory invocation completion recorded", {
      area: "factory-cloud-brain",
      diag: "completion-recorded",
      workspaceId: input.workspaceId,
      invocationId: input.invocationId,
      issueKey: record.issueKey,
      remaining: spawns.filter((spawn) => spawn.status !== "completed" && spawn.status !== "failed").length,
    });
    return {
      status: "updated",
      invocationId: input.invocationId,
      issueKey: record.issueKey,
    };
  }

  const anyFailed = spawns.some((spawn) => spawn.status === "failed");
  updated = {
    ...updated,
    completedAt: updated.completedAt ?? now,
    mergeGate: {
      status: anyFailed ? "blocked" : "ready",
      reason: anyFailed
        ? "One or more factory spawns failed; merge gate remains blocked."
        : "All factory spawns completed successfully; merge gate is ready.",
      decidedAt: now,
    },
  };

  const message = buildFactoryCompletionWritebackMessage(updated);
  const writeback = deps.writeback ?? {};
  updated = {
    ...updated,
    linearWriteback: await runWriteback({
      prior: updated.linearWriteback,
      post: writeback.postLinear ?? defaultPostLinearFactoryCompletion,
      record: updated,
      message,
      now,
      label: "linear",
    }),
  };
  if (writeback.postSlack) {
    updated = {
      ...updated,
      slackWriteback: await runWriteback({
        prior: updated.slackWriteback,
        post: writeback.postSlack,
        record: updated,
        message,
        now,
        label: "slack",
      }),
    };
  }

  await stateStore.putInFlight(updated);
  await logger.info("Factory invocation lifecycle reached merge gate", {
    area: "factory-cloud-brain",
    diag: "merge-gate",
    workspaceId: input.workspaceId,
    invocationId: input.invocationId,
    issueKey: updated.issueKey,
    mergeGate: updated.mergeGate?.status,
    linearWriteback: updated.linearWriteback?.status,
    slackWriteback: updated.slackWriteback?.status,
  });

  return {
    status: "all_terminal",
    invocationId: input.invocationId,
    issueKey: updated.issueKey,
    mergeGate: updated.mergeGate,
    linearWriteback: updated.linearWriteback,
    slackWriteback: updated.slackWriteback,
  };
}

export async function dispatchFactoryBrainDelivery(
  input: FactoryBrainDeliveryInput,
  deps: FactoryBrainDeps = {},
): Promise<FactoryBrainDeliveryResult> {
  const issue = parseLinearIssueFromPayload(input.payload);
  if (!issue || !isFactoryIssue(issue)) {
    throw new Error("factory brain delivery payload is not a factory Linear issue");
  }

  const recipe = selectRecipe(issue);
  const now = deps.now?.() ?? new Date();
  const fleet = deps.fleet ?? await createDefaultFactoryFleetEmitter();
  const stateStore = deps.stateStore ?? createFactoryStateStore();
  const spawns = buildSpawnSet({
    workspaceId: input.workspaceId,
    deliveryId: input.deliveryId,
    issue,
    recipe,
    deployedByUserId: input.deployedByUserId ?? undefined,
  });

  const baseRecord: FactoryInFlightRecord = {
    workspaceId: input.workspaceId,
    issueId: issue.id,
    issueKey: issue.key,
    issuePath: issue.path,
    recipe,
    deliveryId: input.deliveryId,
    connectionId: readString(input.payload.connectionId),
    spawns: spawns.map((spawn) => ({
      name: spawn.name,
      capability: spawn.capability,
      invocationId: spawn.invocationId,
      status: "pending",
      role: roleFromSpawnName(spawn.name),
      persona: spawn.persona,
      repo: spawn.repo,
    })),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await stateStore.putInFlight(baseRecord);

  if (recipe === "team") {
    await recordTeamRecipeMetadata({
      workspaceId: input.workspaceId,
      parentAgentId: input.agentId,
      issue,
      spawns,
      deliveryId: input.deliveryId,
    });
  }

  // Idempotency contract: every spawn carries a deterministic `invocationId`
  // (workspace+issue+role+suffix, see `invocationIdFor`) and the fleet treats
  // `invocation_id` as the dedupe key (RFC §7: first-to-`completed` wins). The
  // delivery row is only marked delivered after the WHOLE set emits, so a throw
  // mid-loop re-emits the entire set on the next drain — that re-run rebuilds
  // the SAME invocationIds, so the fleet collapses the duplicates rather than
  // double-spawning. Keep `invocationIdFor` deterministic for this to hold.
  const emitted: FactoryInFlightRecord["spawns"] = [];
  for (const spawn of spawns) {
    const result = await fleet.spawn(spawn);
    emitted.push({
      name: spawn.name,
      capability: spawn.capability,
      invocationId: result.invocationId,
      status: "dispatched",
      role: roleFromSpawnName(spawn.name),
      persona: spawn.persona,
      repo: spawn.repo,
    });
    await logger.info("Factory brain emitted fleet spawn", {
      area: "factory-cloud-brain",
      diag: "spawn-emitted",
      workspaceId: input.workspaceId,
      deliveryId: input.deliveryId,
      issueKey: issue.key,
      recipe,
      spawnName: spawn.name,
      capability: spawn.capability,
      invocationId: result.invocationId,
    });
  }

  await stateStore.putInFlight({
    ...baseRecord,
    spawns: emitted,
    updatedAt: (deps.now?.() ?? new Date()).toISOString(),
  });

  await logger.info("Factory brain triage recipe emitted", {
    area: "factory-cloud-brain",
    diag: "recipe-emitted",
    workspaceId: input.workspaceId,
    deliveryId: input.deliveryId,
    issueKey: issue.key,
    recipe,
    emitted: emitted.length,
    invocationIds: emitted.map((spawn) => spawn.invocationId),
  });

  return {
    issueKey: issue.key,
    recipe,
    emitted: emitted.length,
    invocationIds: emitted.map((spawn) => spawn.invocationId),
  };
}

async function runWriteback(input: {
  prior?: FactoryWritebackRecord;
  post: (input: { record: FactoryInFlightRecord; message: string }) => Promise<void>;
  record: FactoryInFlightRecord;
  message: string;
  now: string;
  label: "linear" | "slack";
}): Promise<FactoryWritebackRecord> {
  if (input.prior?.status === "posted") {
    return input.prior;
  }
  try {
    await input.post({ record: input.record, message: input.message });
    return { status: "posted", postedAt: input.now };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logger.warn("Factory completion writeback failed", {
      area: "factory-cloud-brain",
      diag: "completion-writeback-failed",
      provider: input.label,
      workspaceId: input.record.workspaceId,
      issueKey: input.record.issueKey,
      error: message,
    });
    return { status: "failed", error: message };
  }
}

async function defaultPostLinearFactoryCompletion(input: {
  record: FactoryInFlightRecord;
  message: string;
}): Promise<void> {
  const result = await executeRelayfileProviderWriteback({
    opId: `factory-${sanitizeSlug(input.record.issueKey)}-${sanitizeSlug(input.record.deliveryId)}-completion`,
    workspaceId: input.record.workspaceId,
    provider: "linear",
    path: linearCommentWritebackPath(input.record),
    revision: input.record.updatedAt,
    correlationId: `factory:${input.record.deliveryId}:completion`,
    action: "file_upsert",
    content: JSON.stringify({ body: input.message }),
    contentType: "application/json",
  });
  assertWritebackSucceeded(result);
}

function assertWritebackSucceeded(result: RelayfileWritebackExecutionResult): void {
  if (result.outcome === "success") {
    return;
  }
  throw new Error(result.error.message);
}

function linearCommentWritebackPath(record: FactoryInFlightRecord): string {
  const issuePath = record.issuePath.replace(/\.json$/u, "");
  return `${issuePath}/comments/factory-${sanitizeSlug(record.deliveryId)}-completion.json`;
}

function buildFactoryCompletionWritebackMessage(record: FactoryInFlightRecord): string {
  const failed = record.spawns.filter((spawn) => spawn.status === "failed");
  const summary = failed.length === 0
    ? `Factory run for ${record.issueKey} completed. Merge gate: ready.`
    : `Factory run for ${record.issueKey} completed with ${failed.length} failed spawn(s). Merge gate: blocked.`;
  const spawnLines = record.spawns.map((spawn) =>
    `- ${spawn.role ?? spawn.name}: ${spawn.status} (${spawn.invocationId})`,
  );
  return [summary, "", ...spawnLines].join("\n");
}

function buildSpawnSet(input: {
  workspaceId: string;
  deliveryId: string;
  issue: LinearIssueForFactory;
  recipe: FactoryRecipe;
  deployedByUserId?: string;
}): FactorySpawnInput[] {
  const repos = repoLabels(input.issue);
  const issueMeta = {
    id: input.issue.id,
    key: input.issue.key,
    title: input.issue.title,
    path: input.issue.path,
  };
  if (input.recipe === "workflow") {
    const workflow = workflowPath(input.issue);
    return [{
      name: `${agentBaseName(input.issue)}-workflow`,
      capability: "workflow:run",
      workspaceId: input.workspaceId,
      invocationId: invocationIdFor(input.workspaceId, input.issue, "workflow", "runner"),
      workflow,
      recipe: "workflow",
      task: issueTask(input.issue, "Run workflow"),
      issue: issueMeta,
      inputs: {
        issue: input.issue.raw,
        labels: input.issue.labels,
        repos,
        deliveryId: input.deliveryId,
        deployerUserId: input.deployedByUserId,
      },
    }];
  }

  // Harness is selectable per-issue (defaults to claude). Once the registry is
  // wired through, the factory can emit `spawn:opencode`, `spawn:grok`, etc.
  const spawnCapability = selectSpawnCapability(input.issue);
  const implementerRepos = input.recipe === "team" ? repos.slice(0, 4) : repos.slice(0, 1);
  const targetRepos = implementerRepos.length > 0 ? implementerRepos : ["AgentWorkforce/cloud"];
  const implementers = targetRepos.map((repo) => {
    const repoSlug = sanitizeSlug(repo.split("/").at(-1) ?? repo);
    const name = input.recipe === "team"
      ? `${agentBaseName(input.issue)}-impl-${repoSlug}`
      : `${agentBaseName(input.issue)}-impl`;
    return {
      name,
      capability: spawnCapability,
      workspaceId: input.workspaceId,
      invocationId: invocationIdFor(input.workspaceId, input.issue, "implementer", repoSlug),
      persona: "cloud-team-implementer",
      recipe: input.recipe,
      repo,
      task: issueTask(input.issue, `Implement in ${repo}`),
      issue: issueMeta,
      inputs: { deliveryId: input.deliveryId, deployerUserId: input.deployedByUserId },
    };
  });

  if (input.recipe !== "team") {
    return implementers;
  }

  return [
    ...implementers,
    {
      name: `${agentBaseName(input.issue)}-review`,
      capability: spawnCapability,
      workspaceId: input.workspaceId,
      invocationId: invocationIdFor(input.workspaceId, input.issue, "reviewer", "review"),
      persona: "cloud-team-reviewer",
      recipe: "team",
      repo: targetRepos[0],
      task: issueTask(input.issue, "Review team output"),
      issue: issueMeta,
      inputs: { deliveryId: input.deliveryId, deployerUserId: input.deployedByUserId },
    },
  ];
}

async function recordTeamRecipeMetadata(input: {
  workspaceId: string;
  parentAgentId: string;
  issue: LinearIssueForFactory;
  spawns: FactorySpawnInput[];
  deliveryId: string;
}): Promise<void> {
  const db = getDb();
  // Deterministic, issue-scoped team id (NOT a random UUID) so a `[factory]`
  // issue that matches more than one factory-candidate agent — each running
  // this per-row on the same delivery — collapses to a SINGLE teams row via
  // `onConflictDoNothing`, instead of accreting one duplicate team per match
  // (finding #4). Spawn idempotency itself rides the deterministic
  // `invocationId` + fleet dedupe; this keeps the team metadata equally idempotent.
  const teamId = `factory_team_${sanitizeSlug(input.workspaceId)}_${sanitizeSlug(input.issue.key)}`;
  const channel = `factory-${input.issue.key.toLowerCase()}`;
  await db.insert(teams).values({
    id: teamId,
    workspaceId: input.workspaceId,
    parentAgentId: input.parentAgentId,
    status: "starting",
    task: `${input.issue.key}: ${input.issue.title}`,
    sharedMountRoot: `/factory/${input.issue.key}`,
    channel,
    spec: {
      source: "factory-brain",
      deliveryId: input.deliveryId,
      issue: input.issue.raw,
      recipe: "team",
    },
  }).onConflictDoNothing();

  for (const spawn of input.spawns) {
    const personaId = spawn.persona ? await resolvePersonaId(spawn.persona) : null;
    const memberName = spawn.name.replace(`${agentBaseName(input.issue)}-`, "");
    await db.insert(teamMembers).values({
      id: `team_member_${teamId}_${sanitizeSlug(memberName)}`,
      teamId,
      name: memberName,
      personaId: personaId ?? spawn.persona,
      role: memberName.startsWith("review") ? "reviewer" : "worker",
      assignedTask: spawn.task,
      status: "starting",
      resultId: spawn.invocationId,
    }).onConflictDoNothing();
  }

  await db.insert(teamEvents).values({
    id: `tev_${teamId}_recipe_emitted`,
    teamId,
    kind: "factory_recipe_emitted",
    payload: {
      deliveryId: input.deliveryId,
      issueKey: input.issue.key,
      invocationIds: input.spawns.map((spawn) => spawn.invocationId),
    },
  }).onConflictDoNothing();
}

async function resolvePersonaId(slug: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ id: personas.id })
    .from(personas)
    .where(eq(personas.slug, slug))
    .limit(1);
  return row?.id ?? null;
}

function parseLinearIssueFromPayload(payload: Record<string, unknown>): LinearIssueForFactory | null {
  const resource = asRecord(payload.resource) ?? asRecord(payload.payload) ?? payload;
  const issue = asRecord(resource.issue) ?? resource;
  const key = readString(issue.identifier) ?? readString(issue.key) ?? readString(issue.number);
  const id = readString(issue.id) ?? readString(issue.uuid) ?? key;
  const title = readString(issue.title) ?? readString(issue.name) ?? "";
  if (!key || !id || !title) {
    return null;
  }

  const labels = labelNames(issue.labels ?? resource.labels);
  return {
    id,
    key,
    title,
    description: readString(issue.description) ?? readString(issue.body) ?? "",
    labels,
    stateName: readString(asRecord(issue.state)?.name) ?? readString(issue.state),
    stateId: readString(issue.stateId) ?? readString(asRecord(issue.state)?.id),
    team: readString(asRecord(issue.team)?.key) ?? readString(issue.team),
    project: readString(asRecord(issue.project)?.name) ?? readString(issue.project),
    path: firstPath(payload) ?? `/linear/issues/${key}.json`,
    raw: issue,
  };
}

function isFactoryIssue(issue: LinearIssueForFactory): boolean {
  return issue.title.toLowerCase().includes(FACTORY_TITLE_PREFIX) ||
    issue.labels.some((label) => label.toLowerCase() === FACTORY_LABEL);
}

function selectRecipe(issue: LinearIssueForFactory): FactoryRecipe {
  const labels = new Set(issue.labels.map((label) => label.toLowerCase()));
  if (labels.has("agent:workflow")) return "workflow";
  if (labels.has("agent:team")) return "team";
  if (labels.has("agent:single")) return "single";
  return repoLabels(issue).length > 1 ? "team" : "single";
}

/**
 * Selects the spawn harness for an issue's implementer/reviewer agents.
 *
 * Heuristic: an optional `harness:<cli>` Linear label (e.g. `harness:opencode`,
 * `harness:grok`) picks the harness; `<cli>` is validated against the
 * agent-relay registry by `spawnCapabilityForCli`, which falls back to claude
 * for unknown or absent values. This keeps the field plumbed + configurable
 * without hardwiring claude. OPEN QUESTION: should the default also be
 * configurable per-factory-config / per-repo rather than always claude?
 */
function selectSpawnCapability(issue: LinearIssueForFactory): FactorySpawnCapability {
  const label = issue.labels.find((entry) => entry.toLowerCase().startsWith("harness:"));
  const cli = label?.slice("harness:".length).trim().toLowerCase();
  return spawnCapabilityForCli(cli);
}

function repoLabels(issue: LinearIssueForFactory): string[] {
  const labels = issue.labels
    .map((label) => label.toLowerCase())
    .filter((label) => REPO_LABELS.has(label) && label !== FACTORY_LABEL);
  const unique = [...new Set(labels)];
  return unique.map((label) => `AgentWorkforce/${label}`);
}

function workflowPath(issue: LinearIssueForFactory): string {
  const label = issue.labels.find((entry) => entry.toLowerCase().startsWith("workflow:"));
  return label?.slice("workflow:".length).trim() || "workflows/factory/default.ts";
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === "string") return entry;
      const record = asRecord(entry);
      return readString(record?.name) ?? readString(record?.label);
    })
    .filter((entry): entry is string => Boolean(entry));
}

function firstPath(payload: Record<string, unknown>): string | null {
  const paths = payload.paths;
  if (!Array.isArray(paths)) return null;
  return paths.find((path): path is string => typeof path === "string" && path.trim().length > 0) ?? null;
}

function issueTask(issue: LinearIssueForFactory, verb: string): string {
  return [
    `${verb}: ${issue.key} ${issue.title}`,
    issue.description,
    `Linear path: ${issue.path}`,
    `Labels: ${issue.labels.join(", ")}`,
  ].filter(Boolean).join("\n\n");
}

function invocationIdFor(
  workspaceId: string,
  issue: LinearIssueForFactory,
  role: string,
  suffix: string,
): string {
  return `factory:${workspaceId}:${issue.key}:${sanitizeSlug(role)}:${sanitizeSlug(suffix)}`;
}

function roleFromSpawnName(name: string): string | undefined {
  if (name.includes("-review")) return "reviewer";
  if (name.includes("-workflow")) return "workflow";
  if (name.includes("-impl")) return "implementer";
  return undefined;
}

function agentBaseName(issue: LinearIssueForFactory): string {
  return `factory-${sanitizeSlug(issue.key)}`;
}

function sanitizeSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
}

function readString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function unwrapSpecRecord(spec: unknown): Record<string, unknown> {
  const record = asRecord(spec) ?? {};
  return asRecord(record.persona) ?? record;
}
