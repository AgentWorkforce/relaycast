import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refreshApiTokenSession: vi.fn(),
  getConfiguredAppOrigin: vi.fn(() => "https://cloud.test"),
}));

vi.mock("@/lib/auth/api-token-store", () => ({
  refreshApiTokenSession: mocks.refreshApiTokenSession,
}));

vi.mock("@/lib/app-origin", () => ({
  getConfiguredAppOrigin: mocks.getConfiguredAppOrigin,
}));

describe("POST /api/v1/auth/token/refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a refreshed token set with apiUrl", async () => {
    mocks.refreshApiTokenSession.mockResolvedValueOnce({
      accessToken: "next-access",
      accessTokenExpiresAt: "2026-05-03T10:00:00.000Z",
      refreshToken: "next-refresh",
      refreshTokenExpiresAt: "2026-05-10T10:00:00.000Z",
    });
    const { POST } = await import("./route");

    const response = await POST(
      new Request("http://localhost/api/v1/auth/token/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: "cld_rt_old-refresh" }),
      }) as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accessToken: "next-access",
      accessTokenExpiresAt: "2026-05-03T10:00:00.000Z",
      refreshToken: "next-refresh",
      refreshTokenExpiresAt: "2026-05-10T10:00:00.000Z",
      apiUrl: "https://cloud.test/cloud",
      tokenType: "Bearer",
    });
  });

  it("returns invalid_grant for malformed refresh tokens without hitting storage", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      new Request("http://localhost/api/v1/auth/token/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: "missing-refresh" }),
      }) as never,
    );

    expect(response.status).toBe(403);
    expect(mocks.refreshApiTokenSession).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: "invalid_grant",
      message: "Invalid or expired refresh token",
    });
  });

  it("returns invalid_grant when the refresh token cannot be refreshed", async () => {
    mocks.refreshApiTokenSession.mockResolvedValueOnce(null);
    const { POST } = await import("./route");

    const response = await POST(
      new Request("http://localhost/api/v1/auth/token/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: "expired-refresh" }),
      }) as never,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_grant",
      message: "Invalid or expired refresh token",
    });
  });
});
