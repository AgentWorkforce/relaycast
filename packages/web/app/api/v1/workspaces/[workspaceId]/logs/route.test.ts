import { NextRequest } from "next/server";
import { describe, expect, it, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  resolveWorkspaceIntegrationIdentity: vi.fn(),
  hasWorkspaceIntegrationAccess: vi.fn(),
  resolveWorkspaceRelayAccess: vi.fn(),
  resolveRelayfileConfig: vi.fn(),
  dbExecute: vi.fn(),
  queryFiles: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/request-auth")>()),
  resolveRequestAuth: mocks.resolveRequestAuth,
}));

vi.mock("@/lib/workspaces/workspace-integration-identity", () => ({
  resolveWorkspaceIntegrationIdentity: mocks.resolveWorkspaceIntegrationIdentity,
  hasWorkspaceIntegrationAccess: mocks.hasWorkspaceIntegrationAccess,
}));

vi.mock("@/lib/proactive-runtime/dashboard", () => ({
  resolveWorkspaceRelayAccess: mocks.resolveWorkspaceRelayAccess,
}));

vi.mock("@/lib/relayfile", () => ({
  resolveRelayfileConfig: mocks.resolveRelayfileConfig,
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    execute: mocks.dbExecute,
  }),
}));

vi.mock("@relayfile/sdk", () => ({
  RelayFileClient: vi.fn(function RelayFileClient() {
    return {
      queryFiles: mocks.queryFiles,
      readFile: mocks.readFile,
    };
  }),
}));

import { GET } from "./route";

const workspaceId = "workspace-1";
const tokenAuth = {
  userId: "user-1",
  workspaceId,
  organizationId: "org-1",
  source: "token" as const,
  scopes: ["cli:auth"],
};

function context() {
  return { params: Promise.resolve({ workspaceId }) };
}

function request(query = "") {
  return new NextRequest(`https://cloud.test/api/v1/workspaces/${workspaceId}/logs${query}`);
}

describe("GET /api/v1/workspaces/[workspaceId]/logs", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue(tokenAuth);
    mocks.resolveWorkspaceIntegrationIdentity.mockResolvedValue({
      requestedWorkspaceId: workspaceId,
      appWorkspaceId: workspaceId,
      relayWorkspaceId: "rw_relay",
      organizationId: "org-1",
      candidateWorkspaceIds: [workspaceId, "rw_relay"],
    });
    mocks.hasWorkspaceIntegrationAccess.mockReturnValue(true);
    mocks.resolveWorkspaceRelayAccess.mockResolvedValue({
      relayWorkspaceId: "relay-ws",
      token: "relay-token",
    });
    mocks.resolveRelayfileConfig.mockReturnValue({ relayfileUrl: "https://relayfile.test" });
    mocks.dbExecute.mockResolvedValue([]);
  });

  it("resolves the workspace identity and grants access against the reconciled id forms", async () => {
    // The cli/follow-user token's workspaceId is the app id; the route must
    // pass the path id through resolveWorkspaceIntegrationIdentity and check
    // hasWorkspaceIntegrationAccess (which matches either id form), then feed
    // the resolved app id to the relay-access lookup.
    mocks.queryFiles.mockResolvedValue({ items: [], nextCursor: null });

    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    expect(mocks.resolveWorkspaceIntegrationIdentity).toHaveBeenCalledWith(workspaceId);
    expect(mocks.hasWorkspaceIntegrationAccess).toHaveBeenCalledWith(
      tokenAuth,
      expect.objectContaining({ candidateWorkspaceIds: [workspaceId, "rw_relay"] }),
    );
    expect(mocks.resolveWorkspaceRelayAccess).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId }),
    );
  });

  it("returns 404 when the caller has no access to the workspace", async () => {
    mocks.hasWorkspaceIntegrationAccess.mockReturnValue(false);

    const response = await GET(request(), context());

    expect(response.status).toBe(404);
    expect(mocks.resolveWorkspaceRelayAccess).not.toHaveBeenCalled();
  });

  it("returns 404 when the workspace identity cannot be resolved", async () => {
    mocks.resolveWorkspaceIntegrationIdentity.mockRejectedValue(new Error("Workspace not found"));

    const response = await GET(request(), context());

    expect(response.status).toBe(404);
    expect(mocks.hasWorkspaceIntegrationAccess).not.toHaveBeenCalled();
  });

  it("allows cli tokens to list workspace log files", async () => {
    mocks.queryFiles.mockResolvedValue({
      items: [{ path: "/_logs/relay-ws/2026-05-19.jsonl" }],
      nextCursor: null,
    });

    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    expect(mocks.resolveWorkspaceRelayAccess).toHaveBeenCalledWith({
      userId: "user-1",
      workspaceId,
      agentName: "cloud-dashboard-logs",
      requestedScopes: ["relayfile:fs:read:*"],
    });
    expect(mocks.queryFiles).toHaveBeenCalledWith("relay-ws", {
      path: "/_logs/relay-ws",
      limit: 100,
    });
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: {
        workspace: "relay-ws",
        items: [{ path: "/_logs/relay-ws/2026-05-19.jsonl" }],
        nextCursor: null,
      },
    });
  });

  it("filters a log file by agent id", async () => {
    mocks.readFile.mockResolvedValue({
      content:
        JSON.stringify({ agentId: "agent-a", msg: "kept" }) +
        "\n" +
        JSON.stringify({ agentId: "agent-b", msg: "filtered" }) +
        "\n",
    });

    const response = await GET(
      request("?_path=ignored&path=%2F_logs%2Frelay-ws%2F2026-05-19.jsonl&agentId=agent-a"),
      context(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: {
        workspace: "relay-ws",
        path: "/_logs/relay-ws/2026-05-19.jsonl",
        entries: [{ agentId: "agent-a", msg: "kept" }],
      },
    });
  });

  it("falls back to deployment run logs when workspace log files are empty for an agent", async () => {
    mocks.queryFiles.mockResolvedValue({
      items: [],
      nextCursor: null,
    });
    mocks.dbExecute.mockResolvedValue([
      {
        id: "run-1",
        deployment_id: "deployment-1",
        event_source: "cron:daily:sched-1",
        stdout: "handler stdout\n",
        stderr: "",
        mount_log_tail: "mount flushed\n",
        started_at: "2026-05-26T10:00:00.000Z",
        ended_at: "2026-05-26T10:00:10.000Z",
        status: "succeeded",
        error: null,
      },
    ]);

    const response = await GET(request("?agentId=agent-a"), context());

    expect(response.status).toBe(200);
    expect(mocks.dbExecute).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: {
        workspace: "relay-ws",
        items: [],
        source: "agent_deployment_runs",
        entries: [
          {
            agentId: "agent-a",
            runId: "run-1",
            stream: "system",
            status: "succeeded",
          },
          {
            agentId: "agent-a",
            runId: "run-1",
            stream: "stdout",
            msg: "handler stdout",
          },
          {
            agentId: "agent-a",
            runId: "run-1",
            stream: "mount",
            msg: "mount flushed",
          },
        ],
      },
    });
  });

  it("rejects file reads outside the workspace log tree", async () => {
    const response = await GET(
      request("?path=%2Fsecrets%2Ftoken.json"),
      context(),
    );

    expect(response.status).toBe(400);
    expect(mocks.resolveRelayfileConfig).not.toHaveBeenCalled();
    expect(mocks.readFile).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ error: "Invalid log path" });
  });

  it("rejects traversal segments in log paths", async () => {
    const response = await GET(
      request("?path=%2F_logs%2Frelay-ws%2F..%2Fsecrets.json"),
      context(),
    );

    expect(response.status).toBe(400);
    expect(mocks.resolveRelayfileConfig).not.toHaveBeenCalled();
    expect(mocks.readFile).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ error: "Invalid log path" });
  });

  it("rejects tokens without log or deployment read scope", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      ...tokenAuth,
      scopes: ["workflow:runs:read"],
    });

    const response = await GET(request(), context());

    expect(response.status).toBe(403);
  });
});
