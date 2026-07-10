import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  getAuthUserProfile: vi.fn(),
  resolveRequestAuth: vi.fn(),
}));

vi.mock("@/lib/auth/auth-api", () => ({
  getAuthContext: mocks.getAuthContext,
  getAuthUserProfile: mocks.getAuthUserProfile,
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
}));

describe("GET /api/v1/auth/whoami", () => {
  it("returns the authenticated user and current workspace", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      userId: "user-1",
      workspaceId: "workspace-1",
      organizationId: "org-1",
      source: "token",
      scopes: ["cli:auth"],
      subjectType: "cli",
    });
    mocks.getAuthContext.mockResolvedValueOnce({
      user: {
        id: "user-1",
        email: "khaliq@example.com",
        name: "Khaliq Gant",
        avatarUrl: "https://lh3.googleusercontent.com/a/example",
      },
      currentOrganization: { id: "org-1", slug: "personal", name: "Personal", role: "owner", status: "active" },
      currentWorkspace: { id: "workspace-1", organization_id: "org-1", slug: "personal", name: "Personal" },
    });
    const { GET } = await import("./route");

    const response = await GET(new Request("http://localhost/api/v1/auth/whoami") as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      authenticated: true,
      source: "token",
      subjectType: "cli",
      scopes: ["cli:auth"],
      user: {
        email: "khaliq@example.com",
        name: "Khaliq Gant",
        avatarUrl: "https://lh3.googleusercontent.com/a/example",
      },
      currentWorkspace: { id: "workspace-1" },
    });
  });

  it("returns the authenticated user profile when no active workspace exists", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      userId: "user-1",
      workspaceId: "workspace-1",
      organizationId: "org-1",
      source: "token",
      scopes: ["cli:auth"],
      subjectType: "cli",
    });
    mocks.getAuthContext.mockRejectedValueOnce(new Error("No active workspace"));
    mocks.getAuthUserProfile.mockResolvedValueOnce({
      id: "user-1",
      email: "khaliq@example.com",
      name: "Khaliq Gant",
      avatarUrl: "https://lh3.googleusercontent.com/a/example",
    });
    const { GET } = await import("./route");

    const response = await GET(new Request("http://localhost/api/v1/auth/whoami") as never);

    expect(response.status).toBe(200);
    expect(mocks.resolveRequestAuth).toHaveBeenCalledWith(expect.any(Request), {
      allowMissingWorkspace: true,
    });
    await expect(response.json()).resolves.toEqual({
      authenticated: true,
      source: "token",
      subjectType: "cli",
      scopes: ["cli:auth"],
      user: {
        id: "user-1",
        email: "khaliq@example.com",
        name: "Khaliq Gant",
        avatarUrl: "https://lh3.googleusercontent.com/a/example",
      },
      currentOrganization: null,
      currentWorkspace: null,
      workspaceRequired: true,
    });
  });

  it("returns unauthorized when no auth is present", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce(null);
    const { GET } = await import("./route");

    const response = await GET(new Request("http://localhost/api/v1/auth/whoami") as never);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });
});
