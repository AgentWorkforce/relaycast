import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LOGIN_INVITE_COOKIE_NAME } from "@/lib/auth/login-invite";

vi.mock("sst", () => ({
  Resource: {
    GoogleClientId: { value: "google-client" },
  },
}));

vi.mock("@/lib/app-origin", () => ({
  getConfiguredAppOrigin: () => "https://agentrelay.test",
}));

import { GET } from "./route";

function request(path: string): NextRequest {
  return new NextRequest(`https://agentrelay.test${path}`);
}

describe("GET /api/auth/google/start", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("stores a valid login invite token for the Google callback", async () => {
    const response = await GET(
      request("/cloud/api/auth/google/start?next=/dashboard&invite_token=relay-2026"),
    );

    expect(response.status).toBe(307);
    const cookie = response.cookies.get(LOGIN_INVITE_COOKIE_NAME);
    expect(cookie?.value).toBe("RELAY-2026");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.maxAge).toBe(60 * 10);
  });

  it("clears stale login invite cookies when the token is invalid", async () => {
    const response = await GET(
      request("/cloud/api/auth/google/start?next=/dashboard&invite_token=wrong"),
    );

    expect(response.status).toBe(307);
    const cookie = response.cookies.get(LOGIN_INVITE_COOKIE_NAME);
    expect(cookie?.value).toBe("");
    expect(cookie?.expires instanceof Date ? cookie.expires.getTime() : cookie?.expires).toBe(0);
  });
});
