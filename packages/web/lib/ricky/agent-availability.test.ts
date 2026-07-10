import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  and: vi.fn(),
  desc: vi.fn((field: unknown) => ({ direction: "desc", field })),
  eq: vi.fn(),
  inArray: vi.fn(),
  getDb: vi.fn(),
  orderBy: vi.fn(),
  listConnectedProviders: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  and: mocks.and,
  desc: mocks.desc,
  eq: mocks.eq,
  inArray: mocks.inArray,
}));

vi.mock("@/lib/db", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@/lib/db/schema", () => ({
  providerCredentials: {
    id: "id",
    workspaceId: "workspaceId",
    userId: "userId",
    harness: "harness",
    updatedAt: "updatedAt",
    createdAt: "createdAt",
  },
}));

vi.mock("@/lib/workflows", () => ({
  listConnectedProviders: mocks.listConnectedProviders,
}));

vi.mock("sst", () => ({
  Resource: {},
}));

import { resolveAgentAvailability } from "./agent-availability";

const workspaceId = "00000000-0000-0000-0000-000000000002";
const userId = "00000000-0000-0000-0000-000000000001";

function mockProviderRows(rows: Array<Record<string, unknown>>) {
  mocks.orderBy.mockResolvedValueOnce(rows);
  mocks.getDb.mockReturnValue({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: mocks.orderBy,
        }),
      }),
    }),
  });
}

describe("resolveAgentAvailability", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.desc.mockImplementation((field: unknown) => ({ direction: "desc", field }));
    mocks.listConnectedProviders.mockResolvedValue([]);
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    delete process.env.CREDENTIAL_PROXY_URL;
    delete process.env.RELAY_LLM_PROXY_URL;
    delete process.env.CREDENTIAL_PROXY_TOKEN;
    delete process.env.RELAY_LLM_PROXY_TOKEN;
    delete process.env.RICKY_WORKFORCE_PERSONA_ID;
  });

  it("selects the preferred provider credential deterministically when a harness has multiple rows", async () => {
    mockProviderRows([
      {
        id: "credential-unhealthy-newer",
        harness: "claude",
        status: "disconnected",
        refreshExhausted: false,
        credentialExpiresAt: null,
        lastAuthenticatedAt: new Date("2026-05-13T11:00:00.000Z"),
        updatedAt: new Date("2026-05-13T11:00:00.000Z"),
        createdAt: new Date("2026-05-13T11:00:00.000Z"),
        lastError: "credential disconnected",
      },
      {
        id: "credential-connected-older",
        harness: "claude",
        status: "connected",
        refreshExhausted: false,
        credentialExpiresAt: null,
        lastAuthenticatedAt: new Date("2026-05-13T09:00:00.000Z"),
        updatedAt: new Date("2026-05-13T09:00:00.000Z"),
        createdAt: new Date("2026-05-13T09:00:00.000Z"),
        lastError: null,
      },
    ]);

    const availability = await resolveAgentAvailability({
      userId,
      workspaceId,
      workflow: "run with claude",
      fileType: "ts",
      policy: {
        enabled: true,
        maxAttempts: 1,
        preferWorkforcePersona: false,
        allowOpenRouterFallback: false,
        requireHumanApprovalFor: [],
      },
    });

    expect(availability.subscriptionAgents).toEqual([
      expect.objectContaining({
        cli: "claude",
        source: "cloud_agents",
        status: "usable",
        lastAuthenticatedAt: "2026-05-13T09:00:00.000Z",
      }),
    ]);
    expect(mocks.orderBy).toHaveBeenCalledWith(
      { direction: "desc", field: "updatedAt" },
      { direction: "desc", field: "createdAt" },
      { direction: "desc", field: "id" },
    );
  });
});
