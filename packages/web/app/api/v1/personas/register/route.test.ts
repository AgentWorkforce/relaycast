import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
}));

vi.mock("@/lib/db", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@/lib/db/schema", () => ({
  agents: {
    id: "agents.id",
    workspaceId: "agents.workspace_id",
    deployedName: "agents.deployed_name",
    executor: "agents.executor",
    ownerService: "agents.owner_service",
    sourceTag: "agents.source_tag",
    updatedAt: "agents.updated_at",
  },
}));

import { POST } from "./route";

function request(body: unknown, token: string | null = "service-token"): NextRequest {
  return new NextRequest("http://localhost/api/v1/personas/register", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}`, "content-type": "application/json" } : { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function mockDbWithExistingAgent(agent: { id: string; executor?: unknown; sourceTag?: string | null }) {
  const whereChain = {
    limit: vi.fn().mockResolvedValue([agent]),
  };
  const fromChain = {
    where: vi.fn().mockReturnValue(whereChain),
  };
  const selectChain = {
    from: vi.fn().mockReturnValue(fromChain),
  };
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  return {
    select: vi.fn().mockReturnValue(selectChain),
    update: vi.fn().mockReturnValue({ set: updateSet }),
    _updateSet: updateSet,
    _updateWhere: updateWhere,
  };
}

function mockDbWithNoAgent() {
  const whereChain = { limit: vi.fn().mockResolvedValue([]) };
  const fromChain = { where: vi.fn().mockReturnValue(whereChain) };
  const selectChain = { from: vi.fn().mockReturnValue(fromChain) };
  return {
    select: vi.fn().mockReturnValue(selectChain),
    update: vi.fn(),
  };
}

describe("POST /api/v1/personas/register", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects request with no bearer token", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce(null);
    const res = await POST(request({ source: "sage", personas: [] }, null));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("unauthenticated");
  });

  it("rejects malformed JSON body", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      source: "service",
      workspaceId: "ws_1",
      userId: "u_1",
      bearerToken: "tok",
    });
    const res = await POST(request("not-json{", "tok"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid_body");
  });

  it("rejects invalid payload shape", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      source: "service",
      workspaceId: "ws_1",
      userId: "u_1",
      bearerToken: "tok",
    });
    const res = await POST(request({ source: "sage", personas: [{ id: "" }] }, "tok"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid_payload");
  });

  it("rejects cross-service registration from a workspace token", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      source: "token",
      workspaceId: "ws_1",
      userId: "u_1",
      bearerToken: "workspace-tok",
    });
    const res = await POST(
      request(
        {
          source: "workforce-cli@3.0",
          personas: [
            {
              id: "sage:morning-briefing",
              intent: "morning-briefing",
              description: "Daily summary",
              ownerService: "sage",
            },
          ],
        },
        "workspace-tok",
      ),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("cross_service_registration_forbidden");
  });

  it("rejects sage token claiming a different ownerService", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      source: "service",
      workspaceId: "ws_1",
      userId: "u_sage_service",
      bearerToken: "sage-tok",
    });
    const res = await POST(
      request(
        {
          source: "sage@1.5",
          personas: [
            {
              id: "nightcto:cto-lead",
              intent: "cto",
              description: "n",
              ownerService: "nightcto",
            },
          ],
        },
        "sage-tok",
      ),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("cross_service_registration_forbidden");
  });

  it("returns 200 + unchanged when existing row matches executor + source", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      source: "service",
      workspaceId: "ws_1",
      userId: "u_sage_service",
      bearerToken: "sage-tok",
    });
    const db = mockDbWithExistingAgent({
      id: "agt_existing",
      executor: { kind: "ephemeral-sandbox" },
      sourceTag: "sage@1.5",
    });
    mocks.getDb.mockReturnValueOnce(db);
    const res = await POST(
      request(
        {
          source: "sage@1.5",
          personas: [
            {
              id: "sage:morning-briefing",
              intent: "morning-briefing",
              description: "Daily summary",
              ownerService: "sage",
              executor: { kind: "ephemeral-sandbox" },
            },
          ],
        },
        "sage-tok",
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].status).toBe("unchanged");
    expect(body.results[0].agentId).toBe("agt_existing");
  });

  it("rejects unknown personas (no existing agent row)", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      source: "service",
      workspaceId: "ws_1",
      userId: "u_sage_service",
      bearerToken: "sage-tok",
    });
    const db = mockDbWithNoAgent();
    mocks.getDb.mockReturnValueOnce(db);
    const res = await POST(
      request(
        {
          source: "sage@1.5",
          personas: [
            {
              id: "sage:never-deployed",
              intent: "x",
              description: "x",
              ownerService: "sage",
            },
          ],
        },
        "sage-tok",
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].status).toBe("rejected");
    expect(body.results[0].reason).toMatch(/not yet provisioned/);
  });

  it("honors workspaceIds[] override", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      source: "service",
      workspaceId: "ws_default",
      userId: "u_sage_service",
      bearerToken: "sage-tok",
    });
    const db = mockDbWithNoAgent();
    mocks.getDb.mockReturnValueOnce(db);
    await POST(
      request(
        {
          source: "sage@1.5",
          workspaceIds: ["ws_a", "ws_b"],
          personas: [
            {
              id: "sage:morning-briefing",
              intent: "x",
              description: "x",
              ownerService: "sage",
            },
          ],
        },
        "sage-tok",
      ),
    );
    // Each workspace produces a select call: 2 workspaces × 1 persona = 2 selects.
    expect(db.select).toHaveBeenCalledTimes(2);
  });
});
