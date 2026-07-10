import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  postAgentActivityMock,
  resolveRickyLinearCloudUserMock,
} = vi.hoisted(() => ({
  postAgentActivityMock: vi.fn(),
  resolveRickyLinearCloudUserMock: vi.fn(),
}));

vi.mock("@/lib/app-origin", () => ({
  getConfiguredAppOrigin: vi.fn(() => "https://cloud.example.com"),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/db/schema", () => ({
  providerCredentials: {},
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  listWorkspaceIntegrationsByProviderAlias: vi.fn(),
}));

vi.mock("@/lib/ricky/run-store", () => ({
  rickyRunStore: {
    appendEvent: vi.fn(),
  },
}));

vi.mock("@/lib/ricky/run-supervisor", () => ({
  rickyRunSupervisor: {
    create: vi.fn(),
  },
}));

vi.mock("./auth", () => ({
  createDelegatedCloudRequest: vi.fn(),
  resolveRickyLinearCloudUser: resolveRickyLinearCloudUserMock,
}));

vi.mock("./egress", () => ({
  rickyLinearEgress: {
    postAgentActivity: postAgentActivityMock,
  },
}));

vi.mock("./store", () => ({
  rickyLinearStore: {
    getWorkspaceDefaultRepositoryId: vi.fn(),
  },
}));

vi.mock("./workflow-builder-input", () => ({
  buildLinearWorkflow: vi.fn(),
  parseGitHubInstallRepositoryId: vi.fn(),
  parseRepoTargetFromText: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  resolveRickyLinearCloudUserMock.mockResolvedValue(null);
  postAgentActivityMock.mockResolvedValue(undefined);
});

describe("dispatchLinearSessionEvent", () => {
  it("dispatches AgentSessionEvent.created by action instead of webhook type", async () => {
    const { dispatchLinearSessionEvent } = await import("./ingress");

    const result = await dispatchLinearSessionEvent({
      event: {
        type: "AgentSessionEvent",
        action: "created",
        organizationId: "org_linear_1",
        appUserId: "agent_app_user_1",
        agentSession: {
          id: "session_linear_1",
          creatorId: "user_linear_1",
          issue: {
            id: "issue_linear_1",
            identifier: "ENG-123",
            title: "Fix agent session routing",
            description: "Use the action field for agent webhooks.",
          },
        },
        promptContext: "<issue identifier=\"ENG-123\">Fix agent session routing</issue>",
      },
      appOrigin: "https://cloud.example.com",
    });

    expect(result).toEqual({ ok: true, status: "failed" });
    expect(resolveRickyLinearCloudUserMock).toHaveBeenCalledWith({
      linearOrgId: "org_linear_1",
      linearUserId: "user_linear_1",
    });
    expect(postAgentActivityMock).toHaveBeenCalledWith({
      linearOrgId: "org_linear_1",
      sessionId: "session_linear_1",
      activity: {
        type: "response",
        body: expect.stringContaining("Your Linear identity is not linked to Cloud yet."),
      },
    });
  });

  it("dispatches AgentSessionEvent.prompted by action and reads agentActivity.body", async () => {
    const { dispatchLinearSessionEvent } = await import("./ingress");

    const result = await dispatchLinearSessionEvent({
      event: {
        type: "AgentSessionEvent",
        action: "prompted",
        organizationId: "org_linear_1",
        agentSession: {
          id: "session_linear_1",
          issue: {
            identifier: "ENG-123",
            title: "Fix agent session routing",
          },
        },
        agentActivity: {
          userId: "user_linear_1",
          body: "Please continue with the failing webhook coverage.",
        },
      },
    });

    expect(result).toEqual({ ok: true, status: "failed" });
    expect(resolveRickyLinearCloudUserMock).toHaveBeenCalledWith({
      linearOrgId: "org_linear_1",
      linearUserId: "user_linear_1",
    });
    expect(postAgentActivityMock).toHaveBeenCalledWith({
      linearOrgId: "org_linear_1",
      sessionId: "session_linear_1",
      activity: {
        type: "response",
        body: "Your Linear identity is no longer linked to Cloud. Reconnect Ricky Linear in Cloud and try again.",
      },
    });
  });
});
