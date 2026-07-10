import { and, asc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { agents, personas, personaVersions, teamMembers, teams } from "@/lib/db/schema";

export type TeamRosterMemberConfig = {
  memberName?: string;
  role?: string;
  channel?: string;
  harness?: string;
  model?: string;
  // Deployed persona spec resolved from the roster member's bound agent/persona.
  personaSpec?: unknown;
  // Durable roster identity for per-member launch bookkeeping (team N>1).
  // Absent for the verbatim null-roster fallback path.
  memberId?: string;
  teamId?: string;
  // Sandbox already recorded for this member by a previous launch attempt.
  // A non-null value makes a drain retry idempotent for this member.
  sandboxId?: string | null;
};

export type ReadTeamRosterMemberConfigInput = {
  workspaceId: string;
  leadAgentId: string;
  memberName?: string | null;
};

export async function readTeamRosterMemberConfig(
  input: ReadTeamRosterMemberConfigInput,
): Promise<TeamRosterMemberConfig | null> {
  // Delegates to the plural read; same predicates and name ordering, so the
  // first row here is byte-identical to the pre-N>1 `.limit(1)` query.
  const rows = await readTeamRosterMemberConfigs(input);
  return rows[0] ?? null;
}

export async function readTeamRosterMemberConfigs(
  input: ReadTeamRosterMemberConfigInput,
): Promise<TeamRosterMemberConfig[]> {
  const predicates = [
    eq(teams.workspaceId, input.workspaceId),
    eq(teams.status, "active"),
    or(
      eq(teams.parentAgentId, input.leadAgentId),
      and(
        isNull(teams.parentAgentId),
        sql`EXISTS (
          SELECT 1
          FROM team_members lead_members
          WHERE lead_members.team_id = ${teams.id}
            AND lead_members.agent_id = ${input.leadAgentId}
            AND (
              lead_members.name = ${teams.leadMemberName}
              OR lead_members.role = 'lead'
            )
        )`,
      ),
    ),
  ];
  if (input.memberName) {
    predicates.push(eq(teamMembers.name, input.memberName));
  } else {
    predicates.push(ne(teamMembers.name, teams.leadMemberName));
    predicates.push(ne(teamMembers.role, "lead"));
  }

  const rows = await getDb()
    .select({
      memberId: teamMembers.id,
      teamId: teamMembers.teamId,
      sandboxId: teamMembers.sandboxId,
      memberName: teamMembers.name,
      role: teamMembers.role,
      personaVersionSpec: personaVersions.spec,
      personaSpec: personas.spec,
    })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .innerJoin(agents, eq(agents.id, teamMembers.agentId))
    .leftJoin(personaVersions, eq(personaVersions.id, agents.pinnedVersionId))
    .leftJoin(personas, eq(personas.id, agents.personaId))
    .where(and(...predicates))
    .orderBy(asc(teamMembers.name));

  return rows.map((row) => ({
    memberId: row.memberId,
    teamId: row.teamId,
    sandboxId: row.sandboxId,
    memberName: row.memberName,
    role: row.role,
    personaSpec: row.personaVersionSpec ?? row.personaSpec ?? undefined,
  }));
}
