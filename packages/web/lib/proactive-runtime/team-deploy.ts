import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { and, eq, inArray, ne } from "drizzle-orm";
import type {
  PersonaRef,
  TeamMember,
  TeamSpec,
} from "@cloud/core/proactive-runtime/team-spec.js";
import { getDb } from "@/lib/db";
import { agents, teamMembers, teams } from "@/lib/db/schema";

export class TeamDeployError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 422,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "TeamDeployError";
  }
}

export type BoundTeamMember = {
  name: string;
  role: string;
  agentId: string;
  personaId: string;
  personaRef: PersonaRef;
  owns: unknown[] | null;
};

export type BindTeamInput = {
  workspaceId: string;
  spec: TeamSpec;
};

export type BindTeamResult = {
  teamId: string;
  slug: string;
  leadMemberName: string;
  tokenBudget: number | null;
  timeBudgetSeconds: number | null;
  members: BoundTeamMember[];
};

type AgentResolution = {
  agentId: string;
  personaId: string;
  deployedName: string;
};

function trimVersionSuffix(value: string): string {
  const trimmed = value.trim();
  const atIndex = trimmed.indexOf("@");
  return atIndex === -1 ? trimmed : trimmed.slice(0, atIndex);
}

export function personaRefToDeploySlug(ref: PersonaRef): string {
  if (typeof ref === "string") {
    const slug = trimVersionSuffix(ref);
    if (!slug) {
      throw new TeamDeployError("member persona slug is required", "invalid_persona_ref");
    }
    return slug;
  }

  if (ref.inline !== undefined) {
    throw new TeamDeployError(
      "inline team member personas are not supported in Phase 1; deploy the persona first and reference it by slug or path",
      "inline_persona_ref_unsupported",
    );
  }

  if (ref.slug !== undefined) {
    const slug = trimVersionSuffix(ref.slug);
    if (!slug) {
      throw new TeamDeployError("member persona slug is required", "invalid_persona_ref");
    }
    return slug;
  }

  if (ref.path !== undefined) {
    const normalized = ref.path.trim().replace(/\/+$/g, "");
    // Phase 1 deploys path refs first, then binds by the deployed slug, which
    // follows the persona directory name convention.
    const slug = basename(normalized);
    if (!slug || slug === "." || slug === "..") {
      throw new TeamDeployError("member persona path must resolve to a slug", "invalid_persona_ref");
    }
    return slug;
  }

  throw new TeamDeployError("member persona must include slug or path", "invalid_persona_ref");
}

function memberRole(member: TeamMember, leadMemberName: string): string {
  return member.role?.trim() || (member.name === leadMemberName ? "lead" : "worker");
}

export async function resolveTeamBindingMembers(
  workspaceId: string,
  spec: TeamSpec,
): Promise<BoundTeamMember[]> {
  const requested = spec.members.map((member) => ({
    member,
    slug: personaRefToDeploySlug(member.persona),
  }));
  const slugs = Array.from(new Set(requested.map((entry) => entry.slug)));
  const rows = slugs.length === 0
    ? []
    : await getDb()
      .select({
        agentId: agents.id,
        personaId: agents.personaId,
        deployedName: agents.deployedName,
      })
      .from(agents)
      .where(
        and(
          eq(agents.workspaceId, workspaceId),
          ne(agents.status, "destroyed"),
          inArray(agents.deployedName, slugs),
        ),
      );

  const bySlug = new Map<string, AgentResolution>();
  for (const row of rows) {
    bySlug.set(row.deployedName, row);
  }

  const missing = requested
    .filter((entry) => !bySlug.has(entry.slug))
    .map((entry) => ({ member: entry.member.name, persona: entry.slug }));
  if (missing.length > 0) {
    throw new TeamDeployError(
      "Team members must reference deployed personas in this workspace",
      "team_members_not_deployed",
      409,
      { missing },
    );
  }

  return requested.map(({ member, slug }) => {
    const row = bySlug.get(slug);
    if (!row) {
      throw new TeamDeployError(
        `Team member "${member.name}" did not resolve to a deployed persona`,
        "team_member_resolution_failed",
        409,
      );
    }
    return {
      name: member.name,
      role: memberRole(member, spec.lead),
      agentId: row.agentId,
      personaId: row.personaId,
      personaRef: member.persona,
      owns: member.owns ?? null,
    };
  });
}

async function resolveTeamLeadAgentId(
  workspaceId: string,
  lead: string,
): Promise<string | null> {
  const deployedName = trimVersionSuffix(lead);
  if (!deployedName) {
    return null;
  }
  const rows = await getDb()
    .select({ agentId: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
        ne(agents.status, "destroyed"),
        eq(agents.deployedName, deployedName),
      ),
    )
    .limit(1);

  return rows[0]?.agentId ?? null;
}

export async function bindTeam(input: BindTeamInput): Promise<BindTeamResult> {
  const [boundMembers, leadAgentId] = await Promise.all([
    resolveTeamBindingMembers(input.workspaceId, input.spec),
    resolveTeamLeadAgentId(input.workspaceId, input.spec.lead),
  ]);
  const leadIsLaunchableMember = input.spec.members.some(
    (member) => member.name === input.spec.lead,
  );
  if (!leadIsLaunchableMember && !leadAgentId) {
    throw new TeamDeployError(
      `Team lead "${input.spec.lead}" must reference a deployed agent in this workspace when it is not a launchable member`,
      "team_lead_not_deployed",
      409,
      { lead: input.spec.lead },
    );
  }
  const now = new Date();
  const db = getDb();

  return db.transaction(async (tx) => {
    const [team] = await tx
      .insert(teams)
      .values({
        id: `team_${randomUUID()}`,
        workspaceId: input.workspaceId,
        parentAgentId: leadAgentId,
        slug: input.spec.id,
        leadMemberName: input.spec.lead,
        delegation: input.spec.delegation ?? [],
        tokenBudget: input.spec.tokenBudget,
        timeBudgetSeconds: input.spec.timeBudgetSeconds,
        spec: input.spec as unknown as Record<string, unknown>,
        status: "active",
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [teams.workspaceId, teams.slug],
        set: {
          parentAgentId: leadAgentId,
          leadMemberName: input.spec.lead,
          delegation: input.spec.delegation ?? [],
          tokenBudget: input.spec.tokenBudget,
          timeBudgetSeconds: input.spec.timeBudgetSeconds,
          spec: input.spec as unknown as Record<string, unknown>,
          status: "active",
          updatedAt: now,
        },
      })
      .returning({
        id: teams.id,
        slug: teams.slug,
        leadMemberName: teams.leadMemberName,
        tokenBudget: teams.tokenBudget,
        timeBudgetSeconds: teams.timeBudgetSeconds,
      });

    if (!team?.id) {
      throw new TeamDeployError("Failed to bind team", "team_bind_failed", 500);
    }

    await tx.delete(teamMembers).where(eq(teamMembers.teamId, team.id));
    await tx.insert(teamMembers).values(
      boundMembers.map((member) => ({
        id: `team_member_${randomUUID()}`,
        teamId: team.id,
        name: member.name,
        agentId: member.agentId,
        personaId: member.personaId,
        personaRef: member.personaRef,
        role: member.role,
        owns: member.owns,
        status: "starting",
      })),
    );

    return {
      teamId: team.id,
      slug: team.slug ?? input.spec.id,
      leadMemberName: team.leadMemberName ?? input.spec.lead,
      tokenBudget: team.tokenBudget ?? null,
      timeBudgetSeconds: team.timeBudgetSeconds ?? null,
      members: boundMembers,
    };
  });
}
