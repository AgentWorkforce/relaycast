import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  drainIntegrationWatchDeliveries: vi.fn(),
  sweepCoalescedIssueDispatchRedispatches: vi.fn(),
  tryResourceValue: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  tryResourceValue: mocks.tryResourceValue,
}));

vi.mock("@/lib/proactive-runtime/integration-watch-deliveries", () => ({
  drainIntegrationWatchDeliveries: mocks.drainIntegrationWatchDeliveries,
  sweepCoalescedIssueDispatchRedispatches: mocks.sweepCoalescedIssueDispatchRedispatches,
}));

describe("integration-watch delivery sweep route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tryResourceValue.mockReturnValue("relaycron-key");
    mocks.drainIntegrationWatchDeliveries.mockResolvedValue({
      attempted: 1,
      delivered: 1,
      failed: 0,
      pending: 0,
      terminal: 0,
    });
    mocks.sweepCoalescedIssueDispatchRedispatches.mockResolvedValue(0);
  });

  it("authenticates relaycron and clamps pending delivery drains within the cron budget", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      new Request(
        "https://cloud.test/api/internal/proactive-runtime/integration-watch-deliveries/sweep",
        {
          method: "POST",
          headers: {
            authorization: "Bearer relaycron-key",
            "content-type": "application/json",
          },
          body: JSON.stringify({ limit: 9 }),
        },
      ) as never,
    );

    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: {
        attempted: 1,
        delivered: 1,
        failed: 0,
        pending: 0,
        terminal: 0,
        coalescedRedispatched: 0,
      },
    });
    expect(response.status).toBe(200);
    expect(mocks.drainIntegrationWatchDeliveries).toHaveBeenCalledWith({
      limit: 6,
      maxDeliveryAgeSeconds: 60 * 60,
      deliveryOptions: {
        sandboxCreateTimeoutSeconds: 120,
        runScriptTimeoutMs: 15_000,
        asyncRunScript: true,
      },
      allowTeamLaunchN1: true,
    });
    expect(mocks.sweepCoalescedIssueDispatchRedispatches).toHaveBeenCalledWith({});
  });

  it("rejects unauthenticated sweep requests", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      new Request(
        "https://cloud.test/api/internal/proactive-runtime/integration-watch-deliveries/sweep",
        {
          method: "POST",
        },
      ) as never,
    );

    expect(response.status).toBe(401);
    expect(mocks.drainIntegrationWatchDeliveries).not.toHaveBeenCalled();
  });
});
