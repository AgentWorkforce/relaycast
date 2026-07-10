import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  requireSessionAuth: vi.fn(),
  requireAuthScope: vi.fn(),
  hasWorkspaceAccess: vi.fn(),
  bindTeam: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
  requireSessionAuth: mocks.requireSessionAuth,
  requireAuthScope: mocks.requireAuthScope,
}));

vi.mock("@/lib/integrations/integration-route-handler", () => ({
  hasWorkspaceAccess: mocks.hasWorkspaceAccess,
}));

vi.mock("@/lib/proactive-runtime/team-deploy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/proactive-runtime/team-deploy")>()),
  bindTeam: mocks.bindTeam,
}));

import { PUT } from "./route";

const workspaceId = "00000000-0000-0000-0000-000000000002";
const auth = {
  userId: "00000000-0000-0000-0000-000000000001",
  workspaceId,
  organizationId: "00000000-0000-0000-0000-000000000003",
  source: "token" as const,
  scopes: ["cli:auth"],
};

function request(body: unknown): NextRequest {
  return new NextRequest(`https://cloud.test/api/v1/workspaces/${workspaceId}/teams`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

function context() {
  return { params: Promise.resolve({ workspaceId }) };
}

function spec() {
  return {
    id: "cloud-team-issue",
    lead: "lead",
    members: [
      { name: "lead", persona: { slug: "cloud-team-issue" }, role: "lead" },
      { name: "impl", persona: { slug: "cloud-small-issue-codex" } },
    ],
  };
}

describe("PUT /api/v1/workspaces/[workspaceId]/teams", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue(auth);
    mocks.requireSessionAuth.mockReturnValue(false);
    mocks.requireAuthScope.mockImplementation((candidate, scope) =>
      Boolean(candidate?.scopes?.includes(scope)),
    );
    mocks.hasWorkspaceAccess.mockReturnValue(true);
    mocks.bindTeam.mockResolvedValue({
      teamId: "team_1",
      slug: "cloud-team-issue",
      leadMemberName: "lead",
      tokenBudget: null,
      timeBudgetSeconds: null,
      members: [],
    });
  });

  it("binds a parsed team spec for authorized callers", async () => {
    const response = await PUT(request({ spec: spec() }), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      teamId: "team_1",
      slug: "cloud-team-issue",
    });
    expect(mocks.bindTeam).toHaveBeenCalledWith({
      workspaceId,
      spec: expect.objectContaining({ id: "cloud-team-issue", lead: "lead" }),
    });
  });

  it("returns 401 without auth", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce(null);

    const response = await PUT(request({ spec: spec() }), context());

    expect(response.status).toBe(401);
    expect(mocks.bindTeam).not.toHaveBeenCalled();
  });

  it("returns 403 when auth lacks team write permission", async () => {
    mocks.requireAuthScope.mockReturnValue(false);

    const response = await PUT(request({ spec: spec() }), context());

    expect(response.status).toBe(403);
    expect(mocks.bindTeam).not.toHaveBeenCalled();
  });

  it("returns 422 for invalid team specs", async () => {
    const response = await PUT(
      request({ spec: { id: "team", lead: "lead", members: [] } }),
      context(),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_team_spec" });
    expect(mocks.bindTeam).not.toHaveBeenCalled();
  });
});
