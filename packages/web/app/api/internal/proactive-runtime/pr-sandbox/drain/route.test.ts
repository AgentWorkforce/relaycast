import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  drainPrSandboxWarmPool: vi.fn(),
  tryResourceValue: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  tryResourceValue: mocks.tryResourceValue,
}));

vi.mock("@/lib/proactive-runtime/deployment-sandbox-recycle", () => ({
  drainPrSandboxWarmPool: mocks.drainPrSandboxWarmPool,
}));

const DRAIN_URL =
  "https://cloud.test/api/internal/proactive-runtime/pr-sandbox/drain";

describe("pr-sandbox warm-pool drain route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tryResourceValue.mockReturnValue("relaycron-key");
    mocks.drainPrSandboxWarmPool.mockResolvedValue({
      found: 2,
      deleted: 2,
      failed: [],
      leasesCleared: 2,
    });
  });

  it("authenticates relaycron and drains the warm pool", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      new Request(DRAIN_URL, {
        method: "POST",
        headers: {
          authorization: "Bearer relaycron-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }) as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: { found: 2, deleted: 2, failed: [], leasesCleared: 2 },
    });
    expect(mocks.drainPrSandboxWarmPool).toHaveBeenCalledWith({ clearLeases: true });
  });

  it("forwards an explicit clearLeases=false flag", async () => {
    const { POST } = await import("./route");

    await POST(
      new Request(DRAIN_URL, {
        method: "POST",
        headers: {
          authorization: "Bearer relaycron-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({ clearLeases: false }),
      }) as never,
    );

    expect(mocks.drainPrSandboxWarmPool).toHaveBeenCalledWith({ clearLeases: false });
  });

  it("rejects unauthenticated drain requests", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      new Request(DRAIN_URL, { method: "POST" }) as never,
    );

    expect(response.status).toBe(401);
    expect(mocks.drainPrSandboxWarmPool).not.toHaveBeenCalled();
  });
});
