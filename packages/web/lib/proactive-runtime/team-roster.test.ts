import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  rows: [] as Array<{
    memberId?: string;
    teamId?: string;
    sandboxId?: string | null;
    memberName: string;
    role: string;
    personaVersionSpec: Record<string, unknown> | null;
    personaSpec: Record<string, unknown> | null;
  }>,
}));

vi.mock("@/lib/db", () => ({
  getDb: mocks.getDb,
}));

import { readTeamRosterMemberConfig, readTeamRosterMemberConfigs } from "./team-roster";

function dbMock() {
  const query = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    leftJoin: vi.fn(),
    where: vi.fn(),
    // The plural read awaits the orderBy() return directly (no `.limit(1)` —
    // the singular wrapper takes rows[0] instead).
    orderBy: vi.fn(async () => mocks.rows),
  };
  query.from.mockReturnValue(query);
  query.innerJoin.mockReturnValue(query);
  query.leftJoin.mockReturnValue(query);
  query.where.mockReturnValue(query);
  return {
    select: vi.fn(() => query),
    query,
  };
}

describe("team-roster", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.rows = [];
    mocks.getDb.mockReturnValue(dbMock());
  });

  it("resolves a launchable member from the standing team binding", async () => {
    const deployedSpec = {
      persona: {
        slug: "cloud-team-issue",
        harness: "claude",
        model: "claude-sonnet-4-6",
      },
      agent: {},
    };
    mocks.rows = [
      {
        memberName: "cloud-team-issue-n1",
        role: "implementer",
        personaVersionSpec: deployedSpec,
        personaSpec: { slug: "stale-persona-row" },
      },
    ];

    await expect(readTeamRosterMemberConfig({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      leadAgentId: "00000000-0000-0000-0000-000000000002",
      memberName: null,
    })).resolves.toEqual({
      memberName: "cloud-team-issue-n1",
      role: "implementer",
      personaSpec: deployedSpec,
    });
  });

  it("falls back to the current persona row when a pinned version is absent", async () => {
    const currentSpec = {
      persona: {
        slug: "cloud-team-issue",
        harness: "codex",
      },
      agent: {},
    };
    mocks.rows = [
      {
        memberName: "cloud-team-issue-n1",
        role: "implementer",
        personaVersionSpec: null,
        personaSpec: currentSpec,
      },
    ];

    await expect(readTeamRosterMemberConfig({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      leadAgentId: "00000000-0000-0000-0000-000000000002",
      memberName: "cloud-team-issue-n1",
    })).resolves.toEqual({
      memberName: "cloud-team-issue-n1",
      role: "implementer",
      personaSpec: currentSpec,
    });
  });

  it("returns null when no team member row resolves", async () => {
    await expect(readTeamRosterMemberConfig({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      leadAgentId: "00000000-0000-0000-0000-000000000002",
      memberName: null,
    })).resolves.toBeNull();
  });

  it("returns every roster member in name order with durable identity (plural read)", async () => {
    const spec = { persona: { slug: "cloud-team-issue", harness: "claude" }, agent: {} };
    mocks.rows = [
      {
        memberId: "member-row-a",
        teamId: "team-1",
        sandboxId: null,
        memberName: "team-member-a",
        role: "implementer",
        personaVersionSpec: spec,
        personaSpec: null,
      },
      {
        memberId: "member-row-b",
        teamId: "team-1",
        sandboxId: "sbx-existing",
        memberName: "team-member-b",
        role: "reviewer",
        personaVersionSpec: spec,
        personaSpec: null,
      },
    ];

    await expect(readTeamRosterMemberConfigs({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      leadAgentId: "00000000-0000-0000-0000-000000000002",
      memberName: null,
    })).resolves.toEqual([
      {
        memberId: "member-row-a",
        teamId: "team-1",
        sandboxId: null,
        memberName: "team-member-a",
        role: "implementer",
        personaSpec: spec,
      },
      {
        memberId: "member-row-b",
        teamId: "team-1",
        sandboxId: "sbx-existing",
        memberName: "team-member-b",
        role: "reviewer",
        personaSpec: spec,
      },
    ]);
  });

  it("singular read returns exactly the first row of the plural read (N=1 byte-identity)", async () => {
    const spec = { persona: { slug: "cloud-team-issue" }, agent: {} };
    mocks.rows = [
      {
        memberId: "member-row-a",
        teamId: "team-1",
        sandboxId: null,
        memberName: "team-member-a",
        role: "implementer",
        personaVersionSpec: spec,
        personaSpec: null,
      },
      {
        memberId: "member-row-b",
        teamId: "team-1",
        sandboxId: null,
        memberName: "team-member-b",
        role: "reviewer",
        personaVersionSpec: spec,
        personaSpec: null,
      },
    ];

    const [first] = await readTeamRosterMemberConfigs({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      leadAgentId: "00000000-0000-0000-0000-000000000002",
      memberName: null,
    });
    await expect(readTeamRosterMemberConfig({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      leadAgentId: "00000000-0000-0000-0000-000000000002",
      memberName: null,
    })).resolves.toEqual(first);
  });
});
