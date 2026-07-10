import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyProactiveRuntimeRequest: vi.fn(),
}));

vi.mock("@/lib/proactive-runtime/service-client", () => ({
  proxyProactiveRuntimeRequest: mocks.proxyProactiveRuntimeRequest,
}));

const REAPER_URL =
  "https://cloud.test/api/internal/proactive-runtime/sandbox-reaper";

describe("stopped sandbox reaper route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyProactiveRuntimeRequest.mockResolvedValue(
      Response.json({ ok: true, data: { deleted: 2 } }),
    );
  });

  it("proxies relaycron reaper requests to the proactive runtime worker", async () => {
    const { POST } = await import("./route");
    const request = new Request(REAPER_URL, {
      method: "POST",
      headers: {
        authorization: "Bearer relaycron-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    const response = await POST(request as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: { deleted: 2 },
    });
    expect(mocks.proxyProactiveRuntimeRequest).toHaveBeenCalledWith(request);
  });

  it("preserves upstream worker status codes", async () => {
    const { POST } = await import("./route");
    mocks.proxyProactiveRuntimeRequest.mockResolvedValue(
      Response.json({ ok: false, error: "unauthorized" }, { status: 401 }),
    );

    const response = await POST(
      new Request(REAPER_URL, {
        method: "POST",
        headers: {
          authorization: "Bearer relaycron-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({ minAgeHours: 8, clearLeases: false }),
      }) as never,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "unauthorized",
    });
  });
});
