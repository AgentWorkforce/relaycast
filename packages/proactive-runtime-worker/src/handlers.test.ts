import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  drainDeploymentTickDeliveries: vi.fn(),
  drainIntegrationWatchDeliveries: vi.fn(),
  drainPrSandboxWarmPool: vi.fn(),
  reapStoppedSandboxes: vi.fn(),
  readInboxDeploymentCandidates: vi.fn(),
  readIntegrationWatchCandidateAgents: vi.fn(),
  dispatchIntegrationWatchEvent: vi.fn(),
  deliverDeploymentTrigger: vi.fn(),
  getAuthorizedDeploymentRun: vi.fn(),
  getAuthorizedDeploymentRunEnvelope: vi.fn(),
  listAuthorizedDeploymentRuns: vi.fn(),
  sweepCoalescedIssueDispatchRedispatches: vi.fn(),
  tryResourceValue: vi.fn(),
}));

vi.mock("../../web/lib/env", () => ({
  tryResourceValue: mocks.tryResourceValue,
}));

vi.mock("../../web/lib/proactive-runtime/deployment-tick-deliveries", () => ({
  drainDeploymentTickDeliveries: mocks.drainDeploymentTickDeliveries,
}));

vi.mock("../../web/lib/proactive-runtime/integration-watch-deliveries", () => ({
  drainIntegrationWatchDeliveries: mocks.drainIntegrationWatchDeliveries,
  sweepCoalescedIssueDispatchRedispatches:
    mocks.sweepCoalescedIssueDispatchRedispatches,
}));

vi.mock("../../web/lib/proactive-runtime/deployment-sandbox-recycle", () => ({
  drainPrSandboxWarmPool: mocks.drainPrSandboxWarmPool,
  reapStoppedSandboxes: mocks.reapStoppedSandboxes,
}));

vi.mock("../../web/lib/proactive-runtime/inbox-dispatcher", () => ({
  readInboxDeploymentCandidates: mocks.readInboxDeploymentCandidates,
}));

vi.mock("../../web/lib/proactive-runtime/integration-watch-dispatcher", () => ({
  dispatchIntegrationWatchEvent: mocks.dispatchIntegrationWatchEvent,
  readIntegrationWatchCandidateAgents: mocks.readIntegrationWatchCandidateAgents,
}));

vi.mock("../../web/lib/proactive-runtime/deployment-trigger-delivery", () => {
  class DeploymentTriggerDeliveryError extends Error {
    code: string;
    status: number;

    constructor(message: string, code: string, status: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }

  return {
    deliverDeploymentTrigger: mocks.deliverDeploymentTrigger,
    DeploymentTriggerDeliveryError,
  };
});

vi.mock("../../web/lib/proactive-runtime/deployment-run-observability-core", () => ({
  getAuthorizedDeploymentRun: mocks.getAuthorizedDeploymentRun,
  getAuthorizedDeploymentRunEnvelope: mocks.getAuthorizedDeploymentRunEnvelope,
  listAuthorizedDeploymentRuns: mocks.listAuthorizedDeploymentRuns,
}));

describe("proactive runtime worker handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tryResourceValue.mockImplementation((name: string) => {
      if (name === "RelaycronApiKey") return "relaycron-key";
      if (name === "AgentGatewayInternalSecret") return "gateway-key";
      return undefined;
    });
    mocks.drainDeploymentTickDeliveries.mockResolvedValue({
      attempted: 1,
      delivered: 1,
      failed: 0,
      pending: 0,
      terminal: 0,
    });
    mocks.sweepCoalescedIssueDispatchRedispatches.mockResolvedValue(0);
    mocks.drainIntegrationWatchDeliveries.mockResolvedValue({
      attempted: 2,
      delivered: 2,
      failed: 0,
      pending: 0,
      terminal: 0,
    });
    mocks.reapStoppedSandboxes.mockResolvedValue({ deleted: 2 });
    mocks.drainPrSandboxWarmPool.mockResolvedValue({ deleted: 1 });
    mocks.readIntegrationWatchCandidateAgents.mockResolvedValue([
      {
        id: "agent-1",
        watch_globs: ["src/**"],
        watch_rules: [],
        spec: { name: "Watcher" },
      },
    ]);
    mocks.readInboxDeploymentCandidates.mockResolvedValue([
      {
        id: "agent-2",
        deployed_name: "Inbox",
        inbox_selectors: ["support"],
      },
    ]);
    mocks.dispatchIntegrationWatchEvent.mockResolvedValue({
      matched: 1,
      delivered: 1,
      failed: 0,
    });
    mocks.deliverDeploymentTrigger.mockResolvedValue({ delivered: true });
    mocks.listAuthorizedDeploymentRuns.mockResolvedValue(Response.json({ runs: [] }));
    mocks.getAuthorizedDeploymentRun.mockResolvedValue(Response.json({ run: { id: "run-1" } }));
    mocks.getAuthorizedDeploymentRunEnvelope.mockResolvedValue(
      Response.json({ envelope: { id: "run-1" } }),
    );
  });

  it("authenticates and drains deployment tick deliveries", async () => {
    const { handleProactiveRuntimeRequest } = await import("./handlers");

    const response = await handleProactiveRuntimeRequest(
      new Request(
        "https://proactive-runtime.internal/api/internal/proactive-runtime/deployment-tick-deliveries/sweep",
        {
          method: "POST",
          headers: {
            authorization: "Bearer relaycron-key",
            "content-type": "application/json",
          },
          body: JSON.stringify({ limit: 9 }),
        },
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: {
        attempted: 1,
        delivered: 1,
        failed: 0,
        pending: 0,
        terminal: 0,
      },
    });
    expect(mocks.drainDeploymentTickDeliveries).toHaveBeenCalledWith({
      limit: 6,
      maxDeliveryAgeSeconds: 60 * 60,
      deliveryOptions: {
        sandboxCreateTimeoutSeconds: 120,
        runScriptTimeoutMs: 15_000,
        asyncRunScript: true,
      },
    });
  });

  it("authenticates and drains one integration-watch delivery by id", async () => {
    const { handleProactiveRuntimeRequest } = await import("./handlers");

    const response = await handleProactiveRuntimeRequest(
      new Request(
        "https://proactive-runtime.internal/api/internal/proactive-runtime/integration-watch-deliveries/drain",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-agent-gateway-secret": "gateway-key",
          },
          body: JSON.stringify({
            workspaceId: "workspace-1",
            agentId: "agent-1",
            deliveryId: "delivery-1",
          }),
        },
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: {
        attempted: 2,
        delivered: 2,
        failed: 0,
        pending: 0,
        terminal: 0,
      },
    });
    expect(mocks.drainIntegrationWatchDeliveries).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deliveryId: "delivery-1",
      limit: 1,
      deliveryOptions: {
        sandboxCreateTimeoutSeconds: 120,
        runScriptTimeoutMs: 15_000,
        asyncRunScript: true,
      },
      allowTeamLaunchN1: true,
    });
  });

  it("authenticates and drains a bounded integration-watch agent backlog", async () => {
    const { handleProactiveRuntimeRequest } = await import("./handlers");

    const response = await handleProactiveRuntimeRequest(
      new Request(
        "https://proactive-runtime.internal/api/internal/proactive-runtime/integration-watch-deliveries/drain",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-agent-gateway-secret": "gateway-key",
          },
          body: JSON.stringify({
            workspaceId: "workspace-1",
            agentId: "agent-1",
            limit: 3,
          }),
        },
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: {
        attempted: 2,
        delivered: 2,
        failed: 0,
        pending: 0,
        terminal: 0,
      },
    });
    expect(mocks.drainIntegrationWatchDeliveries).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      limit: 3,
      deliveryOptions: {
        sandboxCreateTimeoutSeconds: 120,
        runScriptTimeoutMs: 15_000,
        asyncRunScript: true,
      },
      allowTeamLaunchN1: true,
    });
  });

  it("rejects integration-watch delivery drains without the internal service secret", async () => {
    const { handleProactiveRuntimeRequest } = await import("./handlers");

    const response = await handleProactiveRuntimeRequest(
      new Request(
        "https://proactive-runtime.internal/api/internal/proactive-runtime/integration-watch-deliveries/drain",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            workspaceId: "workspace-1",
            agentId: "agent-1",
            deliveryId: "delivery-1",
          }),
        },
      ),
    );

    expect(response.status).toBe(401);
    expect(mocks.drainIntegrationWatchDeliveries).not.toHaveBeenCalled();
  });

  it("rejects relaycron endpoints without the relaycron secret", async () => {
    const { handleProactiveRuntimeRequest } = await import("./handlers");

    const response = await handleProactiveRuntimeRequest(
      new Request(
        "https://proactive-runtime.internal/api/internal/proactive-runtime/sandbox-reaper",
        { method: "POST" },
      ),
    );

    expect(response.status).toBe(401);
    expect(mocks.reapStoppedSandboxes).not.toHaveBeenCalled();
  });

  it("authenticates gateway candidate reads", async () => {
    const { handleProactiveRuntimeRequest } = await import("./handlers");

    const response = await handleProactiveRuntimeRequest(
      new Request(
        "https://proactive-runtime.internal/api/internal/proactive-runtime/vfs-watch/candidates",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-agent-gateway-secret": "gateway-key",
          },
          body: JSON.stringify({ workspaceId: "workspace-1" }),
        },
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: {
        agents: [
          {
            agentId: "agent-1",
            watchGlobs: ["src/**"],
            watchRules: [],
            spec: { name: "Watcher" },
          },
        ],
      },
    });
  });

  it("delivers gateway triggers through the deployment trigger runtime", async () => {
    const { handleProactiveRuntimeRequest } = await import("./handlers");

    const response = await handleProactiveRuntimeRequest(
      new Request(
        "https://proactive-runtime.internal/api/internal/proactive-runtime/inbox/deliver",
        {
          method: "POST",
          headers: {
            authorization: "Bearer gateway-key",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            workspaceId: "workspace-1",
            agentId: "agent-2",
            payload: { kind: "inbox" },
            deliveryId: "delivery-1",
          }),
        },
      ),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: { delivered: true },
    });
    expect(mocks.deliverDeploymentTrigger).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      agentId: "agent-2",
      payload: { kind: "inbox" },
      deliveryId: "delivery-1",
    });
  });

  it("dispatches integration watch events through the dispatcher runtime", async () => {
    const { handleProactiveRuntimeRequest } = await import("./handlers");

    const response = await handleProactiveRuntimeRequest(
      new Request(
        "https://proactive-runtime.internal/api/internal/proactive-runtime/integration-watch/dispatch",
        {
          method: "POST",
          headers: {
            authorization: "Bearer gateway-key",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            workspaceId: "workspace-1",
            provider: "github",
            eventType: "issues.opened",
            connectionId: "connection-1",
            deliveryId: "delivery-1",
            paths: ["/github/issues/1.json", 123],
            payload: { id: 1 },
            occurredAt: "2026-06-24T12:00:00.000Z",
          }),
        },
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: { matched: 1, delivered: 1, failed: 0 },
    });
    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      provider: "github",
      eventType: "issues.opened",
      connectionId: "connection-1",
      deliveryId: "delivery-1",
      paths: ["/github/issues/1.json"],
      payload: { id: 1 },
      occurredAt: "2026-06-24T12:00:00.000Z",
    });
  });

  it("routes authorized deployment run list reads to run observability", async () => {
    const { handleProactiveRuntimeRequest } = await import("./handlers");

    const response = await handleProactiveRuntimeRequest(
      new Request(
        "https://proactive-runtime.internal/api/internal/proactive-runtime/deployment-run-observability/read?limit=10",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-agent-gateway-secret": "gateway-key",
          },
          body: JSON.stringify({
            kind: "list",
            workspaceId: "workspace-1",
            agentId: "agent-1",
          }),
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.listAuthorizedDeploymentRuns).toHaveBeenCalledWith(expect.any(Request), {
      workspaceId: "workspace-1",
      agentId: "agent-1",
    });
    const forwardedRequest = mocks.listAuthorizedDeploymentRuns.mock.calls[0][0] as Request;
    expect(new URL(forwardedRequest.url).searchParams.get("limit")).toBe("10");
  });

  it("routes authorized deployment run detail and envelope reads", async () => {
    const { handleProactiveRuntimeRequest } = await import("./handlers");

    const detail = await handleProactiveRuntimeRequest(
      new Request(
        "https://proactive-runtime.internal/api/internal/proactive-runtime/deployment-run-observability/read",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer gateway-key",
          },
          body: JSON.stringify({
            kind: "detail",
            workspaceId: "workspace-1",
            agentId: "agent-1",
            runId: "run-1",
          }),
        },
      ),
    );
    const envelope = await handleProactiveRuntimeRequest(
      new Request(
        "https://proactive-runtime.internal/api/internal/proactive-runtime/deployment-run-observability/read",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-agent-gateway-secret": "gateway-key",
          },
          body: JSON.stringify({
            kind: "envelope",
            workspaceId: "workspace-1",
            agentId: "agent-1",
            runId: "run-1",
          }),
        },
      ),
    );

    expect(detail.status).toBe(200);
    expect(envelope.status).toBe(200);
    expect(mocks.getAuthorizedDeploymentRun).toHaveBeenCalledWith(expect.any(Request), {
      workspaceId: "workspace-1",
      agentId: "agent-1",
      runId: "run-1",
    });
    expect(mocks.getAuthorizedDeploymentRunEnvelope).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      runId: "run-1",
    });
  });

  it("rejects deployment run reads without the internal service secret", async () => {
    const { handleProactiveRuntimeRequest } = await import("./handlers");

    const response = await handleProactiveRuntimeRequest(
      new Request(
        "https://proactive-runtime.internal/api/internal/proactive-runtime/deployment-run-observability/read",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "list",
            workspaceId: "workspace-1",
            agentId: "agent-1",
          }),
        },
      ),
    );

    expect(response.status).toBe(401);
    expect(mocks.listAuthorizedDeploymentRuns).not.toHaveBeenCalled();
  });
});
