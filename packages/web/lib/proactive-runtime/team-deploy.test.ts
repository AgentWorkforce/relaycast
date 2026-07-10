import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  rows: [] as Array<{ agentId: string; personaId: string; deployedName: string }>,
  limitRows: [] as Array<{ agentId: string; personaId: string; deployedName: string }>,
  insertedTeamValues: [] as Array<Record<string, unknown>>,
  updatedTeamValues: [] as Array<Record<string, unknown>>,
  insertedTeamMemberValues: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/db", () => ({
  getDb: mocks.getDb,
}));

import { teamMembers } from "@/lib/db/schema";
import {
  personaRefToDeploySlug,
  resolveTeamBindingMembers,
  TeamDeployError,
} from "./team-deploy";

const workspaceId = "00000000-0000-0000-0000-000000000002";

function dbMock() {
  const whereResult = {
    limit: vi.fn(async () => mocks.limitRows.slice(0, 1)),
    then: (resolve: (rows: typeof mocks.rows) => unknown, reject?: (error: unknown) => unknown) =>
      Promise.resolve(mocks.rows).then(resolve, reject),
  };
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => whereResult),
      })),
    })),
    transaction: vi.fn(async (callback: (tx: ReturnType<typeof txMock>) => Promise<unknown>) =>
      callback(txMock()),
    ),
  };
  return db;
}

function txMock() {
  const insertTeamsQuery = {
    values: vi.fn((values: Record<string, unknown>) => {
      mocks.insertedTeamValues.push(values);
      return insertTeamsQuery;
    }),
    onConflictDoUpdate: vi.fn((input: { set?: Record<string, unknown> }) => {
      if (input.set) {
        mocks.updatedTeamValues.push(input.set);
      }
      return insertTeamsQuery;
    }),
    returning: vi.fn(async () => [{
      id: "team_1",
      slug: "cloud-team-issue",
      leadMemberName: "cloud-team-issue",
      tokenBudget: 400000,
      timeBudgetSeconds: 1800,
    }]),
  };
  const insertTeamMembersQuery = {
    values: vi.fn(async (values: Record<string, unknown>[]) => {
      mocks.insertedTeamMemberValues.push(...values);
    }),
  };
  return {
    insert: vi.fn((table: unknown) =>
      table === teamMembers ? insertTeamMembersQuery : insertTeamsQuery,
    ),
    delete: vi.fn(() => ({
      where: vi.fn(async () => undefined),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => mocks.rows),
      })),
    })),
  };
}

describe("team-deploy", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.rows = [
      {
        agentId: "00000000-0000-0000-0000-000000000011",
        personaId: "00000000-0000-0000-0000-000000000021",
        deployedName: "cloud-team-issue",
      },
      {
        agentId: "00000000-0000-0000-0000-000000000012",
        personaId: "00000000-0000-0000-0000-000000000022",
        deployedName: "cloud-small-issue-codex",
      },
    ];
    mocks.limitRows = mocks.rows.slice(0, 1);
    mocks.insertedTeamValues = [];
    mocks.updatedTeamValues = [];
    mocks.insertedTeamMemberValues = [];
    mocks.getDb.mockReturnValue(dbMock());
  });

  it("normalizes supported persona refs to deployed slugs", () => {
    expect(personaRefToDeploySlug("cloud-small-issue-codex@latest")).toBe(
      "cloud-small-issue-codex",
    );
    expect(personaRefToDeploySlug({ slug: "cloud-small-issue-codex" })).toBe(
      "cloud-small-issue-codex",
    );
    expect(personaRefToDeploySlug({ path: "../../personas/cloud-team-issue" })).toBe(
      "cloud-team-issue",
    );
  });

  it("rejects inline persona refs for phase 1 binding", () => {
    expect(() => personaRefToDeploySlug({ inline: { id: "inline" } })).toThrow(
      /inline team member personas are not supported/,
    );
  });

  it("resolves each team member to a live deployed agent", async () => {
    const members = await resolveTeamBindingMembers(workspaceId, {
      id: "cloud-team-issue",
      lead: "lead",
      members: [
        { name: "lead", persona: { path: "../../personas/cloud-team-issue" } },
        { name: "impl", persona: { slug: "cloud-small-issue-codex" }, role: "implementer" },
      ],
    });

    expect(members).toEqual([
      expect.objectContaining({
        name: "lead",
        role: "lead",
        agentId: "00000000-0000-0000-0000-000000000011",
        personaId: "00000000-0000-0000-0000-000000000021",
      }),
      expect.objectContaining({
        name: "impl",
        role: "implementer",
        agentId: "00000000-0000-0000-0000-000000000012",
        personaId: "00000000-0000-0000-0000-000000000022",
      }),
    ]);
  });

  it("fails closed when a member persona is not deployed", async () => {
    mocks.rows = mocks.rows.filter((row) => row.deployedName !== "cloud-small-issue-codex");

    await expect(
      resolveTeamBindingMembers(workspaceId, {
        id: "cloud-team-issue",
        lead: "lead",
        members: [
          { name: "lead", persona: { slug: "cloud-team-issue" } },
          { name: "impl", persona: { slug: "cloud-small-issue-codex" } },
        ],
      }),
    ).rejects.toMatchObject({
      code: "team_members_not_deployed",
      status: 409,
      details: { missing: [{ member: "impl", persona: "cloud-small-issue-codex" }] },
    } satisfies Partial<TeamDeployError>);
  });

  it("binds a standing lead agent outside the launchable member roster", async () => {
    const { bindTeam } = await import("./team-deploy");

    await expect(
      bindTeam({
        workspaceId,
        spec: {
          id: "cloud-team-issue",
          lead: "cloud-team-issue",
          members: [
            {
              name: "cloud-team-issue-n1",
              persona: { slug: "cloud-team-issue" },
              role: "implementer",
            },
          ],
          tokenBudget: 400000,
          timeBudgetSeconds: 1800,
        },
      }),
    ).resolves.toMatchObject({
      teamId: "team_1",
      slug: "cloud-team-issue",
      leadMemberName: "cloud-team-issue",
    });

    expect(mocks.insertedTeamValues[0]).toMatchObject({
      workspaceId,
      parentAgentId: "00000000-0000-0000-0000-000000000011",
      slug: "cloud-team-issue",
      leadMemberName: "cloud-team-issue",
      status: "active",
    });
    expect(mocks.updatedTeamValues[0]).toMatchObject({
      parentAgentId: "00000000-0000-0000-0000-000000000011",
      leadMemberName: "cloud-team-issue",
      status: "active",
    });
    expect(mocks.insertedTeamMemberValues).toEqual([
      expect.objectContaining({
        name: "cloud-team-issue-n1",
        agentId: "00000000-0000-0000-0000-000000000011",
        personaId: "00000000-0000-0000-0000-000000000021",
        role: "implementer",
        status: "starting",
      }),
    ]);
  });

  it("rejects an undeployed standing lead outside the launchable member roster", async () => {
    const { bindTeam } = await import("./team-deploy");
    mocks.limitRows = [];

    await expect(
      bindTeam({
        workspaceId,
        spec: {
          id: "cloud-team-issue",
          lead: "missing-standing-lead",
          members: [
            {
              name: "cloud-team-issue-n1",
              persona: { slug: "cloud-team-issue" },
              role: "implementer",
            },
          ],
        },
      }),
    ).rejects.toMatchObject({
      code: "team_lead_not_deployed",
      status: 409,
      details: { lead: "missing-standing-lead" },
    } satisfies Partial<TeamDeployError>);
    expect(mocks.insertedTeamValues).toEqual([]);
    expect(mocks.insertedTeamMemberValues).toEqual([]);
  });
});
