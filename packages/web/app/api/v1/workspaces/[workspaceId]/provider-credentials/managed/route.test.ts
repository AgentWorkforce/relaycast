import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  requireSessionAuth: vi.fn(),
  requireAuthScope: vi.fn(),
  hasWorkspaceAccess: vi.fn(),
  resolveHouseKey: vi.fn(),
  insertReturning: vi.fn(),
  onConflictDoNothing: vi.fn(),
  selectLimit: vi.fn(),
  insertValues: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
  requireSessionAuth: mocks.requireSessionAuth,
  requireAuthScope: mocks.requireAuthScope,
}));

vi.mock("@/lib/integrations/integration-route-handler", () => ({
  hasWorkspaceAccess: mocks.hasWorkspaceAccess,
}));

vi.mock("@/lib/billing/house-keys", () => ({
  normalizeModelProvider: (value: string) => value.trim().toLowerCase(),
  harnessForModelProvider: (value: string) => (value === "anthropic" ? "claude" : "codex"),
  displayNameForModelProvider: (value: string) => value[0].toUpperCase() + value.slice(1),
  resolveHouseKey: mocks.resolveHouseKey,
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: mocks.selectLimit,
        }),
      }),
    }),
    insert: () => ({ values: mocks.insertValues }),
  }),
}));

import { GET, POST } from "./route";

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

describe("provider credentials managed route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue(auth);
    mocks.requireSessionAuth.mockReturnValue(false);
    mocks.requireAuthScope.mockImplementation((resolvedAuth, scope) => resolvedAuth.scopes?.includes(scope));
    mocks.hasWorkspaceAccess.mockReturnValue(true);
    mocks.resolveHouseKey.mockReturnValue("house-key");
    mocks.insertReturning.mockResolvedValue([{ id: "credential-created" }]);
    mocks.onConflictDoNothing.mockReturnValue({ returning: mocks.insertReturning });
    mocks.insertValues.mockReturnValue({ onConflictDoNothing: mocks.onConflictDoNothing });
    mocks.selectLimit.mockResolvedValue([]);
  });

  it("creates a relay-managed credential when a house key exists", async () => {
    const response = await POST(
      new NextRequest(`https://cloud.test/api/v1/workspaces/${workspaceId}/provider-credentials/managed`, {
        method: "POST",
        body: JSON.stringify({ provider: "anthropic" }),
      }),
      context(),
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.providerCredentialId).toBe("credential-created");
    expect(mocks.insertValues).toHaveBeenCalledWith(expect.objectContaining({
      authType: "relay_managed",
      credentialStoredAt: null,
      displayName: "Anthropic managed",
      harness: "claude",
      modelProvider: "anthropic",
      status: "connected",
      lastAuthenticatedAt: expect.any(Date),
    }));
    expect(mocks.onConflictDoNothing).toHaveBeenCalledTimes(1);
    expect(mocks.insertReturning).toHaveBeenCalledTimes(1);
  });

  it("reselects and returns an existing managed credential after an insert conflict", async () => {
    mocks.insertReturning.mockResolvedValueOnce([]);
    mocks.selectLimit.mockResolvedValueOnce([{ id: "credential-existing" }]);

    const response = await GET(
      new NextRequest(
        `https://cloud.test/api/v1/workspaces/${workspaceId}/provider-credentials/managed?provider=anthropic`,
      ),
      context(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      providerCredentialId: "credential-existing",
    });
    expect(mocks.insertReturning).toHaveBeenCalledTimes(1);
    expect(mocks.selectLimit).toHaveBeenCalledTimes(1);
  });

  it("rejects unauthenticated and inaccessible requests", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce(null);
    const unauthenticated = await GET(
      new NextRequest(
        `https://cloud.test/api/v1/workspaces/${workspaceId}/provider-credentials/managed?provider=anthropic`,
      ),
      context(),
    );
    expect(unauthenticated.status).toBe(401);

    mocks.hasWorkspaceAccess.mockReturnValueOnce(false);
    const forbidden = await GET(
      new NextRequest(
        `https://cloud.test/api/v1/workspaces/${workspaceId}/provider-credentials/managed?provider=anthropic`,
      ),
      context(),
    );
    expect(forbidden.status).toBe(403);
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it("returns 503 when the provider house key is missing", async () => {
    mocks.resolveHouseKey.mockReturnValueOnce(undefined);

    const response = await GET(
      new NextRequest(
        `https://cloud.test/api/v1/workspaces/${workspaceId}/provider-credentials/managed?provider=openai`,
      ),
      context(),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "house_key_missing" });
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it("returns structured JSON when credential creation fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.insertReturning.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await POST(
      new NextRequest(`https://cloud.test/api/v1/workspaces/${workspaceId}/provider-credentials/managed`, {
        method: "POST",
        body: JSON.stringify({ provider: "openai" }),
      }),
      context(),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: "Failed to create managed provider credential",
      code: "managed_credential_create_failed",
    });
    expect(errorSpy).toHaveBeenCalledWith(
      "[provider-credentials/managed] Failed to create managed provider credential",
      expect.objectContaining({
        modelProvider: "openai",
        workspaceId,
        errorMessage: "database unavailable",
      }),
    );
    errorSpy.mockRestore();
  });
});
