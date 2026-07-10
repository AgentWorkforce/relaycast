// @route GET /api/auth/session
// @route GET /api/auth/google/start
// @route GET /api/auth/dev-login
// @route POST /api/auth/logout
// @route POST /api/auth/workspace

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  findSetCookie,
  provisionTestWorkspace,
  signedRequest,
} from "../../helpers/auth";
import { acceptanceEnv } from "../../helpers/env";
import { request } from "../../helpers/server";

const errorSchema = z.object({
  error: z.string().min(1),
});

const rateLimitSchema = z.object({
  Reason: z.string().min(1),
  Type: z.string().min(1),
  message: z.string().min(1),
});

const authOrganizationSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  role: z.string().min(1),
  status: z.string().min(1),
});

const authWorkspaceSchema = z.object({
  id: z.string().min(1),
  organization_id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
});

const authenticatedSessionSchema = z.object({
  authenticated: z.literal(true),
  user: z.object({
    id: z.string().min(1),
    email: z.string().email().nullable(),
    name: z.string().nullable(),
    avatarUrl: z.string().url().nullable(),
  }),
  organizations: z.array(authOrganizationSchema).min(1),
  currentOrganization: authOrganizationSchema,
  workspaces: z.array(authWorkspaceSchema).min(1),
  currentWorkspace: authWorkspaceSchema,
});

const unauthenticatedSessionSchema = z.object({
  authenticated: z.literal(false),
});

const logoutSchema = z.object({
  ok: z.literal(true),
});

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function hasSessionAuth(): boolean {
  return Boolean(acceptanceEnv().sessionCookie);
}

function expectCookieShape(cookie: string | undefined, name: string): void {
  expect(cookie).toBeTruthy();
  const normalized = cookie!.toLowerCase();
  expect(normalized).toContain(`${name.toLowerCase()}=`);
  expect(normalized).toContain("httponly");
  expect(normalized).toContain("path=/");
  expect(normalized).toContain("samesite=lax");
}

function expectClearedCookieShape(cookie: string | undefined, name: string): void {
  expectCookieShape(cookie, name);
  expect(cookie!.toLowerCase()).toContain("expires=thu, 01 jan 1970");
}

describe("/api/auth/session", () => {
  it("GET /api/auth/session returns an unauthenticated payload without a session cookie", async () => {
    const response = await request("GET", "/api/auth/session");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    unauthenticatedSessionSchema.parse(await response.json());
  });

  (hasSessionAuth() ? it : it.skip)(
    "GET /api/auth/session returns the authenticated session context",
    async () => {
      const response = await signedRequest("GET", "/api/auth/session", {
        auth: "session",
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");

      const parsed = authenticatedSessionSchema.parse(await response.json());
      expect(parsed.organizations.some((organization) => organization.id === parsed.currentOrganization.id)).toBe(true);
      expect(parsed.workspaces.some((workspace) => workspace.id === parsed.currentWorkspace.id)).toBe(true);
      expectCookieShape(findSetCookie(response, "agent_relay_session"), "agent_relay_session");
    },
  );

  const staleSessionCookie = env("ACCEPTANCE_STALE_SESSION_COOKIE");
  (staleSessionCookie ? it : it.skip)(
    "GET /api/auth/session clears a stale-but-decodable session cookie",
    async () => {
      const response = await request("GET", "/api/auth/session", {
        headers: {
          cookie: staleSessionCookie!,
        },
      });

      expect(response.status).toBe(401);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");

      unauthenticatedSessionSchema.parse(await response.json());
      expectClearedCookieShape(findSetCookie(response, "agent_relay_session"), "agent_relay_session");
    },
  );
});

describe("/api/auth/google/start", () => {
  it("GET /api/auth/google/start redirects to Google and seeds the state cookies", async () => {
    const response = await request("GET", "/api/auth/google/start?next=/dashboard", {
      redirect: "manual",
    });

    expect(response.status).toBe(307);

    const location = response.headers.get("location");
    expect(location).toBeTruthy();

    const redirectUrl = new URL(String(location));
    expect(redirectUrl.origin).toBe("https://accounts.google.com");
    expect(redirectUrl.pathname).toBe("/o/oauth2/v2/auth");
    expect(redirectUrl.searchParams.get("response_type")).toBe("code");
    expect(redirectUrl.searchParams.get("state")).toBeTruthy();

    expectCookieShape(findSetCookie(response, "agent_relay_google_state"), "agent_relay_google_state");
    expectCookieShape(findSetCookie(response, "agent_relay_post_auth_next"), "agent_relay_post_auth_next");
  });

  const unconfiguredGoogleBaseUrl = env("ACCEPTANCE_UNCONFIGURED_GOOGLE_BASE_URL");
  (unconfiguredGoogleBaseUrl ? it : it.skip)(
    "GET /api/auth/google/start returns a configuration error when Google auth is disabled",
    async () => {
      const response = await fetch(`${unconfiguredGoogleBaseUrl}/api/auth/google/start?next=/dashboard`, {
        redirect: "manual",
        headers: {
          accept: "application/json",
        },
      });

      expect(response.status).toBe(500);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      errorSchema.parse(await response.json());
    },
  );
});

describe("/api/auth/dev-login", () => {
  it("GET /api/auth/dev-login returns Not available outside development", async () => {
    const response = await request("GET", "/api/auth/dev-login", {
      redirect: "manual",
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    expect(errorSchema.parse(await response.json()).error).toBe("Not available");
  });

  const devLoginBaseUrl = env("ACCEPTANCE_DEV_LOGIN_BASE_URL");
  (devLoginBaseUrl ? it : it.skip)(
    "TODO: validate GET /api/auth/dev-login happy path against a development deployment",
    async () => {
      const response = await fetch(`${devLoginBaseUrl}/api/auth/dev-login`, {
        redirect: "manual",
        headers: {
          accept: "application/json",
        },
      });

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toContain("/dashboard");
      expectCookieShape(findSetCookie(response, "agent_relay_session"), "agent_relay_session");
    },
  );
});

describe("/api/auth/logout", () => {
  it("POST /api/auth/logout clears the session cookie and returns ok", async () => {
    const response = await request("POST", "/api/auth/logout");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");

    logoutSchema.parse(await response.json());
    expectClearedCookieShape(findSetCookie(response, "agent_relay_session"), "agent_relay_session");
  });
});

describe("/api/auth/workspace", () => {
  it("POST /api/auth/workspace rejects unauthenticated callers", async () => {
    const response = await request("POST", "/api/auth/workspace", {
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ workspaceId: randomUUID() }),
    });

    expect([401, 429]).toContain(response.status);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    const payload = await response.json();
    if (response.status === 401) {
      expect(errorSchema.parse(payload).error).toBe("Unauthorized");
      return;
    }
    expect(rateLimitSchema.parse(payload).message).toBeTruthy();
  });

  (hasSessionAuth() ? it : it.skip)(
    "POST /api/auth/workspace rejects missing workspaceId",
    async () => {
      const response = await signedRequest("POST", "/api/auth/workspace", {
        auth: "session",
        json: {},
      });

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      expect(errorSchema.parse(await response.json()).error).toBe("Missing workspaceId");
    },
  );

  (hasSessionAuth() ? it : it.skip)(
    "POST /api/auth/workspace rejects unknown or inaccessible workspaces",
    async () => {
      const response = await signedRequest("POST", "/api/auth/workspace", {
        auth: "session",
        json: { workspaceId: `missing-${randomUUID()}` },
      });

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      errorSchema.parse(await response.json());
    },
  );

  // PR CI today doesn't have session auth wired, so this case is skipped.
  // But when an operator runs the suite authenticated AND has not provided
  // ACCEPTANCE_ALT_WORKSPACE_ID, the fallback `provisionTestWorkspace()`
  // call leaks a row because `teardownTestWorkspace()` in
  // packages/acceptance/helpers/auth.ts is a no-op (no delete endpoint
  // exists for acceptance-created workspaces yet). Require the operator
  // to supply a real alt-workspace ID instead of silently provisioning
  // one. See Codex P2 on bundle PR #647.
  (hasSessionAuth() && env("ACCEPTANCE_ALT_WORKSPACE_ID") ? it : it.skip)(
    "POST /api/auth/workspace switches the active workspace and refreshes the session",
    async () => {
      const targetWorkspaceId = env("ACCEPTANCE_ALT_WORKSPACE_ID");
      const targetWorkspace = targetWorkspaceId
        ? { id: targetWorkspaceId, created: false }
        : await provisionTestWorkspace(`acceptance-switch-${randomUUID().slice(0, 8)}`);

      const response = await signedRequest("POST", "/api/auth/workspace", {
        auth: "session",
        json: { workspaceId: targetWorkspace.id },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");

      const parsed = authenticatedSessionSchema.parse(await response.json());
      expect(parsed.authenticated).toBe(true);
      expect(parsed.currentWorkspace.id).toBe(targetWorkspace.id);
      expectCookieShape(findSetCookie(response, "agent_relay_session"), "agent_relay_session");
    },
  );
});
