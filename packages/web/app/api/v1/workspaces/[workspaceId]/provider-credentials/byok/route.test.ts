import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  requireSessionAuth: vi.fn(),
  requireAuthScope: vi.fn(),
  hasWorkspaceAccess: vi.fn(),
  selectLimit: vi.fn(),
  insertValues: vi.fn(),
  updateSet: vi.fn(),
  updateWhere: vi.fn(),
  deleteWhere: vi.fn(),
  storeCredential: vi.fn(),
  tryResourceValue: vi.fn(),
  optionalEnv: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
  requireSessionAuth: mocks.requireSessionAuth,
  requireAuthScope: mocks.requireAuthScope,
}));

vi.mock("@/lib/integrations/integration-route-handler", () => ({
  hasWorkspaceAccess: mocks.hasWorkspaceAccess,
}));

vi.mock("@/lib/env", () => ({
  tryResourceValue: mocks.tryResourceValue,
  optionalEnv: mocks.optionalEnv,
}));

vi.mock("sst", () => ({
  Resource: { WorkflowStorage: { bucketName: "workflow-storage-test" } },
}));

vi.mock("@cloud/core/auth/credential-store.js", () => ({
  CredentialStore: class {
    store(...args: unknown[]) {
      return mocks.storeCredential(...args);
    }
  },
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: mocks.selectLimit,
          orderBy: () => ({
            limit: mocks.selectLimit,
          }),
        }),
      }),
    }),
    update: () => ({
      set: (...args: unknown[]) => {
        mocks.updateSet(...args);
        return { where: mocks.updateWhere };
      },
    }),
    delete: () => ({ where: mocks.deleteWhere }),
    insert: () => ({ values: mocks.insertValues }),
  }),
}));

import { POST } from "./route";

const workspaceId = "00000000-0000-0000-0000-000000000002";
const auth = {
  userId: "00000000-0000-0000-0000-000000000001",
  workspaceId,
  organizationId: "00000000-0000-0000-0000-000000000003",
  source: "token" as const,
  scopes: ["cli:auth"],
};

function context() {
  return { params: Promise.resolve({ workspaceId }) };
}

function request(body: Record<string, unknown>) {
  return new NextRequest(`https://cloud.test/api/v1/workspaces/${workspaceId}/provider-credentials/byok`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("provider credentials BYOK route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue(auth);
    mocks.requireSessionAuth.mockReturnValue(false);
    mocks.requireAuthScope.mockImplementation((resolvedAuth, scope) => resolvedAuth.scopes?.includes(scope));
    mocks.hasWorkspaceAccess.mockReturnValue(true);
    mocks.tryResourceValue.mockReturnValue("0123456789abcdef0123456789abcdef");
    mocks.selectLimit.mockResolvedValue([]);
    mocks.insertValues.mockResolvedValue(undefined);
    mocks.updateSet.mockReturnValue(undefined);
    mocks.updateWhere.mockResolvedValue(undefined);
    mocks.deleteWhere.mockResolvedValue(undefined);
    mocks.storeCredential.mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [] })));
  });

  it("validates, stores, and inserts a BYOK credential", async () => {
    const response = await POST(
      request({ modelProvider: "anthropic", key: "sk-ant-test", label: "prod" }),
      context(),
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.providerCredentialId).toEqual(expect.any(String));
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-api-key": "sk-ant-test" }),
      }),
    );
    expect(mocks.storeCredential).toHaveBeenCalledWith(
      auth.userId,
      body.providerCredentialId,
      expect.stringContaining("sk-ant-test"),
    );
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        userId: auth.userId,
        modelProvider: "anthropic",
        authType: "byo_api_key",
        keyFingerprint: expect.any(String),
        status: "creating",
        credentialStoredAt: null,
        lastAuthenticatedAt: null,
      }),
    );
    expect(mocks.insertValues.mock.calls[0][0].keyFingerprint).not.toContain("sk-ant-test");
    expect(mocks.storeCredential.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.insertValues.mock.invocationCallOrder[0],
    );
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "connected",
        credentialStoredAt: expect.any(Date),
        lastAuthenticatedAt: expect.any(Date),
      }),
    );
  });

  it("returns provider validation errors as 400", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad key", { status: 401 })));

    const response = await POST(
      request({ modelProvider: "openai", key: "bad-key" }),
      context(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "provider_key_invalid" });
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated and inaccessible requests", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce(null);
    const unauthenticated = await POST(
      request({ modelProvider: "anthropic", key: "sk-ant-test" }),
      context(),
    );
    expect(unauthenticated.status).toBe(401);

    mocks.hasWorkspaceAccess.mockReturnValueOnce(false);
    const forbidden = await POST(
      request({ modelProvider: "anthropic", key: "sk-ant-test" }),
      context(),
    );
    expect(forbidden.status).toBe(403);
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON bodies", async () => {
    const response = await POST(
      new NextRequest(`https://cloud.test/api/v1/workspaces/${workspaceId}/provider-credentials/byok`, {
        method: "POST",
        body: "{",
      }),
      context(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Invalid JSON body" });
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it("is idempotent for an existing provider, label, and key fingerprint", async () => {
    mocks.selectLimit.mockResolvedValueOnce([{ id: "credential-existing" }]);

    const response = await POST(
      request({ modelProvider: "anthropic", key: "sk-ant-test", label: "prod" }),
      context(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      providerCredentialId: "credential-existing",
    });
    expect(mocks.storeCredential).not.toHaveBeenCalled();
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it("creates a separate credential when the same label is used with a different key", async () => {
    const first = await POST(
      request({ modelProvider: "anthropic", key: "sk-ant-test-one", label: "prod" }),
      context(),
    );
    const second = await POST(
      request({ modelProvider: "anthropic", key: "sk-ant-test-two", label: "prod" }),
      context(),
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(mocks.insertValues).toHaveBeenCalledTimes(2);
    const firstInsert = mocks.insertValues.mock.calls[0][0];
    const secondInsert = mocks.insertValues.mock.calls[1][0];
    expect(firstInsert).toMatchObject({ label: "prod", keyFingerprint: expect.any(String) });
    expect(secondInsert).toMatchObject({ label: "prod", keyFingerprint: expect.any(String) });
    expect(firstInsert.keyFingerprint).not.toBe(secondInsert.keyFingerprint);
  });

  it("removes the pending row when encrypted credential storage fails", async () => {
    mocks.storeCredential.mockRejectedValueOnce(new Error("s3 unavailable"));

    const response = await POST(
      request({ modelProvider: "anthropic", key: "sk-ant-test", label: "prod" }),
      context(),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ code: "credential_store_failed" });
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "creating",
        credentialStoredAt: null,
      }),
    );
    expect(mocks.deleteWhere).toHaveBeenCalled();
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });
});
