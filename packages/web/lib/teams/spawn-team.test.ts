import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  pathScope,
} from "@cloud/core/proactive-runtime/member-token-scope.js";

const dbMock = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  inserts: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => dbMock.selectQueue.shift() ?? [],
        }),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        dbMock.inserts.push(values);
        return Promise.resolve();
      },
    }),
  }),
}));

vi.mock("@/lib/teams/reaper", () => ({
  countActiveTeamMembers: vi.fn(async () => 0),
}));

vi.mock("@/lib/relaycast/channels", () => ({
  createRelaycastChannel: vi.fn(async () => ({ channel: "team-channel" })),
}));

vi.mock("@/lib/proactive-runtime/factory-fleet-emitter", () => ({
  createDefaultFactoryFleetEmitter: vi.fn(),
}));

import {
  assignedRootForTeamMember,
  parseSpawnBody,
  spawnTeam,
  SpawnTeamError,
} from "./spawn-team";
import type { FactorySpawnInput } from "@/lib/proactive-runtime/factory-fleet-emitter";

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task: "refactor auth",
    members: [{ name: "impl", persona: "code-implementer", task: "auth/session.ts" }],
    ...over,
  };
}

describe("parseSpawnBody", () => {
  it("accepts a minimal valid body and defaults ttl", () => {
    const parsed = parseSpawnBody(body());
    expect(parsed.task).toBe("refactor auth");
    expect(parsed.ttlSeconds).toBe(3600);
    expect(parsed.members).toHaveLength(1);
    expect(parsed.members[0]).toMatchObject({ name: "impl", role: "worker", task: "auth/session.ts" });
  });

  it("rejects a missing task", () => {
    expect(() => parseSpawnBody(body({ task: "   " }))).toThrow(/task is required/);
  });

  it("rejects an empty members array", () => {
    expect(() => parseSpawnBody(body({ members: [] }))).toThrow(/members must be a non-empty array/);
  });

  it("clamps ttlSeconds to the max", () => {
    expect(parseSpawnBody(body({ ttlSeconds: 999999 })).ttlSeconds).toBe(21600);
  });

  it("rejects a non-positive ttl", () => {
    expect(() => parseSpawnBody(body({ ttlSeconds: 0 }))).toThrow(/ttlSeconds must be a positive/);
  });

  it("rejects more than one orchestrator", () => {
    expect(() =>
      parseSpawnBody(
        body({
          members: [
            { name: "a", persona: "p", role: "orchestrator" },
            { name: "b", persona: "p", role: "orchestrator" },
          ],
        }),
      ),
    ).toThrow(/at most one orchestrator/);
  });

  it("rejects duplicate member names", () => {
    expect(() =>
      parseSpawnBody(
        body({
          members: [
            { name: "dup", persona: "p", task: "x" },
            { name: "dup", persona: "q", task: "y" },
          ],
        }),
      ),
    ).toThrow(/duplicate member name/);
  });

  it("rejects an invalid role", () => {
    expect(() =>
      parseSpawnBody(body({ members: [{ name: "a", persona: "p", role: "boss" }] })),
    ).toThrow(/role is invalid/);
  });

  it("injects a synthetic relay-orchestrator lead when a worker is unassigned and no orchestrator exists", () => {
    const parsed = parseSpawnBody(
      body({ members: [{ name: "impl", persona: "code-implementer" }] }),
    );
    expect(parsed.members).toHaveLength(2);
    expect(parsed.members[0]).toMatchObject({
      name: "lead",
      persona: "relay-orchestrator",
      role: "orchestrator",
    });
    expect(parsed.members[1]).toMatchObject({ name: "impl", role: "worker" });
  });

  it("does NOT inject a lead when every worker has an explicit task", () => {
    const parsed = parseSpawnBody(
      body({
        members: [
          { name: "a", persona: "p", task: "x" },
          { name: "b", persona: "q", task: "y" },
        ],
      }),
    );
    expect(parsed.members).toHaveLength(2);
    expect(parsed.members.some((m) => m.persona === "relay-orchestrator")).toBe(false);
  });

  it("does NOT inject a lead when an orchestrator is already declared", () => {
    const parsed = parseSpawnBody(
      body({
        members: [
          { name: "lead", persona: "custom-lead", role: "orchestrator" },
          { name: "impl", persona: "code-implementer" },
        ],
      }),
    );
    expect(parsed.members).toHaveLength(2);
    expect(parsed.members.filter((m) => m.role === "orchestrator")).toHaveLength(1);
    expect(parsed.members[0].persona).toBe("custom-lead");
  });

  it("enforces teamSolve maxMembers=4 by default and as a hard cap", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ name: `m${i}`, persona: "p", task: "t" }));
    expect(() => parseSpawnBody(body({ members: five }))).toThrow(/exceeds maxMembers/);
    expect(() => parseSpawnBody(body({ members: five, maxMembers: 8 }))).toThrow(/exceeds maxMembers/);
  });

  it("throws SpawnTeamError with a 422 status for validation failures", () => {
    try {
      parseSpawnBody(body({ task: "" }));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SpawnTeamError);
      expect((err as SpawnTeamError).status).toBe(422);
    }
  });
});

describe("spawnTeam fleet-emit path", () => {
  beforeEach(() => {
    dbMock.selectQueue = [];
    dbMock.inserts = [];
  });

  it("emits one fleet spawn per resolved member and returns fleet-shaped member views", async () => {
    // Parent ownership lookup, then one persona lookup for the single member.
    dbMock.selectQueue.push([{ id: "parent-1" }]);
    dbMock.selectQueue.push([{ id: "persona-impl", specHash: "spec-hash-1" }]);

    const emitSpawn = vi.fn(async (input: FactorySpawnInput) => ({
      invocationId: input.invocationId,
      name: input.name,
    }));
    const buildSpawnInput = vi.fn((args: { spawnInput: FactorySpawnInput }) => args.spawnInput);
    const createChannel = vi.fn(async () => ({ channel: "team-channel" }));

    const result = await spawnTeam(
      {
        workspaceId: "workspace-a",
        parentAgentId: "parent-1",
        deployerUserId: "user-1",
        organizationId: "org-1",
        body: {
          task: "do the thing",
          members: [{ name: "impl", persona: "code-implementer", task: "auth.ts" }],
        },
      },
      { createChannel, buildSpawnInput, emitSpawn },
    );

    // Exactly one spawn emitted, with the team recipe + spawn:claude capability
    // and the deterministic per-member invocationId.
    expect(emitSpawn).toHaveBeenCalledTimes(1);
    const spawnArg = emitSpawn.mock.calls[0]?.[0] as FactorySpawnInput;
    expect(spawnArg.capability).toBe("spawn:claude");
    expect(spawnArg.recipe).toBe("team");
    expect(spawnArg.persona).toBe("code-implementer");
    expect(spawnArg.invocationId).toBe(`factory:team:${result.teamId}:impl`);

    // Returned member view is fleet-shaped: no sandbox, no local write scopes.
    expect(result.members).toHaveLength(1);
    expect(result.members[0]).toMatchObject({
      name: "impl",
      role: "worker",
      sandboxId: null,
      writeScopes: [],
      status: "starting",
      invocationId: `factory:team:${result.teamId}:impl`,
    });

    // teamMembers row carries resultId = invocationId.
    const memberRow = dbMock.inserts.find(
      (row) => row?.name === "impl" && "resultId" in row,
    );
    expect(memberRow?.resultId).toBe(`factory:team:${result.teamId}:impl`);

    // member_spawn_emitted team event recorded for the member.
    const memberEvent = dbMock.inserts.find((row) => row?.kind === "member_spawn_emitted");
    expect(memberEvent).toMatchObject({
      memberName: "impl",
      kind: "member_spawn_emitted",
      payload: expect.objectContaining({
        invocationId: `factory:team:${result.teamId}:impl`,
      }),
    });
  });

  it("emits a spawn for every member of a multi-member team", async () => {
    dbMock.selectQueue.push([{ id: "parent-1" }]);
    dbMock.selectQueue.push([{ id: "persona-a", specHash: "h-a" }]);
    dbMock.selectQueue.push([{ id: "persona-b", specHash: "h-b" }]);

    const emitSpawn = vi.fn(async (input: { invocationId: string; name: string }) => ({
      invocationId: input.invocationId,
      name: input.name,
    }));

    const result = await spawnTeam(
      {
        workspaceId: "workspace-a",
        parentAgentId: "parent-1",
        deployerUserId: "user-1",
        organizationId: "org-1",
        body: {
          task: "do the thing",
          members: [
            { name: "a", persona: "p-a", task: "x" },
            { name: "b", persona: "p-b", task: "y" },
          ],
        },
      },
      {
        createChannel: vi.fn(async () => ({ channel: "team-channel" })),
        buildSpawnInput: (args) => args.spawnInput,
        emitSpawn,
      },
    );

    expect(emitSpawn).toHaveBeenCalledTimes(2);
    expect(result.members.map((member) => member.invocationId)).toEqual([
      `factory:team:${result.teamId}:a`,
      `factory:team:${result.teamId}:b`,
    ]);
    expect(result.members.every((member) => member.sandboxId === null)).toBe(true);
  });
});

describe("team member fleet metadata", () => {
  it("derives concrete, disjoint per-member assigned roots under the team subtree", () => {
    const implRoot = assignedRootForTeamMember("team_123", "impl/one");
    const reviewRoot = assignedRootForTeamMember("team_123", "reviewer");

    expect(implRoot).toBe("/teams/team_123/members/impl-one");
    expect(reviewRoot).toBe("/teams/team_123/members/reviewer");
    expect(pathScope(implRoot)).toBe("relayfile:fs:write:/teams/team_123/members/impl-one/*");
    expect(pathScope(reviewRoot)).toBe("relayfile:fs:write:/teams/team_123/members/reviewer/*");
  });
});
