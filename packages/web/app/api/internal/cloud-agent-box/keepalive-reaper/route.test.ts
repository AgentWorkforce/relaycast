import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reapExpiredCloudAgentBoxKeepalives: vi.fn(),
  tryResourceValue: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  tryResourceValue: mocks.tryResourceValue,
}));

vi.mock("@/app/api/v1/workspaces/[workspaceId]/cloud-agents/[cloudAgentId]/box/box-manager", () => ({
  reapExpiredCloudAgentBoxKeepalives: mocks.reapExpiredCloudAgentBoxKeepalives,
}));

const REAPER_URL =
  "https://cloud.test/api/internal/cloud-agent-box/keepalive-reaper";

describe("cloud agent box keepalive reaper route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tryResourceValue.mockReturnValue("relaycron-key");
    mocks.reapExpiredCloudAgentBoxKeepalives.mockResolvedValue({
      found: 2,
      stopped: 1,
      vanished: 1,
      failed: [],
    });
  });

  it("authenticates relaycron and runs the keepalive reaper", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      new Request(REAPER_URL, {
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
      data: {
        found: 2,
        stopped: 1,
        vanished: 1,
        failed: [],
      },
    });
    expect(mocks.reapExpiredCloudAgentBoxKeepalives).toHaveBeenCalledWith(undefined, {
      limit: undefined,
    });
  });

  it("forwards an explicit limit", async () => {
    const { POST } = await import("./route");

    await POST(
      new Request(REAPER_URL, {
        method: "POST",
        headers: {
          authorization: "Bearer relaycron-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({ limit: 7.8 }),
      }) as never,
    );

    expect(mocks.reapExpiredCloudAgentBoxKeepalives).toHaveBeenCalledWith(undefined, {
      limit: 7,
    });
  });

  it("rejects unauthenticated reaper requests", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      new Request(REAPER_URL, { method: "POST" }) as never,
    );

    expect(response.status).toBe(401);
    expect(mocks.reapExpiredCloudAgentBoxKeepalives).not.toHaveBeenCalled();
  });
});
