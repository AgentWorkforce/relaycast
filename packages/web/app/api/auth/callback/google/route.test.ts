import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LOGIN_INVITE_COOKIE_NAME } from "@/lib/auth/login-invite";

const mocks = vi.hoisted(() => ({
  acceptPendingInvitesForEmail: vi.fn(),
  addToWaitlist: vi.fn(),
  exchangeGoogleCode: vi.fn(),
  fetchGoogleUserInfo: vi.fn(),
  getAuthContext: vi.fn(),
  getAuthSessionSecret: vi.fn(),
  loginWithGoogleIdentity: vi.fn(),
  setSessionCookie: vi.fn(),
  setWaitlistEmailCookie: vi.fn(),
}));

vi.mock("sst", () => ({
  Resource: {
    GoogleClientId: { value: "google-client" },
    GoogleClientSecret: { value: "google-secret" },
  },
}));

vi.mock("@/lib/app-origin", () => ({
  getConfiguredAppOrigin: () => "https://agentrelay.test",
}));

vi.mock("@/lib/auth/auth-api", () => ({
  getAuthContext: mocks.getAuthContext,
  loginWithGoogleIdentity: mocks.loginWithGoogleIdentity,
}));

vi.mock("@/lib/auth/google", () => ({
  exchangeGoogleCode: mocks.exchangeGoogleCode,
  fetchGoogleUserInfo: mocks.fetchGoogleUserInfo,
}));

vi.mock("@/lib/auth/secrets", () => ({
  getAuthSessionSecret: mocks.getAuthSessionSecret,
}));

vi.mock("@/lib/auth/session", () => ({
  createSessionClaims: vi.fn((claims) => claims),
  setSessionCookie: mocks.setSessionCookie,
}));

vi.mock("@/lib/invites/invite-store", () => ({
  acceptPendingInvitesForEmail: mocks.acceptPendingInvitesForEmail,
}));

vi.mock("@/lib/waitlist/store", () => ({
  addToWaitlist: mocks.addToWaitlist,
  setWaitlistEmailCookie: mocks.setWaitlistEmailCookie,
}));

import { GET } from "./route";

function callbackRequest(extraCookie = ""): NextRequest {
  const cookies = [
    "agent_relay_google_state=state-123",
    "agent_relay_post_auth_next=%2Fdashboard",
    extraCookie,
  ].filter(Boolean);

  return new NextRequest(
    "https://agentrelay.test/cloud/api/auth/callback/google?code=code-123&state=state-123",
    { headers: { cookie: cookies.join("; ") } },
  );
}

describe("GET /api/auth/callback/google", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.exchangeGoogleCode.mockResolvedValue("google-access-token");
    mocks.fetchGoogleUserInfo.mockResolvedValue({
      email: "external@example.com",
      email_verified: true,
      name: "External User",
      picture: null,
      sub: "google-sub",
    });
    mocks.loginWithGoogleIdentity.mockResolvedValue("user-123");
    mocks.getAuthContext.mockResolvedValue({
      user: { id: "user-123" },
      currentOrganization: { id: "org-123" },
      currentWorkspace: { id: "workspace-123" },
    });
    mocks.getAuthSessionSecret.mockReturnValue("session-secret");
    mocks.setSessionCookie.mockImplementation((response) => {
      response.cookies.set("agent_relay_session", "session-token");
    });
  });

  it("keeps external emails on the waitlist without a login invite token", async () => {
    const response = await GET(callbackRequest());

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://agentrelay.test/cloud/waitlist");
    expect(mocks.addToWaitlist).toHaveBeenCalledWith("external@example.com", "google-oauth");
    expect(mocks.loginWithGoogleIdentity).not.toHaveBeenCalled();
    expect(mocks.setSessionCookie).not.toHaveBeenCalled();
  });

  it("allows external emails to login with the configured invite token", async () => {
    const response = await GET(callbackRequest(`${LOGIN_INVITE_COOKIE_NAME}=RELAY-2026`));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://agentrelay.test/cloud/dashboard");
    expect(mocks.addToWaitlist).not.toHaveBeenCalled();
    expect(mocks.loginWithGoogleIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ email: "external@example.com" }),
    );
    expect(mocks.acceptPendingInvitesForEmail).toHaveBeenCalledWith("external@example.com", "user-123");
    expect(response.cookies.get("agent_relay_session")?.value).toBe("session-token");
    expect(response.cookies.get(LOGIN_INVITE_COOKIE_NAME)?.value).toBe("");
  });
});
