import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tryResourceValue: vi.fn(),
  readInboxDeploymentCandidates: vi.fn(),
  deliverDeploymentTrigger: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  tryResourceValue: mocks.tryResourceValue,
}));

vi.mock("@/lib/proactive-runtime/inbox-dispatcher", () => ({
  readInboxDeploymentCandidates: mocks.readInboxDeploymentCandidates,
}));

vi.mock("@/lib/proactive-runtime/deployment-trigger-delivery", () => ({
  DeploymentTriggerDeliveryError: class DeploymentTriggerDeliveryError extends Error {
    constructor(message: string, readonly code: string, readonly status: number) {
      super(message);
      this.name = "DeploymentTriggerDeliveryError";
    }
  },
  deliverDeploymentTrigger: mocks.deliverDeploymentTrigger,
}));

describe("proactive-runtime inbox internal routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tryResourceValue.mockReturnValue("internal-secret");
    mocks.readInboxDeploymentCandidates.mockResolvedValue([
      {
        id: "agent-1",
        deployed_name: "support-agent",
        inbox_selectors: ["support"],
      },
    ]);
    mocks.deliverDeploymentTrigger.mockResolvedValue({
      agentId: "agent-1",
      workspaceId: "workspace-1",
      deploymentId: "deployment-1",
      status: "starting",
    });
  });

  it("returns deployment candidates for a selector", async () => {
    const { POST } = await import("./candidates/route");

    const response = await POST(
      new Request("https://cloud.test/api/internal/proactive-runtime/inbox/candidates", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agent-gateway-secret": "internal-secret",
        },
        body: JSON.stringify({ workspaceId: "workspace-1", selector: "#support" }),
      }) as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: {
        agents: [
          {
            agentId: "agent-1",
            deployedName: "support-agent",
            inboxSelectors: ["support"],
          },
        ],
      },
    });
    expect(mocks.readInboxDeploymentCandidates).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      selector: "#support",
    });
  });

  it("delivers relaycast payloads through deliverDeploymentTrigger", async () => {
    const { POST } = await import("./deliver/route");
    const payload = {
      id: "evt-1",
      type: "relaycast.message",
      channel: "support",
      messageId: "msg-1",
      threadId: "thread-1",
    };

    const response = await POST(
      new Request("https://cloud.test/api/internal/proactive-runtime/inbox/deliver", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer internal-secret",
        },
        body: JSON.stringify({
          workspaceId: "workspace-1",
          agentId: "agent-1",
          deliveryId: "relaycast:workspace-1:agent-1:msg-1",
          payload,
        }),
      }) as never,
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: {
        agentId: "agent-1",
        workspaceId: "workspace-1",
        deploymentId: "deployment-1",
        status: "starting",
      },
    });
    expect(mocks.deliverDeploymentTrigger).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deliveryId: "relaycast:workspace-1:agent-1:msg-1",
      payload,
    });
  });

  it("rejects unauthenticated inbox route requests", async () => {
    const { POST } = await import("./candidates/route");

    const response = await POST(
      new Request("https://cloud.test/api/internal/proactive-runtime/inbox/candidates", {
        method: "POST",
        body: JSON.stringify({ workspaceId: "workspace-1", selector: "support" }),
      }) as never,
    );

    expect(response.status).toBe(401);
    expect(mocks.readInboxDeploymentCandidates).not.toHaveBeenCalled();
  });
});
