import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  loggerWarn: vi.fn(),
}));

vi.mock("@/lib/cloudflare-context", () => ({
  getCloudflareContext: () => ({ env: mocks.env }),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    warn: mocks.loggerWarn,
  },
}));

describe("integration-watch delivery drain queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env = {};
  });

  it("enqueues a durable delivery drain message on WEBHOOK_QUEUE", async () => {
    const send = vi.fn();
    mocks.env = {
      WEBHOOK_QUEUE: { send },
    };
    const { enqueueIntegrationWatchDeliveryDrain } = await import("./integration-watch-delivery-queue");

    await expect(enqueueIntegrationWatchDeliveryDrain({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deliveryId: "delivery-1",
    })).resolves.toBe("enqueued");

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toMatchObject({
      version: 2,
      provider: "internal",
      ingress: "integration-watch-delivery-drain",
      headers: {
        "content-type": "application/json",
      },
      delivery: {
        workspaceId: "workspace-1",
        agentId: "agent-1",
        deliveryId: "delivery-1",
      },
      dedupe: {
        kind: "integration-watch-delivery-drain",
        deliveryId: "delivery-1",
      },
    });
    expect(JSON.parse(send.mock.calls[0][0].payload.body)).toEqual({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deliveryId: "delivery-1",
    });
  });

  it("enqueues a bounded agent backlog drain message", async () => {
    const send = vi.fn();
    mocks.env = {
      WEBHOOK_QUEUE: { send },
    };
    const { enqueueIntegrationWatchDeliveryDrain } = await import("./integration-watch-delivery-queue");

    await expect(enqueueIntegrationWatchDeliveryDrain({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      limit: 3,
    })).resolves.toBe("enqueued");

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toMatchObject({
      version: 2,
      provider: "internal",
      ingress: "integration-watch-delivery-drain",
      requestId: "integration-watch-drain:backlog:workspace-1:agent-1",
      delivery: {
        workspaceId: "workspace-1",
        agentId: "agent-1",
        limit: 3,
      },
      dedupe: {
        kind: "integration-watch-delivery-drain",
        deliveryId: "backlog:workspace-1:agent-1",
      },
    });
    expect(JSON.parse(send.mock.calls[0][0].payload.body)).toEqual({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      limit: 3,
    });
  });

  it("logs and returns unavailable when WEBHOOK_QUEUE is not bound", async () => {
    const { enqueueIntegrationWatchDeliveryDrain } = await import("./integration-watch-delivery-queue");

    await expect(enqueueIntegrationWatchDeliveryDrain({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      deliveryId: "delivery-1",
    })).resolves.toBe("unavailable");

    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "Integration watch durable delivery drain skipped without WEBHOOK_QUEUE binding",
      expect.objectContaining({
        area: "integration-watch-dispatch",
        workspaceId: "workspace-1",
        agentId: "agent-1",
        deliveryId: "delivery-1",
      }),
    );
  });
});
