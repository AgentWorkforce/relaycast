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
  createCredentialStoreS3Client: vi.fn(),
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

vi.mock("@/lib/storage", () => ({
  createCredentialStoreS3Client: mocks.createCredentialStoreS3Client,
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
  return new NextRequest(`https://cloud.test/api/v1/workspaces/${workspaceId}/provider-credentials/setup-token`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("provider credentials setup-token route", () => {
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
    mocks.createCredentialStoreS3Client.mockResolvedValue({ kind: "worker-aware-s3-client" });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [] })));
  });

  it("validates, stores, and inserts an Anthropic setup-token credential", async () => {
    const response = await POST(
      request({ token: "sk-ant-oat-test", label: "Claude setup" }),
      context(),
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.providerCredentialId).toEqual(expect.any(String));
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer sk-ant-oat-test",
          "anthropic-beta": "oauth-2025-04-20",
        }),
      }),
    );
    expect(mocks.storeCredential).toHaveBeenCalledWith(
      auth.userId,
      "anthropic",
      JSON.stringify({ type: "oauth_token", modelProvider: "anthropic", token: "sk-ant-oat-test" }),
    );
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        userId: auth.userId,
        modelProvider: "anthropic",
        authType: "oauth_token",
        label: "Claude setup",
        keyFingerprint: expect.any(String),
        status: "creating",
      }),
    );
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "connected",
        credentialStoredAt: expect.any(Date),
        lastAuthenticatedAt: expect.any(Date),
      }),
    );
  });

  it("returns the existing connected credential without rewriting the same token", async () => {
    mocks.selectLimit.mockResolvedValueOnce([
      {
        id: "credential-existing",
        keyFingerprint: "not-the-real-fingerprint",
        status: "connected",
      },
    ]);
    const first = await POST(request({ token: "sk-ant-oat-same" }), context());
    const fingerprint = mocks.updateSet.mock.calls[0][0].keyFingerprint;

    vi.clearAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue(auth);
    mocks.requireSessionAuth.mockReturnValue(false);
    mocks.requireAuthScope.mockImplementation((resolvedAuth, scope) => resolvedAuth.scopes?.includes(scope));
    mocks.hasWorkspaceAccess.mockReturnValue(true);
    mocks.tryResourceValue.mockReturnValue("0123456789abcdef0123456789abcdef");
    mocks.selectLimit.mockResolvedValueOnce([
      {
        id: "credential-existing",
        keyFingerprint: fingerprint,
        status: "connected",
      },
    ]);

    const second = await POST(request({ token: "sk-ant-oat-same" }), context());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ providerCredentialId: "credential-existing" });
    expect(mocks.storeCredential).not.toHaveBeenCalled();
    expect(mocks.insertValues).not.toHaveBeenCalled();
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it("rotates an existing setup-token row instead of inserting a second row", async () => {
    mocks.selectLimit.mockResolvedValueOnce([
      {
        id: "credential-existing",
        keyFingerprint: "old-fingerprint",
        status: "connected",
      },
    ]);

    const response = await POST(
      request({ token: "sk-ant-oat-rotated", label: "rotated" }),
      context(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ providerCredentialId: "credential-existing" });
    expect(mocks.insertValues).not.toHaveBeenCalled();
    expect(mocks.storeCredential).toHaveBeenCalledWith(
      auth.userId,
      "anthropic",
      JSON.stringify({ type: "oauth_token", modelProvider: "anthropic", token: "sk-ant-oat-rotated" }),
    );
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "rotated",
        keyFingerprint: expect.any(String),
        displayName: "rotated",
        status: "connected",
      }),
    );
  });

  it("rejects provider validation failures before storing anything", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad token", { status: 401 })));

    const response = await POST(request({ token: "bad-token" }), context());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "setup_token_invalid" });
    expect(mocks.storeCredential).not.toHaveBeenCalled();
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });
});
