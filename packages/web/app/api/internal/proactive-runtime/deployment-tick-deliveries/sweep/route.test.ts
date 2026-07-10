import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyProactiveRuntimeRequest: vi.fn(),
}));

vi.mock("@/lib/proactive-runtime/service-client", () => ({
  proxyProactiveRuntimeRequest: mocks.proxyProactiveRuntimeRequest,
}));

describe("deployment-tick delivery sweep route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyProactiveRuntimeRequest.mockResolvedValue(
      Response.json({
        ok: true,
        data: { attempted: 1, delivered: 1, failed: 0, pending: 0, terminal: 0 },
      }),
    );
  });

  it("proxies relaycron sweep requests to the proactive runtime worker", async () => {
    const { POST } = await import("./route");
    const request = new Request(
      "https://cloud.test/api/internal/proactive-runtime/deployment-tick-deliveries/sweep",
      {
        method: "POST",
        headers: {
          authorization: "Bearer relaycron-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({ limit: 9 }),
      },
    );

    const response = await POST(request as never);

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
    expect(response.status).toBe(200);
    expect(mocks.proxyProactiveRuntimeRequest).toHaveBeenCalledWith(request);
  });

  it("preserves upstream worker status codes", async () => {
    const { POST } = await import("./route");
    mocks.proxyProactiveRuntimeRequest.mockResolvedValue(
      Response.json({ ok: false, error: "unauthorized" }, { status: 401 }),
    );

    const response = await POST(
      new Request(
        "https://cloud.test/api/internal/proactive-runtime/deployment-tick-deliveries/sweep",
        {
          method: "POST",
        },
      ) as never,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "unauthorized",
    });
  });
});
