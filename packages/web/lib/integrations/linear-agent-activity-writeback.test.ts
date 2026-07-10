import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  findWorkspaceIntegrationByConnection: vi.fn(),
  getWorkspaceIntegrationByProviderAlias: vi.fn(),
  getProviderConfigKey: vi.fn(),
  nangoProxy: vi.fn(),
  resolveLinearWritebackRequest: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({ execute: mocks.execute }),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    warn: mocks.loggerWarn,
  },
}));

vi.mock("@/lib/integrations/nango-service", () => ({
  getNangoClient: () => ({ proxy: mocks.nangoProxy }),
  getProviderConfigKey: mocks.getProviderConfigKey,
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  findWorkspaceIntegrationByConnection:
    mocks.findWorkspaceIntegrationByConnection,
  getWorkspaceIntegrationByProviderAlias:
    mocks.getWorkspaceIntegrationByProviderAlias,
}));

vi.mock("@relayfile/adapter-linear/writeback", () => ({
  resolveWritebackRequest: mocks.resolveLinearWritebackRequest,
}));

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks.map((chunk) => {
    if (typeof chunk === "string") {
      return "?";
    }
    if (!chunk) return "?";
    const value = (chunk as { value?: unknown }).value;
    return Array.isArray(value) ? value.join("") : "?";
  }).join("");
}

const linearPayload = {
  id: "delivery-linear-1",
  deliveryId: "delivery-linear-1",
  type: "linear.AgentSessionEvent.prompted",
  provider: "linear",
  eventType: "AgentSessionEvent.prompted",
  connectionId: "conn-linear-1",
  resource: {
    agentSession: { id: "session-linear-1" },
    agentActivity: { id: "activity-linear-1", body: "Please handle AR-70" },
  },
};

describe("linear AgentSession terminal writeback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConfigKey.mockReturnValue("linear-relay");
    mocks.findWorkspaceIntegrationByConnection.mockResolvedValue({
      workspaceId: "workspace-1",
      provider: "linear",
      connectionId: "conn-linear-1",
      providerConfigKey: "linear-relay",
      metadata: {},
    });
    mocks.getWorkspaceIntegrationByProviderAlias.mockResolvedValue(null);
    mocks.resolveLinearWritebackRequest.mockImplementation((path: string, content: string) => ({
      action: "create_agent_activity",
      method: "POST",
      endpoint: "/graphql",
      body: {
        query: "mutation AgentActivityCreate",
        variables: {
          input: {
            agentSessionId: path.split("/agent-sessions/")[1]?.split("/")[0],
            content: JSON.parse(content),
          },
        },
      },
    }));
    mocks.nangoProxy.mockResolvedValue({
      status: 200,
      data: {
        data: {
          agentActivityCreate: {
            success: true,
            agentActivity: { id: "agent-activity-created" },
          },
        },
      },
    });
  });

  it("posts one response AgentActivity after an atomic delivery-row claim", async () => {
    mocks.execute
      .mockResolvedValueOnce({ rows: [{ id: "delivery-row" }] })
      .mockResolvedValueOnce({ rows: [] });
    const { postLinearAgentSessionTerminalWriteback } = await import(
      "./linear-agent-activity-writeback"
    );

    await postLinearAgentSessionTerminalWriteback({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deploymentId: "deployment-1",
      payload: linearPayload,
      terminalStatus: "completed",
      result: {
        output: "opened PR and accidentally echoed ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        exitCode: 0,
      },
      sandboxId: "sbx-1",
      sessionId: "tick-deployment-1",
      commandId: "cmd-1",
    });

    const claimSql = sqlText(mocks.execute.mock.calls[0]?.[0]);
    expect(claimSql).toContain("UPDATE integration_watch_deliveries");
    expect(claimSql).toContain("terminal_writeback_status = 'posting'");
    expect(claimSql).toContain("terminal_writeback_status IS NULL");
    expect(claimSql).toContain("RETURNING id");
    expect(mocks.findWorkspaceIntegrationByConnection).toHaveBeenCalledWith(
      "linear",
      "conn-linear-1",
    );
    expect(mocks.nangoProxy).toHaveBeenCalledWith(expect.objectContaining({
      method: "POST",
      endpoint: "/graphql",
      connectionId: "conn-linear-1",
      providerConfigKey: "linear-relay",
      data: expect.objectContaining({
        variables: {
          input: {
            agentSessionId: "session-linear-1",
            content: expect.objectContaining({
              type: "response",
              body: expect.stringContaining("Agent run completed."),
            }),
          },
        },
      }),
    }));
    const activity = mocks.nangoProxy.mock.calls[0]?.[0]?.data?.variables?.input?.content;
    expect(activity.body).toContain("[REDACTED]");
    expect(activity.body).not.toContain("ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const postedSql = sqlText(mocks.execute.mock.calls[1]?.[0]);
    expect(postedSql).toContain("terminal_writeback_status = 'posted'");
  });

  it("does not post twice when the delivery-row CAS is already claimed", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });
    const { postLinearAgentSessionTerminalWriteback } = await import(
      "./linear-agent-activity-writeback"
    );

    await postLinearAgentSessionTerminalWriteback({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deploymentId: "deployment-1",
      payload: linearPayload,
      terminalStatus: "completed",
      result: { output: "done", exitCode: 0 },
    });

    expect(mocks.nangoProxy).not.toHaveBeenCalled();
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it("records egress failure without throwing", async () => {
    mocks.execute
      .mockResolvedValueOnce({ rows: [{ id: "delivery-row" }] })
      .mockResolvedValueOnce({ rows: [] });
    mocks.nangoProxy.mockResolvedValueOnce({
      status: 200,
      data: {
        data: {
          agentActivityCreate: {
            success: false,
            agentActivity: null,
          },
        },
      },
    });
    const { postLinearAgentSessionTerminalWriteback } = await import(
      "./linear-agent-activity-writeback"
    );

    await expect(postLinearAgentSessionTerminalWriteback({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deploymentId: "deployment-1",
      payload: linearPayload,
      terminalStatus: "error",
      result: { output: "runner failed", exitCode: 1 },
      error: new Error("runner failed"),
    })).resolves.toBeUndefined();

    const failedSql = sqlText(mocks.execute.mock.calls[1]?.[0]);
    expect(failedSql).toContain("terminal_writeback_status = 'failed'");
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "Linear AgentSession terminal writeback failed",
      expect.objectContaining({
        area: "linear-agent-activity-writeback",
        deliveryId: "delivery-linear-1",
        sessionId: "session-linear-1",
      }),
    );
  });

  it("records a claimed terminal writeback as failed when request resolution crashes", async () => {
    mocks.execute
      .mockResolvedValueOnce({ rows: [{ id: "delivery-row" }] })
      .mockResolvedValueOnce({ rows: [] });
    mocks.resolveLinearWritebackRequest.mockImplementationOnce(() => {
      throw new Error("adapter request resolution failed");
    });
    const { postLinearAgentSessionTerminalWriteback } = await import(
      "./linear-agent-activity-writeback"
    );

    await expect(postLinearAgentSessionTerminalWriteback({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deploymentId: "deployment-1",
      payload: linearPayload,
      terminalStatus: "error",
      result: { output: "runner failed", exitCode: 1 },
      error: new Error("runner failed"),
    })).resolves.toBeUndefined();

    expect(mocks.nangoProxy).not.toHaveBeenCalled();
    const failedSql = sqlText(mocks.execute.mock.calls[1]?.[0]);
    expect(failedSql).toContain("terminal_writeback_status = 'failed'");
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "Linear AgentSession terminal writeback crashed",
      expect.objectContaining({
        area: "linear-agent-activity-writeback",
        deliveryId: "delivery-linear-1",
        error: "adapter request resolution failed",
        failureRecorded: true,
      }),
    );
  });

  it("records a claimed terminal writeback as failed when marking posted crashes", async () => {
    mocks.execute
      .mockResolvedValueOnce({ rows: [{ id: "delivery-row" }] })
      .mockRejectedValueOnce(new Error("posted update failed"))
      .mockResolvedValueOnce({ rows: [] });
    const { postLinearAgentSessionTerminalWriteback } = await import(
      "./linear-agent-activity-writeback"
    );

    await expect(postLinearAgentSessionTerminalWriteback({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deploymentId: "deployment-1",
      payload: linearPayload,
      terminalStatus: "completed",
      result: { output: "done", exitCode: 0 },
    })).resolves.toBeUndefined();

    expect(mocks.nangoProxy).toHaveBeenCalledTimes(1);
    const failedSql = sqlText(mocks.execute.mock.calls[2]?.[0]);
    expect(failedSql).toContain("terminal_writeback_status = 'failed'");
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "Linear AgentSession terminal writeback crashed",
      expect.objectContaining({
        area: "linear-agent-activity-writeback",
        deliveryId: "delivery-linear-1",
        error: "posted update failed",
        failureRecorded: true,
      }),
    );
  });

  it("does nothing for non-Linear or non-AgentSession payloads", async () => {
    const { postLinearAgentSessionTerminalWriteback } = await import(
      "./linear-agent-activity-writeback"
    );

    await postLinearAgentSessionTerminalWriteback({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deploymentId: "deployment-1",
      payload: { type: "github.issues.opened", provider: "github" },
      terminalStatus: "completed",
      result: { output: "done", exitCode: 0 },
    });

    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.nangoProxy).not.toHaveBeenCalled();
  });
});
