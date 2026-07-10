import { beforeEach, describe, expect, it, vi } from "vitest";

const resourceMock = vi.hoisted(() => ({
  Resource: {
    CloudAgentSpawnQuotaDefault: { value: "12" },
  },
}));

vi.mock("sst", () => resourceMock);
vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({ kind: "eq" })),
}));
vi.mock("@/lib/db/schema", () => ({
  users: {
    id: "users.id",
    cloudAgentSpawnQuotaOverride: "users.cloud_agent_spawn_quota_override",
  },
}));

describe("cloud agent quotas", () => {
  beforeEach(() => {
    delete process.env.CLOUD_AGENT_SPAWN_QUOTA_DEFAULT;
    resourceMock.Resource.CloudAgentSpawnQuotaDefault = { value: "12" };
    vi.resetModules();
  });

  it("uses the SST resource default before the local env fallback", async () => {
    process.env.CLOUD_AGENT_SPAWN_QUOTA_DEFAULT = "20";
    const { getDefaultCloudAgentSpawnQuota } = await import("./cloud-agent-quotas");

    expect(getDefaultCloudAgentSpawnQuota()).toBe(12);
  });

  it("uses the per-user database override when present", async () => {
    const { getEffectiveCloudAgentSpawnQuota } = await import("./cloud-agent-quotas");
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ override: 3 }],
          }),
        }),
      }),
    };

    await expect(getEffectiveCloudAgentSpawnQuota(db as never, "user-1")).resolves.toBe(3);
  });
});
