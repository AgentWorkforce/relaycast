import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createApiTokenSession: vi.fn(),
  resolveRequestAuth: vi.fn(),
  requireSessionAuth: vi.fn(),
  getConfiguredAppOrigin: vi.fn(() => "https://cloud.test"),
}));

vi.mock("@/lib/auth/api-token-store", () => ({
  createApiTokenSession: mocks.createApiTokenSession,
  OPERATOR_API_ACCESS_TOKEN_TTL_SECONDS: 60 * 60 * 24,
  OPERATOR_API_REFRESH_TOKEN_TTL_SECONDS: 60 * 60 * 24 * 90,
}));

vi.mock("@/lib/auth/request-auth", () => ({
  FOLLOW_USER_WORKSPACE_SCOPE: "auth:workspace:follow-user",
  resolveRequestAuth: mocks.resolveRequestAuth,
  requireSessionAuth: mocks.requireSessionAuth,
}));

vi.mock("@/lib/app-origin", () => ({
  getConfiguredAppOrigin: mocks.getConfiguredAppOrigin,
}));

describe("GET /api/v1/cli/login", () => {
  it("includes refresh token expiry and configured api_url in the callback redirect", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      userId: "user-1",
      workspaceId: "workspace-1",
      organizationId: "org-1",
      source: "session",
    });
    mocks.requireSessionAuth.mockReturnValueOnce(true);
    mocks.createApiTokenSession.mockResolvedValueOnce({
      accessToken: "access-token",
      accessTokenExpiresAt: "2026-05-03T10:00:00.000Z",
      refreshToken: "refresh-token",
      refreshTokenExpiresAt: "2026-05-10T10:00:00.000Z",
    });
    const { GET } = await import("./route");

    const response = await GET(
      new Request(
        "http://localhost/api/v1/cli/login?redirect_uri=http://127.0.0.1:44123/callback&state=test-state",
      ) as never,
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toBeTruthy();
    const callbackUrl = new URL(String(location));
    expect(callbackUrl.origin).toBe("http://127.0.0.1:44123");
    expect(callbackUrl.searchParams.get("access_token")).toBe("access-token");
    expect(callbackUrl.searchParams.get("refresh_token")).toBe("refresh-token");
    expect(callbackUrl.searchParams.get("access_token_expires_at")).toBe("2026-05-03T10:00:00.000Z");
    expect(callbackUrl.searchParams.get("refresh_token_expires_at")).toBe("2026-05-10T10:00:00.000Z");
    expect(callbackUrl.searchParams.get("api_url")).toBe("https://cloud.test/cloud");
    expect(mocks.resolveRequestAuth).toHaveBeenCalledWith(expect.any(Request), {
      allowMissingWorkspace: true,
    });
    expect(mocks.createApiTokenSession).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "cli",
        userId: "user-1",
        workspaceId: "workspace-1",
        organizationId: "org-1",
        scopes: ["cli:auth", "auth:workspace:follow-user"],
        accessTokenTtlSeconds: 60 * 60 * 24,
        refreshTokenTtlSeconds: 60 * 60 * 24 * 90,
      }),
    );
  });

  it("does not echo the origin-bypass host in the returned api_url", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      userId: "user-1",
      workspaceId: "workspace-1",
      organizationId: "org-1",
      source: "session",
    });
    mocks.requireSessionAuth.mockReturnValueOnce(true);
    mocks.createApiTokenSession.mockResolvedValueOnce({
      accessToken: "access-token",
      accessTokenExpiresAt: "2026-05-03T10:00:00.000Z",
      refreshToken: "refresh-token",
      refreshTokenExpiresAt: "2026-05-10T10:00:00.000Z",
    });
    const { GET } = await import("./route");

    const response = await GET(
      new Request(
        "https://origin.agentrelay.com/cloud/api/v1/cli/login?redirect_uri=http://127.0.0.1:44123/callback&state=test-state",
      ) as never,
    );

    expect(response.status).toBe(307);
    const callbackUrl = new URL(String(response.headers.get("location")));
    expect(callbackUrl.searchParams.get("api_url")).toBe("https://cloud.test/cloud");
  });

  it("mints a follow-user token from a session even when workspace context is missing", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      userId: "user-1",
      workspaceId: "00000000-0000-4000-8000-000000000099",
      organizationId: "org-1",
      source: "session",
    });
    mocks.requireSessionAuth.mockReturnValueOnce(true);
    mocks.createApiTokenSession.mockResolvedValueOnce({
      accessToken: "access-token",
      accessTokenExpiresAt: "2026-05-03T10:00:00.000Z",
      refreshToken: "refresh-token",
      refreshTokenExpiresAt: "2026-05-10T10:00:00.000Z",
    });
    const { GET } = await import("./route");

    const response = await GET(
      new Request(
        "http://localhost/api/v1/cli/login?redirect_uri=http://127.0.0.1:44123/callback&state=test-state",
        { headers: { "x-forwarded-for": "198.51.100.77" } },
      ) as never,
    );

    expect(response.status).toBe(307);
    expect(mocks.createApiTokenSession).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "cli",
        userId: "user-1",
        workspaceId: "00000000-0000-4000-8000-000000000099",
        organizationId: "org-1",
        scopes: ["cli:auth", "auth:workspace:follow-user"],
      }),
    );
  });

  it("rate limits repeated login attempts from the same IP", async () => {
    const { GET } = await import("./route");
    let response: Response | undefined;

    for (let i = 0; i < 31; i += 1) {
      response = await GET(
        new Request(
          "http://localhost/api/v1/cli/login?redirect_uri=http://127.0.0.1:44123/callback&state=test-state",
          { headers: { "x-forwarded-for": "203.0.113.42" } },
        ) as never,
      );
    }

    expect(response?.status).toBe(429);
    expect(response?.headers.get("Retry-After")).toBeTruthy();
  });
});
