import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
  const connectMock = vi.fn().mockResolvedValue(undefined);
  const createRelayMcpServerMock = vi.fn().mockReturnValue({
    connect: connectMock,
  });
  const inboxMock = vi.fn();
  const registerOrRotateMock = vi.fn();
  const asMock = vi.fn(() => ({ inbox: inboxMock }));
  const createInternalRelayCastMock = vi.fn(() => ({
    as: asMock,
    agents: {
      registerOrRotate: registerOrRotateMock,
    },
  }));
  return {
    connectMock,
    createRelayMcpServerMock,
    inboxMock,
    registerOrRotateMock,
    asMock,
    createInternalRelayCastMock,
  };
});

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {},
}));

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: class {},
}));

vi.mock("./../server.js", () => ({
  MCP_VERSION: "0.1.2",
  createRelayMcpServer: mocks.createRelayMcpServerMock,
}));

vi.mock("@relaycast/sdk/internal", () => ({
  createInternalRelayCast: mocks.createInternalRelayCastMock,
}));

vi.mock("./../telemetry.js", () => ({
  createMcpTelemetry: () => ({ capture: vi.fn() }),
}));

vi.mock("@relaycast/sdk", () => ({
  RelayError: class RelayError extends Error {
    code?: string;
    statusCode?: number;
    constructor(
      code: string,
      message: string,
      opts: { statusCode?: number } = {},
    ) {
      super(message);
      this.code = code;
      this.statusCode = opts.statusCode;
    }
  },
}));

import { startStdio } from "../transports.js";

describe("startStdio bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inboxMock.mockResolvedValue({ unread: 0 });
    mocks.registerOrRotateMock.mockResolvedValue({
      name: "worker-1",
      token: "at_live_fresh",
    });
  });

  it("keeps an existing valid agent token", async () => {
    await startStdio({
      apiKey: "rk_live_workspace",
      agentName: "worker-1",
      agentToken: "at_live_existing",
    });

    expect(mocks.asMock).toHaveBeenCalledWith("at_live_existing");
    expect(mocks.registerOrRotateMock).not.toHaveBeenCalled();
    expect(mocks.createRelayMcpServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentToken: "at_live_existing",
        agentName: "worker-1",
        telemetryTransport: "stdio",
      }),
    );
  });

  it("rotates a stale agent token when validation returns unauthorized", async () => {
    mocks.inboxMock.mockRejectedValue({
      code: "unauthorized",
      statusCode: 401,
    });

    await startStdio({
      apiKey: "rk_live_workspace",
      agentName: "worker-1",
      agentToken: "at_live_stale",
      agentType: "agent",
    });

    expect(mocks.registerOrRotateMock).toHaveBeenCalledWith({
      name: "worker-1",
      type: "agent",
    });
    expect(mocks.createRelayMcpServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentToken: "at_live_fresh",
        agentName: "worker-1",
        telemetryTransport: "stdio",
      }),
    );
  });

  it("registers or rotates when only workspace key and agent name are provided", async () => {
    await startStdio({
      apiKey: "rk_live_workspace",
      agentName: "worker-1",
    });

    expect(mocks.asMock).not.toHaveBeenCalled();
    expect(mocks.registerOrRotateMock).toHaveBeenCalledWith({
      name: "worker-1",
      type: undefined,
    });
    expect(mocks.createRelayMcpServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentToken: "at_live_fresh",
        agentName: "worker-1",
        telemetryTransport: "stdio",
      }),
    );
  });

  it("bootstraps each configured workspace from workspaces[]", async () => {
    mocks.registerOrRotateMock
      .mockResolvedValueOnce({
        name: "worker-alpha",
        token: "at_live_alpha",
      })
      .mockResolvedValueOnce({
        name: "worker-beta",
        token: "at_live_beta",
      });

    await startStdio({
      workspaces: [
        {
          workspaceId: "ws_alpha",
          workspaceAlias: "alpha",
          workspaceKey: "rk_live_alpha",
          agentName: "worker-alpha",
        },
        {
          workspaceId: "ws_beta",
          workspaceAlias: "beta",
          workspaceKey: "rk_live_beta",
          agentName: "worker-beta",
          agentToken: "at_live_stale_beta",
        },
      ],
      defaultWorkspace: "alpha",
    });

    expect(mocks.registerOrRotateMock).toHaveBeenNthCalledWith(1, {
      name: "worker-alpha",
      type: undefined,
    });
    expect(mocks.asMock).toHaveBeenCalledWith("at_live_stale_beta");
    expect(mocks.createRelayMcpServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultWorkspace: "alpha",
        telemetryTransport: "stdio",
        workspaces: [
          expect.objectContaining({
            workspaceId: "ws_alpha",
            agentToken: "at_live_alpha",
            agentName: "worker-alpha",
          }),
          expect.objectContaining({
            workspaceId: "ws_beta",
            agentToken: "at_live_stale_beta",
            agentName: "worker-beta",
          }),
        ],
      }),
    );
  });
});
