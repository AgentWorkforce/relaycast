import { randomUUID } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import {
  assertPairwiseDisjointScopes,
  assertSafeMemberWritePath,
} from "@cloud/core/proactive-runtime/member-token-scope.js";
import { getDb } from "@/lib/db";
import {
  agents,
  personas,
  teamEvents,
  teamMembers,
  teams,
} from "@/lib/db/schema";
import { createRelaycastChannel } from "@/lib/relaycast/channels";
import { countActiveTeamMembers } from "@/lib/teams/reaper";
import {
  createDefaultFactoryFleetEmitter,
  type FactorySpawnInput,
} from "@/lib/proactive-runtime/factory-fleet-emitter";

/**
 * ctx.team spawn orchestration (spec §6.1/§9/§11/§12).
 *
 * This owns the durable side of a team spawn: validate the request, resolve
 * member personas, create the team + member + agent rows, provision the
 * relaycast channel, and emit member spawn invocations into the fleet.
 */

export class SpawnTeamError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

const DEFAULT_TTL_SECONDS = 3_600;
const MAX_TTL_SECONDS = 21_600;
const DEFAULT_MAX_MEMBERS = 4;
const HARD_MAX_MEMBERS = 4;
const SYNTHETIC_LEAD_PERSONA = "relay-orchestrator";

// Workspace-wide concurrency cap across all active teams (spec §14).
// Override via WORKFORCE_MAX_CONCURRENT_TEAM_MEMBERS.
function maxConcurrentTeamMembers(): number {
  const raw = Number(process.env.WORKFORCE_MAX_CONCURRENT_TEAM_MEMBERS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 16;
}

type MemberRole = "orchestrator" | "worker" | "reviewer";

interface MemberInput {
  name: string;
  persona: string;
  role: MemberRole;
  task?: string;
}

export interface EmitTeamMemberSpawnArgs {
  workspaceId: string;
  teamId: string;
  memberName: string;
  role: MemberRole;
  personaId: string;
  agentId: string;
  assignedRoot: string;
  assignedTask?: string;
  teamPrompt?: string;
  channel: string;
  spawnInput: FactorySpawnInput;
}

export interface SpawnTeamDeps {
  createChannel: (args: {
    workspaceId: string;
    name: string;
    topic?: string;
  }) => Promise<{ channel: string }>;
  buildSpawnInput: (
    args: EmitTeamMemberSpawnArgs,
  ) => FactorySpawnInput | Promise<FactorySpawnInput>;
  emitSpawn: (args: FactorySpawnInput) => Promise<{ invocationId: string; name?: string; sessionRef?: string }>;
}

export interface SpawnTeamInput {
  workspaceId: string;
  parentAgentId: string;
  deployerUserId: string;
  organizationId: string;
  body: unknown;
}

export interface SpawnTeamResult {
  teamId: string;
  channel: string;
  sharedMountRoot: string;
  status: "starting";
  members: Array<{
    name: string;
    agentId: string;
    personaId: string;
    role: MemberRole;
    sandboxId: null;
    invocationId: string;
    status: string;
    assignedRoot: string;
    writeScopes: string[];
  }>;
}

export async function defaultSpawnTeamDeps(): Promise<SpawnTeamDeps> {
  const fleet = await createDefaultFactoryFleetEmitter();
  return {
    createChannel: (args) => createRelaycastChannel(args),
    buildSpawnInput: (args) => args.spawnInput,
    emitSpawn: (args) => fleet.spawn(args),
  };
}

export async function spawnTeam(
  input: SpawnTeamInput,
  deps?: SpawnTeamDeps,
): Promise<SpawnTeamResult> {
  const resolvedDeps = deps ?? await defaultSpawnTeamDeps();
  const db = getDb();
  const parsed = parseSpawnBody(input.body);

  // Parent ownership: the parent agent must live in this workspace.
  const [parent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.id, input.parentAgentId),
        eq(agents.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  if (!parent) {
    throw new SpawnTeamError(
      "Parent agent not found in workspace",
      404,
      "parent_not_found",
    );
  }

  const members = await resolveMembers(parsed.members, input.deployerUserId);

  // Workspace concurrency quota (§14): reject if this team would push the
  // workspace's active team-member count over the cap.
  const cap = maxConcurrentTeamMembers();
  const active = await countActiveTeamMembers(input.workspaceId);
  if (active + members.length > cap) {
    throw new SpawnTeamError(
      `team would exceed the workspace concurrency cap (${active} active + ${members.length} new > ${cap})`,
      429,
      "team_member_quota_exceeded",
    );
  }

  const teamId = `team_${randomUUID()}`;
  const channelName = `team-${teamId}`;
  const sharedMountRoot = `/teams/${teamId}`;
  const expiresAt = new Date(Date.now() + parsed.ttlSeconds * 1000);
  const assignments = members.map((member) => ({
    memberName: member.name,
    assignedPaths: [assignedRootForTeamMember(teamId, member.name)],
  }));
  assertPairwiseDisjointScopes(assignments);

  await db.insert(teams).values({
    id: teamId,
    workspaceId: input.workspaceId,
    parentAgentId: input.parentAgentId,
    status: "starting",
    task: parsed.task,
    ...(parsed.teamPrompt ? { teamPrompt: parsed.teamPrompt } : {}),
    sharedMountRoot,
    channel: channelName,
    ttlSeconds: parsed.ttlSeconds,
    expiresAt,
  });

  const { channel } = await resolvedDeps.createChannel({
    workspaceId: input.workspaceId,
    name: channelName,
    topic: parsed.task.slice(0, 250),
  });

  const memberViews: SpawnTeamResult["members"] = [];
  for (const member of members) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      workspaceId: input.workspaceId,
      personaId: member.personaId,
      deployedName: `${teamId}:${member.name}`,
      deployedByUserId: input.deployerUserId,
      inputValues: {},
      specHashAtDeploy: member.specHash,
      status: "active",
      spawnedByAgentId: input.parentAgentId,
      watchGlobs: [],
      scheduleIds: [],
    });

    const assignedRoot = assignedRootForTeamMember(teamId, member.name);
    const invocationId = `factory:team:${teamId}:${member.name}`;
    const spawnInput: FactorySpawnInput = {
      name: `${teamId}:${member.name}`,
      capability: "spawn:claude",
      workspaceId: input.workspaceId,
      invocationId,
      persona: member.persona,
      recipe: "team",
      channel,
      task: [
        parsed.task,
        member.task ? `Assigned task: ${member.task}` : "",
        parsed.teamPrompt ? `Team prompt: ${parsed.teamPrompt}` : "",
        `Assigned relayfile root: ${assignedRoot}`,
      ].filter(Boolean).join("\n\n"),
      inputs: {
        deployerUserId: input.deployerUserId,
        organizationId: input.organizationId,
        teamId,
        memberName: member.name,
        role: member.role,
        assignedRoot,
      },
    };
    const emitted = await resolvedDeps.emitSpawn(
      await resolvedDeps.buildSpawnInput({
        workspaceId: input.workspaceId,
        teamId,
        memberName: member.name,
        role: member.role,
        personaId: member.personaId,
        agentId,
        assignedRoot,
        ...(member.task ? { assignedTask: member.task } : {}),
        ...(parsed.teamPrompt ? { teamPrompt: parsed.teamPrompt } : {}),
        channel,
        spawnInput,
      }),
    );

    const memberRowId = `team_member_${randomUUID()}`;
    await db.insert(teamMembers).values({
      id: memberRowId,
      teamId,
      name: member.name,
      agentId,
      personaId: member.personaId,
      role: member.role,
      ...(member.task ? { assignedTask: member.task } : {}),
      status: "starting",
      resultId: emitted.invocationId,
    });

    await db.insert(teamEvents).values({
      id: `tev_${randomUUID()}`,
      teamId,
      memberName: member.name,
      kind: "member_spawn_emitted",
      payload: {
        agentId,
        role: member.role,
        personaId: member.personaId,
        assignedRoot,
        invocationId: emitted.invocationId,
      },
    });

    memberViews.push({
      name: member.name,
      agentId,
      personaId: member.personaId,
      role: member.role,
      sandboxId: null,
      invocationId: emitted.invocationId,
      status: "starting",
      assignedRoot,
      writeScopes: [],
    });
  }

  await db.insert(teamEvents).values({
    id: `tev_${randomUUID()}`,
    teamId,
    kind: "team_spawned",
    payload: { memberCount: memberViews.length, channel },
  });

  return {
    teamId,
    channel,
    sharedMountRoot,
    status: "starting",
    members: memberViews,
  };
}

interface ParsedBody {
  task: string;
  teamPrompt?: string;
  members: MemberInput[];
  ttlSeconds: number;
}

export function parseSpawnBody(body: unknown): ParsedBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new SpawnTeamError(
      "Request body must be an object",
      400,
      "invalid_body",
    );
  }
  const record = body as Record<string, unknown>;

  const task = typeof record.task === "string" ? record.task.trim() : "";
  if (!task) {
    throw new SpawnTeamError("task is required", 422, "task_required");
  }

  const teamPrompt =
    typeof record.teamPrompt === "string" && record.teamPrompt.trim()
      ? record.teamPrompt.trim()
      : undefined;

  const ttlRaw = record.ttlSeconds;
  let ttlSeconds = DEFAULT_TTL_SECONDS;
  if (ttlRaw !== undefined) {
    if (typeof ttlRaw !== "number" || !Number.isFinite(ttlRaw) || ttlRaw <= 0) {
      throw new SpawnTeamError(
        "ttlSeconds must be a positive number",
        422,
        "invalid_ttl",
      );
    }
    ttlSeconds = Math.min(Math.floor(ttlRaw), MAX_TTL_SECONDS);
  }

  let maxMembers = DEFAULT_MAX_MEMBERS;
  if (record.maxMembers !== undefined) {
    if (typeof record.maxMembers !== "number" || record.maxMembers <= 0) {
      throw new SpawnTeamError(
        "maxMembers must be a positive number",
        422,
        "invalid_max_members",
      );
    }
    maxMembers = Math.min(Math.floor(record.maxMembers), HARD_MAX_MEMBERS);
  }

  if (!Array.isArray(record.members) || record.members.length === 0) {
    throw new SpawnTeamError(
      "members must be a non-empty array",
      422,
      "members_required",
    );
  }
  if (record.members.length > maxMembers) {
    throw new SpawnTeamError(
      `members exceeds maxMembers (${record.members.length} > ${maxMembers})`,
      422,
      "too_many_members",
    );
  }

  const seenNames = new Set<string>();
  let orchestratorCount = 0;
  let anyUnassigned = false;
  const members: MemberInput[] = record.members.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new SpawnTeamError(
        `members[${index}] must be an object`,
        422,
        "invalid_member",
      );
    }
    const m = raw as Record<string, unknown>;
    const name = typeof m.name === "string" ? m.name.trim() : "";
    const persona = typeof m.persona === "string" ? m.persona.trim() : "";
    if (!name)
      throw new SpawnTeamError(
        `members[${index}].name is required`,
        422,
        "invalid_member",
      );
    if (!persona)
      throw new SpawnTeamError(
        `members[${index}].persona is required`,
        422,
        "invalid_member",
      );
    if (seenNames.has(name)) {
      throw new SpawnTeamError(
        `duplicate member name "${name}"`,
        422,
        "duplicate_member",
      );
    }
    seenNames.add(name);

    const role = (m.role ?? "worker") as MemberRole;
    if (role !== "orchestrator" && role !== "worker" && role !== "reviewer") {
      throw new SpawnTeamError(
        `members[${index}].role is invalid`,
        422,
        "invalid_role",
      );
    }
    if (role === "orchestrator") orchestratorCount += 1;

    const task =
      typeof m.task === "string" && m.task.trim() ? m.task.trim() : undefined;
    if (!task && role !== "orchestrator") anyUnassigned = true;

    return { name, persona, role, ...(task ? { task } : {}) };
  });

  if (orchestratorCount > 1) {
    throw new SpawnTeamError(
      "at most one orchestrator member is allowed",
      422,
      "multiple_orchestrators",
    );
  }

  // Synthetic lead fallback (spec §6.1/E): unassigned members with no
  // orchestrator -> inject a relay-orchestrator lead to divvy the work.
  if (anyUnassigned && orchestratorCount === 0) {
    if (members.length >= maxMembers) {
      throw new SpawnTeamError(
        "no orchestrator and adding a synthetic lead would exceed maxMembers",
        422,
        "synthetic_lead_over_cap",
      );
    }
    members.unshift({
      name: "lead",
      persona: SYNTHETIC_LEAD_PERSONA,
      role: "orchestrator",
    });
  }

  return { task, members, ttlSeconds, ...(teamPrompt ? { teamPrompt } : {}) };
}

interface ResolvedMember extends MemberInput {
  personaId: string;
  specHash: string;
}

async function resolveMembers(
  members: MemberInput[],
  deployerUserId: string,
): Promise<ResolvedMember[]> {
  const db = getDb();
  const resolved: ResolvedMember[] = [];
  for (const member of members) {
    // Resolve by persona UUID id, or by slug owned by the deploying user.
    const [row] = await db
      .select({ id: personas.id, specHash: personas.specHash })
      .from(personas)
      .where(
        or(
          eq(personas.id, member.persona),
          and(
            eq(personas.slug, member.persona),
            eq(personas.ownerUserId, deployerUserId),
          ),
        ),
      )
      .limit(1);
    if (!row) {
      throw new SpawnTeamError(
        `member "${member.name}" persona "${member.persona}" not found`,
        422,
        "persona_unresolved",
      );
    }
    resolved.push({ ...member, personaId: row.id, specHash: row.specHash });
  }
  return resolved;
}

export function assignedRootForTeamMember(
  teamId: string,
  memberName: string,
): string {
  const safeMemberName = memberName
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!safeMemberName) {
    throw new SpawnTeamError(
      "member name must include at least one path-safe character",
      422,
      "invalid_member",
    );
  }
  return assertSafeMemberWritePath(
    `/teams/${teamId}/members/${safeMemberName}`,
  );
}
