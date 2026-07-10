import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  retrieve: vi.fn(),
  refreshHarnessCliCredentialIfStale: vi.fn(),
  fetchAccountUsageSnapshot: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock("sst", () => ({
  Resource: { WorkflowStorage: { bucketName: "workflow-storage-test" } },
}));

vi.mock("@cloud/core/auth/credential-store.js", () => ({
  CredentialStore: class {
    retrieve(userId: string, provider: string) {
      return mocks.retrieve(userId, provider);
    }
    store() {
      return Promise.resolve();
    }
  },
}));

vi.mock("@cloud/core/auth/account-usage.js", () => ({
  fetchAccountUsageSnapshot: (...args: unknown[]) =>
    mocks.fetchAccountUsageSnapshot(...args),
}));

vi.mock("@/lib/storage", () => ({
  createCredentialStoreS3Client: vi.fn(async () => ({ kind: "s3-client" })),
}));

vi.mock("@/lib/proactive-runtime/harness-credential-refresh", () => ({
  refreshHarnessCliCredentialIfStale: (...args: unknown[]) =>
    mocks.refreshHarnessCliCredentialIfStale(...args),
}));

vi.mock("@/lib/env", () => ({
  optionalEnv: vi.fn(() => "test-value"),
  tryResourceValue: vi.fn(() => "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  requireAuthScope: vi.fn(() => false),
  requireSessionAuth: vi.fn(() => true),
  resolveRequestAuth: vi.fn(async () => ({
    userId: "00000000-0000-4000-8000-000000000001",
    workspaceId: "00000000-0000-4000-8000-000000000002",
  })),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => mocks.getDb(),
}));

vi.mock("@/lib/db/schema", () => ({
  providerCredentials: {
    id: "id",
    displayName: "displayName",
    harness: "harness",
    modelProvider: "modelProvider",
    authType: "authType",
    label: "label",
    accountEmail: "accountEmail",
    isActive: "isActive",
    defaultModel: "defaultModel",
    status: "status",
    credentialStoredAt: "credentialStoredAt",
    lastAuthenticatedAt: "lastAuthenticatedAt",
    lastUsedAt: "lastUsedAt",
    lastError: "lastError",
    createdAt: "createdAt",
    updatedAt: "updatedAt",
    userId: "userId",
    workspaceId: "workspaceId",
  },
}));

import { GET } from "./route";

const now = new Date("2026-06-12T10:00:00.000Z");
const row = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "Codex",
  harness: "codex",
  modelProvider: "openai",
  authType: "provider_oauth",
  label: null,
  accountEmail: "person@example.com",
  isActive: true,
  defaultModel: "gpt-5.3-codex",
  status: "connected",
  credentialStoredAt: now,
  lastAuthenticatedAt: now,
  lastUsedAt: null,
  lastError: null,
  createdAt: now,
  updatedAt: now,
};

const sameProviderRow = {
  ...row,
  id: "22222222-2222-4222-8222-222222222222",
  displayName: "Codex reviewer",
};

function dbReturning(rows: unknown[]) {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(async () => rows),
  };
  return {
    select: vi.fn(() => chain),
  };
}

describe("GET /api/v1/cloud-agents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue(dbReturning([row]));
    mocks.retrieve.mockResolvedValue(JSON.stringify({ tokens: { access_token: "token" } }));
    mocks.refreshHarnessCliCredentialIfStale.mockImplementation(async ({ credentialJson }) => credentialJson);
    mocks.fetchAccountUsageSnapshot.mockResolvedValue({
      provider: "openai",
      status: "available",
      source: "codex-oauth",
      fetchedAt: now.toISOString(),
      windows: [
        {
          id: "session",
          label: "Session",
          usedPercent: 20,
          remainingPercent: 80,
          resetAt: null,
          windowMinutes: null,
        },
      ],
    });
  });

  it("does not fetch usage on the default listing path", async () => {
    const response = await GET(new NextRequest("https://cloud.test/api/v1/cloud-agents"));

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.agents).toHaveLength(1);
    expect(payload.agents[0].usage).toBeUndefined();
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.fetchAccountUsageSnapshot).not.toHaveBeenCalled();
  });

  it("attaches usage snapshots when requested", async () => {
    mocks.getDb.mockReturnValue(dbReturning([row, sameProviderRow]));

    const response = await GET(new NextRequest("https://cloud.test/api/v1/cloud-agents?usage=1"));

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.agents).toHaveLength(2);
    expect(payload.agents[0].usage.status).toBe("available");
    expect(mocks.retrieve).toHaveBeenCalledTimes(1);
    expect(mocks.retrieve).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
      "openai",
    );
    expect(mocks.refreshHarnessCliCredentialIfStale).toHaveBeenCalledTimes(1);
    expect(mocks.refreshHarnessCliCredentialIfStale).toHaveBeenCalledWith({
      store: expect.any(Object),
      userId: "00000000-0000-4000-8000-000000000001",
      provider: "openai",
      credentialJson: JSON.stringify({ tokens: { access_token: "token" } }),
    });
    expect(mocks.fetchAccountUsageSnapshot).toHaveBeenCalledTimes(2);
    expect(mocks.fetchAccountUsageSnapshot).toHaveBeenCalledWith({
      provider: "openai",
      credentialJson: JSON.stringify({ tokens: { access_token: "token" } }),
    });
  });
});
