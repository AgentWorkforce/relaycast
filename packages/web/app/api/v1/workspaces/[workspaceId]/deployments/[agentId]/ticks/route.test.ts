import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAgentDeploymentTickTarget: vi.fn(),
  verifyDeploymentWebhookSecret: vi.fn(),
  enqueueDeploymentTickDelivery: vi.fn(),
  readCloudflareWaitUntil: vi.fn(),
}));

vi.mock("@/lib/proactive-runtime/persona-deploy", () => ({
  getAgentDeploymentTickTarget: mocks.getAgentDeploymentTickTarget,
  verifyDeploymentWebhookSecret: mocks.verifyDeploymentWebhookSecret,
}));
vi.mock("@/lib/proactive-runtime/deployment-tick-deliveries", () => ({
  enqueueDeploymentTickDelivery: mocks.enqueueDeploymentTickDelivery,
}));
vi.mock("@/lib/proactive-runtime/deployment-trigger-delivery", () => ({
  DeploymentTriggerDeliveryError: class DeploymentTriggerDeliveryError extends Error {
    code: string;
    status: number;

    constructor(message: string, code = "delivery_error", status = 500) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
}));
vi.mock("@/lib/proactive-runtime/cloudflare-waituntil", () => ({
  readCloudflareWaitUntil: mocks.readCloudflareWaitUntil,
}));

import { POST } from "./route";

const workspaceId = "00000000-0000-0000-0000-000000000001";
const agentId = "00000000-0000-0000-0000-000000000002";
const deploymentToken = "deployment-webhook-secret";

function activeTarget(overrides: Record<string, unknown> = {}) {
  return {
    agentId,
    deployedName: "hn-monitor",
    deployedByUserId: "user-1",
    spec: null,
    agentSpec: { schedules: [{ name: "weekly", cron: "0 9 * * 1" }] },
    inputValues: {},
    credentialSelections: {},
    specHash: "hash",
    bundleSha256: "sha",
    personaSlug: "hn-monitor",
    status: "active",
    webhookSecretHash: "secret-hash",
    ...overrides,
  };
}

function request(input?: {
  body?: unknown;
  headers?: Record<string, string>;
}): NextRequest {
  return new NextRequest(
    `https://cloud.test/api/v1/workspaces/${workspaceId}/deployments/${agentId}/ticks?deployment_token=${deploymentToken}`,
    {
      method: "POST",
      headers: {
        ...(input?.body === undefined ? {} : { "content-type": "application/json" }),
        ...input?.headers,
      },
      ...(input?.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    },
  );
}

function routeContext() {
  return { params: Promise.resolve({ workspaceId, agentId }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAgentDeploymentTickTarget.mockResolvedValue(activeTarget());
  mocks.verifyDeploymentWebhookSecret.mockReturnValue(true);
  mocks.readCloudflareWaitUntil.mockReturnValue(() => {});
  mocks.enqueueDeploymentTickDelivery.mockResolvedValue({
    agentId,
    workspaceId,
    deploymentId: "deployment-1",
    status: "starting" as const,
  });
});

describe("POST /deployments/:agentId/ticks", () => {
  it("keeps body occurrence identity as the primary source", async () => {
    const response = await POST(
      request({
        body: {
          type: "cron.tick",
          gatewayScheduleId: "gateway-schedule-1",
          occurrenceEpoch: 1_781_000_000_000,
          occurrenceId: "body-occurrence-id",
        },
        headers: {
          "X-AgentCron-Occurrence-Epoch": "1781000001111",
          "X-AgentCron-Occurrence-Id": "header-occurrence-id",
        },
      }),
      routeContext(),
    );

    expect(response.status).toBe(202);
    expect(mocks.enqueueDeploymentTickDelivery).toHaveBeenCalledOnce();
    const call = mocks.enqueueDeploymentTickDelivery.mock.calls[0][0];
    expect(call.options).toEqual({
      sandboxCreateTimeoutSeconds: 120,
      runScriptTimeoutMs: 15_000,
      asyncRunScript: true,
    });
    expect(call.options).not.toHaveProperty("runScriptMaxSeconds");
    expect(call.payload).toMatchObject({
      type: "cron.tick",
      gatewayScheduleId: "gateway-schedule-1",
      occurrenceEpoch: 1_781_000_000_000,
      occurrenceId: "body-occurrence-id",
    });
  });

  it("falls back to executor-owned occurrence headers when the body omits them", async () => {
    const response = await POST(
      request({
        headers: {
          "X-AgentCron-Occurrence-Epoch": "1781000000000",
          "X-AgentCron-Occurrence-Id": "header-occurrence-id",
        },
      }),
      routeContext(),
    );

    expect(response.status).toBe(202);
    expect(mocks.enqueueDeploymentTickDelivery).toHaveBeenCalledOnce();
    const call = mocks.enqueueDeploymentTickDelivery.mock.calls[0][0];
    expect(call.options).toEqual({
      sandboxCreateTimeoutSeconds: 120,
      runScriptTimeoutMs: 15_000,
      asyncRunScript: true,
    });
    expect(call.options).not.toHaveProperty("runScriptMaxSeconds");
    expect(call.payload).toMatchObject({
      occurrenceEpoch: 1_781_000_000_000,
      occurrenceId: "header-occurrence-id",
    });
  });
});
