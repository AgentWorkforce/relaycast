import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  hasWorkspaceAccess: vi.fn(),
  getDb: vi.fn(),
  db: {
    execute: vi.fn(),
    insert: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/lib/auth/request-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/request-auth")>()),
  resolveRequestAuth: mocks.resolveRequestAuth,
}));

vi.mock("@/lib/integrations/integration-route-handler", () => ({
  hasWorkspaceAccess: mocks.hasWorkspaceAccess,
}));

vi.mock("@/lib/db", () => ({
  getDb: mocks.getDb,
}));

import { GET } from "./route";

const workspaceId = "00000000-0000-0000-0000-000000000002";
const auth = {
  userId: "00000000-0000-0000-0000-000000000001",
  workspaceId,
  organizationId: "00000000-0000-0000-0000-000000000003",
  source: "token" as const,
  scopes: ["cli:auth"],
};

function context() {
  return { params: Promise.resolve({ workspaceId }) };
}

function mockDeploymentListRows(
  rows: Array<{
    agentId: string;
    personaId: string;
    deployedName: string;
    status: string;
    createdAt: Date;
    lastUsedAt: Date | null;
    scheduleIds: string[] | null;
    inputValues?: Record<string, string>;
    imageUrl?: string | null;
    personaVersionSpec?: Record<string, unknown> | null;
    personaDescription?: string | null;
    deployedByUserId: string;
  }>,
  runSummaries: Array<Record<string, unknown>> = [],
  latestRunSummaries: Array<Record<string, unknown>> = [],
) {
  const limit = vi.fn(async () => rows);
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ orderBy }));
  const joinChain = {
    leftJoin: vi.fn(() => joinChain),
    where,
  };
  const from = vi.fn(() => joinChain);
  mocks.db.select.mockReturnValue({ from });
  mocks.db.execute.mockResolvedValueOnce({ rows: runSummaries });
  if (latestRunSummaries.length > 0) {
    mocks.db.execute.mockResolvedValueOnce({ rows: latestRunSummaries });
  }
  return { from, where, orderBy, limit };
}

function mockDb() {
  mocks.db.insert.mockReturnValue({
    values: vi.fn(async () => undefined),
  });
  mocks.db.select.mockReturnValue({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => [{ id: "sbx_deploy" }]),
      })),
    })),
  });
  mocks.db.update.mockReturnValue({
    set: vi.fn(() => ({
      where: vi.fn(async () => undefined),
    })),
  });
  mocks.getDb.mockReturnValue(mocks.db);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolveRequestAuth.mockResolvedValue(auth);
  mocks.hasWorkspaceAccess.mockReturnValue(true);
  mockDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deployment list last run summaries", () => {
  it("includes lastRunStatus and lastError on each deployment row", async () => {
    mockDeploymentListRows(
      [
        {
          agentId: "agent-1",
          personaId: "persona-1",
          deployedName: "weekly-digest",
          status: "active",
          createdAt: new Date("2026-05-13T08:00:00.000Z"),
          lastUsedAt: null,
          scheduleIds: ["sched_1"],
          inputValues: {},
          deployedByUserId: auth.userId,
        },
      ],
      [
        {
          agent_id: "agent-1",
          last_fired_at: "2026-05-13T09:00:00.000Z",
          last_completed_at: "2026-05-13T09:02:00.000Z",
          run_count: "3",
        },
      ],
      [
        {
          agent_id: "agent-1",
          last_run_status: "failed",
          last_error: "linear.getIssue ENOENT",
        },
      ],
    );

    const response = await GET(
      new NextRequest(`https://cloud.test/api/v1/workspaces/${workspaceId}/deployments`),
      context(),
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({
      agents: [
        {
          agentId: "agent-1",
          personaId: "persona-1",
          deployedName: "weekly-digest",
          status: "active",
          createdAt: "2026-05-13T08:00:00.000Z",
          lastUsedAt: null,
          lastFiredAt: "2026-05-13T09:00:00.000Z",
          lastCompletedAt: "2026-05-13T09:02:00.000Z",
          lastRunStatus: "failed",
          lastError: "linear.getIssue ENOENT",
          runCount: 3,
          scheduleIds: ["sched_1"],
          scheduleSpecs: [],
          inputValues: {},
          inputSpecs: {},
          imageUrl: null,
          personaDescription: null,
          deployedByUserId: auth.userId,
        },
      ],
      nextCursor: null,
    });
  });
});
