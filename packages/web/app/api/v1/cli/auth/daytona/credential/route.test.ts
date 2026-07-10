import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  requireAuthScope: vi.fn(),
  createCredentialStoreS3Client: vi.fn(),
  credentialStoreStore: vi.fn(),
  getDb: vi.fn(),
  ensureActiveProviderCredential: vi.fn(),
  optionalEnv: vi.fn(),
  tryResourceValue: vi.fn(),
}));

vi.mock("sst", () => ({
  Resource: {
    WorkflowStorage: { bucketName: "workflow-storage-test" },
    CredentialEncryptionKey: { value: "test-encryption-key" },
  },
}));

vi.mock("@cloud/core/auth/credential-store.js", () => ({
  CredentialStore: class {
    store = mocks.credentialStoreStore;
  },
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
  requireAuthScope: mocks.requireAuthScope,
}));

vi.mock("@/lib/storage", () => ({
  createCredentialStoreS3Client: mocks.createCredentialStoreS3Client,
}));

vi.mock("@/lib/db", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@/lib/integrations/provider-credential-activation", () => ({
  ensureActiveProviderCredential: mocks.ensureActiveProviderCredential,
}));

vi.mock("@/lib/env", () => ({
  optionalEnv: mocks.optionalEnv,
  tryResourceValue: mocks.tryResourceValue,
}));

import { POST } from "./route";

const auth = {
  userId: "user_123",
  workspaceId: "workspace_123",
  organizationId: "org_123",
  source: "bearer",
  scopes: ["cli:auth"],
};

function request(body: unknown): NextRequest {
  return new NextRequest(
    "https://agentrelay.test/api/v1/cli/auth/daytona/credential",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    },
  );
}

function dbWithExisting(rows: Array<{ id: string }> = []) {
  const selectLimit = vi.fn(async () => rows);
  const selectWhere = vi.fn(() => ({ limit: selectLimit }));
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  const insertValues = vi.fn(async () => undefined);
  const insert = vi.fn(() => ({ values: insertValues }));

  const updateWhere = vi.fn(async () => undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  return {
    select,
    insert,
    update,
    insertValues,
    updateSet,
    updateWhere,
  };
}

describe("POST /api/v1/cli/auth/daytona/credential", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue(auth);
    mocks.requireAuthScope.mockReturnValue(true);
    mocks.createCredentialStoreS3Client.mockResolvedValue({ kind: "s3-client" });
    mocks.credentialStoreStore.mockResolvedValue(undefined);
    mocks.ensureActiveProviderCredential.mockResolvedValue(undefined);
    mocks.tryResourceValue.mockReturnValue("test-encryption-key");
    mocks.optionalEnv.mockReturnValue(undefined);
    mocks.getDb.mockReturnValue(dbWithExisting([]));
  });

  it("requires authentication and cli:auth scope", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce(null);

    await expect(POST(request({}))).resolves.toMatchObject({ status: 401 });

    mocks.resolveRequestAuth.mockResolvedValueOnce(auth);
    mocks.requireAuthScope.mockReturnValueOnce(false);

    await expect(POST(request({}))).resolves.toMatchObject({ status: 403 });
  });

  it("rejects invalid Daytona credential bodies", async () => {
    const missing = await POST(request({ accessToken: "a", expiresAt: "2026-06-12T10:00:00.000Z" }));
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toMatchObject({
      error: "refreshToken is required",
    });

    const badExpiry = await POST(request({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: "not-a-date",
    }));
    expect(badExpiry.status).toBe(400);
    await expect(badExpiry.json()).resolves.toMatchObject({
      error: "expiresAt must be a valid ISO-8601 timestamp",
    });
  });

  it("stores a normalized Daytona credential and inserts a connected provider credential row", async () => {
    const db = dbWithExisting([]);
    mocks.getDb.mockReturnValue(db);

    const response = await POST(request({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: "2026-06-13T10:00:00.000Z",
      orgId: "org-daytona",
    }));

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      success: true,
      provider: "daytona",
      credentialExpiresAt: "2026-06-13T10:00:00.000Z",
    });
    expect(body.providerCredentialId).toEqual(expect.any(String));
    expect(mocks.createCredentialStoreS3Client).toHaveBeenCalledWith({
      userId: "user_123",
    });
    expect(mocks.credentialStoreStore).toHaveBeenCalledWith(
      "user_123",
      "daytona",
      JSON.stringify({
        provider: "daytona",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresAt: "2026-06-13T10:00:00.000Z",
        orgId: "org-daytona",
      }),
    );
    expect(db.insertValues).toHaveBeenCalledWith(expect.objectContaining({
      id: body.providerCredentialId,
      organizationId: "org_123",
      workspaceId: "workspace_123",
      userId: "user_123",
      harness: "daytona",
      modelProvider: "daytona",
      authType: "provider_oauth",
      displayName: "Daytona",
      status: "connected",
      credentialStoredAt: expect.any(Date),
      credentialExpiresAt: new Date("2026-06-13T10:00:00.000Z"),
      lastAuthenticatedAt: expect.any(Date),
    }));
    expect(db.update).not.toHaveBeenCalled();
    expect(mocks.ensureActiveProviderCredential).toHaveBeenCalledWith({
      userId: "user_123",
      workspaceId: "workspace_123",
      modelProvider: "daytona",
    });
  });

  it("updates an existing Daytona provider credential row", async () => {
    const db = dbWithExisting([{ id: "cred_existing" }]);
    mocks.getDb.mockReturnValue(db);

    const response = await POST(request({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: "2026-06-13T10:00:00.000Z",
      orgId: null,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      providerCredentialId: "cred_existing",
      id: "cred_existing",
    });
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.updateSet).toHaveBeenCalledWith(expect.objectContaining({
      status: "connected",
      credentialStoredAt: expect.any(Date),
      credentialExpiresAt: new Date("2026-06-13T10:00:00.000Z"),
      lastAuthenticatedAt: expect.any(Date),
      refreshAttempts: 0,
      refreshExhausted: false,
      lastRefreshAttemptAt: null,
      lastError: null,
    }));
    expect(mocks.credentialStoreStore).toHaveBeenCalledWith(
      "user_123",
      "daytona",
      JSON.stringify({
        provider: "daytona",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresAt: "2026-06-13T10:00:00.000Z",
      }),
    );
  });
});
