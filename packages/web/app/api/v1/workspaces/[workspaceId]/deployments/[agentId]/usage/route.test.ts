import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  recordHarnessSpendEvent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({ execute: mocks.execute }),
}));

vi.mock("@/lib/billing/spend-writer", () => ({
  recordHarnessSpendEvent: mocks.recordHarnessSpendEvent,
}));

import { POST } from "./route";

const workspaceId = "00000000-0000-0000-0000-000000000002";
const agentId = "00000000-0000-0000-0000-000000000004";
const userId = "00000000-0000-0000-0000-000000000001";
const credentialId = "00000000-0000-0000-0000-000000000005";
const webhookSecret = "test-secret";
const webhookSecretHash = createHash("sha256").update(webhookSecret).digest("hex");

function context() {
  return { params: Promise.resolve({ workspaceId, agentId }) };
}

function request(body: Record<string, unknown>, secret = webhookSecret): NextRequest {
  return new NextRequest(
    `https://cloud.test/api/v1/workspaces/${workspaceId}/deployments/${agentId}/usage`,
    {
      method: "POST",
      headers: { "x-cloud-agent-deployment-token": secret },
      body: JSON.stringify(body),
    },
  );
}

describe("deployment usage route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.execute
      .mockResolvedValueOnce({
        rows: [{
          id: agentId,
          deployed_by_user_id: userId,
          credential_selections: { anthropic: credentialId },
          schedule_webhook_secret_hash: webhookSecretHash,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: credentialId,
          model_provider: "anthropic",
          auth_type: "relay_managed",
          user_id: userId,
        }],
      });
    mocks.recordHarnessSpendEvent.mockResolvedValue({
      costUsdMicros: 6_000n,
      markupUsdMicros: 1_800n,
    });
  });

  it("records usage for the deployed provider credential", async () => {
    const response = await POST(
      request({
        modelProvider: "anthropic",
        model: "claude-sonnet-4-latest",
        inputTokens: 1_000,
        outputTokens: 200,
        runId: "00000000-0000-0000-0000-000000000006",
      }),
      context(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      recorded: true,
      costUsdMicros: "6000",
      markupUsdMicros: "1800",
    });
    expect(mocks.recordHarnessSpendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        providerCredentialId: credentialId,
        modelProvider: "anthropic",
        authType: "relay_managed",
        userId,
        agentId,
        model: "claude-sonnet-4-latest",
        inputTokens: 1000,
        outputTokens: 200,
      }),
    );
  });

  it("normalizes harness provider aliases before matching deployed credentials", async () => {
    const response = await POST(
      request({
        modelProvider: "claude",
        model: "claude-sonnet-4-latest",
        inputTokens: 100,
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(mocks.recordHarnessSpendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        providerCredentialId: credentialId,
        modelProvider: "anthropic",
        authType: "relay_managed",
      }),
    );
  });

  it("rejects mismatched provider credential reports", async () => {
    const response = await POST(
      request({
        modelProvider: "anthropic",
        providerCredentialId: "00000000-0000-0000-0000-000000000099",
        model: "claude-sonnet-4-latest",
      }),
      context(),
    );

    expect(response.status).toBe(409);
    expect(mocks.recordHarnessSpendEvent).not.toHaveBeenCalled();
  });

  it("rejects invalid deployment webhook tokens", async () => {
    const response = await POST(
      request({
        modelProvider: "anthropic",
        model: "claude-sonnet-4-latest",
      }, "wrong-secret"),
      context(),
    );

    expect(response.status).toBe(401);
    expect(mocks.recordHarnessSpendEvent).not.toHaveBeenCalled();
  });
});
