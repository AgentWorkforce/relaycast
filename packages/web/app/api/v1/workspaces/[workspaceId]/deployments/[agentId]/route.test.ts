import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CI_DEPLOYMENTS_WRITE_SCOPE } from "@/lib/auth/api-token-types";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  resolveWorkspaceIntegrationIdentity: vi.fn(),
  hasWorkspaceIntegrationAccess: vi.fn(),
  cancelCronSchedule: vi.fn(),
  resolveAgentGatewayRelaycronEnv: vi.fn(),
  registerCronSchedules: vi.fn(),
  getDb: vi.fn(),
  db: {
    execute: vi.fn(),
  },
}));

vi.mock("@/lib/auth/request-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/request-auth")>()),
  resolveRequestAuth: mocks.resolveRequestAuth,
}));

vi.mock("@/lib/workspaces/workspace-integration-identity", () => ({
  resolveWorkspaceIntegrationIdentity: mocks.resolveWorkspaceIntegrationIdentity,
  hasWorkspaceIntegrationAccess: mocks.hasWorkspaceIntegrationAccess,
}));

vi.mock("@/lib/db", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@/lib/proactive-runtime/agent-gateway-relaycron-client", () => ({
  registerCronSchedules: mocks.registerCronSchedules,
  cancelCronSchedule: mocks.cancelCronSchedule,
  resolveAgentGatewayRelaycronEnv: mocks.resolveAgentGatewayRelaycronEnv,
}));

import { DELETE } from "./route";

const workspaceId = "00000000-0000-0000-0000-000000000002";
const otherWorkspaceId = "00000000-0000-0000-0000-000000000099";
const agentId = "55555555-5555-4555-8555-555555555555";
const auth = {
  userId: "00000000-0000-0000-0000-000000000001",
  workspaceId,
  organizationId: "00000000-0000-0000-0000-000000000003",
  source: "token" as const,
  scopes: ["cli:auth"],
};

function request(): NextRequest {
  return new NextRequest(
    `https://cloud.test/api/v1/workspaces/${workspaceId}/deployments/${agentId}`,
    { method: "DELETE" },
  );
}

function context(overrides: Partial<{ workspaceId: string; agentId: string }> = {}) {
  return {
    params: Promise.resolve({
      workspaceId: overrides.workspaceId ?? workspaceId,
      agentId: overrides.agentId ?? agentId,
    }),
  };
}

function queueExecuteRows(rows: Array<Array<Record<string, unknown>>>) {
  for (const rowSet of rows) {
    mocks.db.execute.mockResolvedValueOnce({ rows: rowSet });
  }
}

function sqlText(value: unknown): string {
  if (!value || typeof value !== "object" || !("queryChunks" in value)) {
    return "";
  }
  return ((value as { queryChunks: unknown[] }).queryChunks)
    .map((chunk) => {
      if (typeof chunk === "string") {
        return "?";
      }
      if (chunk && typeof chunk === "object" && "value" in chunk) {
        const inner = (chunk as { value: unknown }).value;
        return Array.isArray(inner) ? inner.join("") : String(inner);
      }
      return "?";
    })
    .join("");
}

function sqlBoundValues(value: unknown): unknown[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  if ("toQuery" in value && typeof value.toQuery === "function") {
    return (
      value.toQuery({
        escapeName: (name: string) => `"${name}"`,
        escapeParam: (_index: number, param: unknown) => String(param),
        escapeString: (text: string) => `'${text}'`,
      }).params ?? []
    );
  }
  if (!("queryChunks" in value)) return [];
  return ((value as { queryChunks: unknown[] }).queryChunks)
    .flatMap((chunk) => {
      if (chunk && typeof chunk === "object" && "value" in chunk) {
        const inner = (chunk as { value: unknown }).value;
        return Array.isArray(inner) ? inner : [inner];
      }
      return [];
    });
}

describe("DELETE /api/v1/workspaces/[workspaceId]/deployments/[agentId]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue(auth);
    mocks.resolveWorkspaceIntegrationIdentity.mockImplementation(async (wid: string) => ({
      requestedWorkspaceId: wid,
      appWorkspaceId: wid,
      relayWorkspaceId: wid,
      organizationId: null,
      candidateWorkspaceIds: [wid],
    }));
    mocks.hasWorkspaceIntegrationAccess.mockReturnValue(true);
    mocks.resolveAgentGatewayRelaycronEnv.mockReturnValue({
      RELAYCRON_URL: "https://relaycron.test",
      RELAYCRON_API_KEY: "relaycron-key",
    });
    mocks.cancelCronSchedule.mockResolvedValue(undefined);
    mocks.getDb.mockReturnValue(mocks.db);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("returns 401 when the request is unauthenticated", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce(null);

    const response = await DELETE(request(), context());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "unauthorized" });
    expect(mocks.db.execute).not.toHaveBeenCalled();
  });

  it("returns 403 when the auth token cannot deploy", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      ...auth,
      scopes: ["workflow:runs:read"],
    });

    const response = await DELETE(request(), context());

    expect(response.status).toBe(403);
    expect(mocks.db.execute).not.toHaveBeenCalled();
  });

  it("returns 403 for CI-only deploy tokens", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      ...auth,
      subjectType: "ci",
      scopes: [CI_DEPLOYMENTS_WRITE_SCOPE],
    });

    const response = await DELETE(request(), context());

    expect(response.status).toBe(403);
    expect(mocks.db.execute).not.toHaveBeenCalled();
  });

  it("returns 403 when the auth has no access to the target workspace", async () => {
    mocks.hasWorkspaceIntegrationAccess.mockReturnValueOnce(false);

    const response = await DELETE(request(), context());

    expect(response.status).toBe(403);
    expect(mocks.db.execute).not.toHaveBeenCalled();
  });

  it("accepts a relaycast (rw_) URL id when the token carries the app UUID, and destroys against the app id", async () => {
    // Regression for the 403-when-authed bug: the CLI sends the relaycast id in
    // the URL while the token's workspaceId is the app UUID. Exact-equality
    // 403'd; the identity-aware check accepts either form. destroyAgent must run
    // against the APP id (agents.workspace_id is keyed by app UUID).
    const relayUrlId = "rw_7ccfea89";
    const appUuid = workspaceId;
    mocks.resolveWorkspaceIntegrationIdentity.mockResolvedValueOnce({
      requestedWorkspaceId: relayUrlId,
      appWorkspaceId: appUuid,
      relayWorkspaceId: relayUrlId,
      organizationId: null,
      candidateWorkspaceIds: [relayUrlId, appUuid],
    });
    queueExecuteRows([
      [{ id: agentId, workspace_id: appUuid, status: "active", schedule_ids: [] }],
      [{ id: agentId }],
    ]);

    const response = await DELETE(
      new NextRequest(
        `https://cloud.test/api/v1/workspaces/${relayUrlId}/deployments/${agentId}`,
        { method: "DELETE" },
      ),
      context({ workspaceId: relayUrlId }),
    );

    expect(response.status).toBe(200);
    // The destroy SELECT/UPDATE bind the resolved app UUID, not the rw_ URL id.
    const selectParams = JSON.stringify(sqlBoundValues(mocks.db.execute.mock.calls[0]?.[0]));
    expect(selectParams).toContain(appUuid);
    expect(selectParams).not.toContain(relayUrlId);
  });

  it("returns 404 for an accessible relaycast id that is not bound to an app UUID", async () => {
    const relayUrlId = "rw_unbound";
    mocks.resolveWorkspaceIntegrationIdentity.mockResolvedValueOnce({
      requestedWorkspaceId: relayUrlId,
      appWorkspaceId: null,
      relayWorkspaceId: relayUrlId,
      organizationId: null,
      candidateWorkspaceIds: [relayUrlId],
    });
    mocks.hasWorkspaceIntegrationAccess.mockReturnValueOnce(true);

    const response = await DELETE(
      new NextRequest(
        `https://cloud.test/api/v1/workspaces/${relayUrlId}/deployments/${agentId}`,
        { method: "DELETE" },
      ),
      context({ workspaceId: relayUrlId }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "workspace_not_found" });
    expect(mocks.db.execute).not.toHaveBeenCalled();
  });

  it("returns 404 when the agent does not exist", async () => {
    queueExecuteRows([[]]);

    const response = await DELETE(request(), context());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "agent_not_found" });
    expect(mocks.cancelCronSchedule).not.toHaveBeenCalled();
  });

  it("returns 404 when the agent belongs to a different workspace", async () => {
    queueExecuteRows([
      [
        {
          id: agentId,
          workspace_id: otherWorkspaceId,
          status: "active",
          schedule_ids: ["sched_1"],
        },
      ],
    ]);

    const response = await DELETE(request(), context());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "agent_not_found" });
    expect(mocks.cancelCronSchedule).not.toHaveBeenCalled();
  });

  it("returns 404 (idempotent) when the agent is already destroyed", async () => {
    queueExecuteRows([
      [
        {
          id: agentId,
          workspace_id: workspaceId,
          status: "destroyed",
          schedule_ids: [],
        },
      ],
    ]);

    const response = await DELETE(request(), context());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "agent_not_found" });
    expect(mocks.cancelCronSchedule).not.toHaveBeenCalled();
    // Only the SELECT runs; no UPDATE for already-destroyed agents.
    expect(mocks.db.execute).toHaveBeenCalledTimes(1);
  });

  it("cancels all schedule ids and marks the agent destroyed on the happy path", async () => {
    queueExecuteRows([
      [
        {
          id: agentId,
          workspace_id: workspaceId,
          status: "active",
          schedule_ids: ["sched_a", "sched_b"],
        },
      ],
      [{ id: agentId }],
    ]);

    const response = await DELETE(request(), context());

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      agentId: string;
      status: string;
      destroyedAt: string;
      cancelledScheduleIds: string[];
    };
    expect(body.agentId).toBe(agentId);
    expect(body.status).toBe("destroyed");
    expect(body.cancelledScheduleIds).toEqual(["sched_a", "sched_b"]);
    expect(typeof body.destroyedAt).toBe("string");
    expect(Number.isNaN(Date.parse(body.destroyedAt))).toBe(false);

    expect(mocks.cancelCronSchedule).toHaveBeenCalledTimes(2);
    expect(mocks.cancelCronSchedule).toHaveBeenNthCalledWith(
      1,
      {
        RELAYCRON_URL: "https://relaycron.test",
        RELAYCRON_API_KEY: "relaycron-key",
      },
      "sched_a",
    );
    expect(mocks.cancelCronSchedule).toHaveBeenNthCalledWith(
      2,
      {
        RELAYCRON_URL: "https://relaycron.test",
        RELAYCRON_API_KEY: "relaycron-key",
      },
      "sched_b",
    );

    const queries = mocks.db.execute.mock.calls.map(([query]) => sqlText(query)).join("\n");
    expect(queries).toContain("UPDATE agents");
    expect(queries).toContain("status = ");
    expect(queries).toContain("destroyed_at");
    expect(queries).toContain("destroyed_by_user_id");
    expect(queries).toContain("schedule_ids = ");
    expect(queries).toContain("schedule_webhook_secret_hash = ");
    expect(queries).toContain("workspace_id = ");
    expect(queries).toContain("status != ");
    expect(queries).toContain("RETURNING id");
  });

  it("succeeds with an empty cancelledScheduleIds array when the agent has no schedules", async () => {
    queueExecuteRows([
      [
        {
          id: agentId,
          workspace_id: workspaceId,
          status: "active",
          schedule_ids: [],
        },
      ],
      [{ id: agentId }],
    ]);

    const response = await DELETE(request(), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      agentId,
      status: "destroyed",
      cancelledScheduleIds: [],
    });
    expect(mocks.cancelCronSchedule).not.toHaveBeenCalled();
    expect(mocks.resolveAgentGatewayRelaycronEnv).not.toHaveBeenCalled();
  });

  it("continues destroying when a single cancelCronSchedule call fails", async () => {
    queueExecuteRows([
      [
        {
          id: agentId,
          workspace_id: workspaceId,
          status: "active",
          schedule_ids: ["sched_ok", "sched_boom", "sched_also_ok"],
        },
      ],
      [{ id: agentId }],
    ]);
    mocks.cancelCronSchedule
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("relaycron unreachable"))
      .mockResolvedValueOnce(undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = await DELETE(request(), context());

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        cancelledScheduleIds: ["sched_ok", "sched_also_ok"],
        status: "destroyed",
      });
      expect(mocks.cancelCronSchedule).toHaveBeenCalledTimes(3);
      // Update still runs even when an individual cancel fails.
      const updateQuery = mocks.db.execute.mock.calls[1]?.[0];
      const queries = mocks.db.execute.mock.calls.map(([query]) => sqlText(query)).join("\n");
      expect(queries).toContain("UPDATE agents");
      const updateParams = JSON.stringify(sqlBoundValues(updateQuery));
      expect(updateParams).toContain("sched_boom");
      expect(updateParams).not.toContain("sched_ok");
      expect(updateParams).not.toContain("sched_also_ok");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("returns 404 if a concurrent destroy wins the update race", async () => {
    queueExecuteRows([
      [
        {
          id: agentId,
          workspace_id: workspaceId,
          status: "active",
          schedule_ids: ["sched_a"],
        },
      ],
      [],
    ]);

    const response = await DELETE(request(), context());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "agent_not_found" });
    expect(mocks.cancelCronSchedule).toHaveBeenCalledWith(
      {
        RELAYCRON_URL: "https://relaycron.test",
        RELAYCRON_API_KEY: "relaycron-key",
      },
      "sched_a",
    );
  });

  it("cancels relaycron schedules without resolving a public cloud URL", async () => {
    queueExecuteRows([
      [
        {
          id: agentId,
          workspace_id: workspaceId,
          status: "active",
          schedule_ids: ["sched_a"],
        },
      ],
      [{ id: agentId }],
    ]);

    const response = await DELETE(request(), context());

    expect(response.status).toBe(200);
    expect(mocks.resolveAgentGatewayRelaycronEnv).toHaveBeenCalledWith();
  });

  it("resolves a deployed name to its agent UUID (non-UUID target)", async () => {
    const resolvedUuid = "11111111-1111-4111-8111-111111111111";
    queueExecuteRows([
      [
        {
          id: resolvedUuid,
          workspace_id: workspaceId,
          status: "active",
          schedule_ids: [],
        },
      ],
      [{ id: resolvedUuid }],
    ]);

    const response = await DELETE(
      request(),
      context({ agentId: "cloud-team-reviewer" }),
    );

    expect(response.status).toBe(200);
    // The response reports the resolved UUID, not the human-friendly name.
    await expect(response.json()).resolves.toMatchObject({
      agentId: resolvedUuid,
      status: "destroyed",
    });

    // The lookup must go through `deployed_name` — never bind a non-UUID name
    // straight into the `uuid`-typed `id` column (the 22P02 cast footgun).
    const selectQuery = sqlText(mocks.db.execute.mock.calls[0]?.[0]);
    expect(selectQuery).toContain("deployed_name = ");
    expect(selectQuery).not.toContain("::uuid");

    // The UPDATE targets the resolved UUID, not the requested name.
    const updateParams = JSON.stringify(
      sqlBoundValues(mocks.db.execute.mock.calls[1]?.[0]),
    );
    expect(updateParams).toContain(resolvedUuid);
    expect(updateParams).not.toContain("cloud-team-reviewer");
  });

  it("looks up by id with a uuid cast for a UUID target", async () => {
    const uuidTarget = "22222222-2222-4222-8222-222222222222";
    queueExecuteRows([
      [
        {
          id: uuidTarget,
          workspace_id: workspaceId,
          status: "active",
          schedule_ids: [],
        },
      ],
      [{ id: uuidTarget }],
    ]);

    const response = await DELETE(request(), context({ agentId: uuidTarget }));

    expect(response.status).toBe(200);
    const selectQuery = sqlText(mocks.db.execute.mock.calls[0]?.[0]);
    expect(selectQuery).toContain("::uuid");
    expect(selectQuery).toContain("deployed_name = ");
    expect(selectQuery).toContain("ORDER BY CASE WHEN id = ");
  });

  it("falls back to deployed_name for a UUID-shaped deployed name", async () => {
    const uuidLikeName = "33333333-3333-4333-8333-333333333333";
    const resolvedUuid = "44444444-4444-4444-8444-444444444444";
    queueExecuteRows([
      [
        {
          id: resolvedUuid,
          workspace_id: workspaceId,
          status: "active",
          schedule_ids: [],
        },
      ],
      [{ id: resolvedUuid }],
    ]);

    const response = await DELETE(request(), context({ agentId: uuidLikeName }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      agentId: resolvedUuid,
      status: "destroyed",
    });

    const selectQuery = sqlText(mocks.db.execute.mock.calls[0]?.[0]);
    expect(selectQuery).toContain("::uuid");
    expect(selectQuery).toContain("deployed_name = ");

    const updateParams = JSON.stringify(
      sqlBoundValues(mocks.db.execute.mock.calls[1]?.[0]),
    );
    expect(updateParams).toContain(resolvedUuid);
    expect(updateParams).not.toContain(uuidLikeName);
  });

  it("returns 404 (not 500) for an unknown deployed name", async () => {
    queueExecuteRows([[]]);

    const response = await DELETE(
      request(),
      context({ agentId: "no-such-agent" }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      code: "agent_not_found",
    });
  });
});
