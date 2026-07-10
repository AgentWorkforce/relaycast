// @route GET /api/v1/invites
// @route POST /api/v1/invites
// @route DELETE /api/v1/invites/[inviteId]
// @route GET /api/v1/invites/resolve
// @route POST /api/v1/invites/accept

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  findSetCookie,
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

const pendingInviteSchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  role: z.string().min(1),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  invitedByName: z.string().nullable(),
});

const inviteListSchema = z.object({
  invites: z.array(pendingInviteSchema),
});

const inviteCreateSchema = z.object({
  invite: z.object({
    id: z.string().min(1),
    email: z.string().email(),
    role: z.string().min(1),
    expiresAt: z.string().datetime(),
    createdAt: z.string().datetime(),
  }),
});

const inviteResolveSchema = z.object({
  invite: z.object({
    id: z.string().min(1),
    organizationName: z.string().min(1),
    email: z.string().email(),
    role: z.string().min(1),
    invitedByName: z.string().nullable(),
    expiresAt: z.string().datetime(),
    acceptedAt: z.string().datetime().nullable(),
    canceledAt: z.string().datetime().nullable(),
  }),
});

const acceptedInviteSchema = z.object({
  ok: z.literal(true),
  authenticated: z.literal(true),
  user: z.object({
    id: z.string().min(1),
  }).passthrough(),
  currentOrganization: z.object({
    id: z.string().min(1),
  }).passthrough(),
  currentWorkspace: z.object({
    id: z.string().min(1),
  }).passthrough(),
}).passthrough();

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function hasSessionAuth(): boolean {
  return Boolean(acceptanceEnv().sessionCookie);
}

function expectSessionCookieShape(cookie: string | undefined): void {
  expect(cookie).toBeTruthy();
  expect(cookie).toContain("agent_relay_session=");
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("Path=/");
  expect(cookie).toContain("SameSite=Lax");
}

const sessionIdentitySchema = z.object({
  authenticated: z.literal(true),
  user: z.object({
    email: z.string().email().nullable(),
  }),
});

async function loadCurrentUserEmail(): Promise<string> {
  const response = await signedRequest("GET", "/api/auth/session", {
    auth: "session",
  });

  expect(response.status).toBe(200);
  const parsed = sessionIdentitySchema.parse(await response.json());
  expect(parsed.user.email).toBeTruthy();
  return parsed.user.email!;
}

describe("/api/v1/invites", () => {
  it("GET /api/v1/invites rejects unauthenticated callers", async () => {
    const response = await request("GET", "/api/v1/invites");

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    expect(errorSchema.parse(await response.json()).error).toBe("Unauthorized");
  });

  (hasSessionAuth() ? it : it.skip)(
    "GET /api/v1/invites returns the pending invite list for owner sessions",
    async () => {
      const response = await signedRequest("GET", "/api/v1/invites", {
        auth: "session",
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      inviteListSchema.parse(await response.json());
    },
  );

  it("POST /api/v1/invites rejects unauthenticated callers", async () => {
    const response = await request("POST", "/api/v1/invites", {
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ email: "acceptance@example.com" }),
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
    "POST /api/v1/invites rejects malformed JSON bodies",
    async () => {
      const response = await signedRequest("POST", "/api/v1/invites", {
        auth: "session",
        headers: {
          "content-type": "application/json",
        },
        body: "{",
      });

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      expect(errorSchema.parse(await response.json()).error).toBe("Invalid request body");
    },
  );

  (hasSessionAuth() ? it : it.skip)(
    "POST /api/v1/invites rejects invalid email addresses",
    async () => {
      const response = await signedRequest("POST", "/api/v1/invites", {
        auth: "session",
        json: { email: "not-an-email" },
      });

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      expect(errorSchema.parse(await response.json()).error).toBe("Valid email is required");
    },
  );

  (hasSessionAuth() ? it : it.skip)(
    "POST /api/v1/invites rejects unsupported roles",
    async () => {
      const response = await signedRequest("POST", "/api/v1/invites", {
        auth: "session",
        json: { email: "acceptance@example.com", role: "admin" },
      });

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      expect(errorSchema.parse(await response.json()).error).toBe("Role must be 'member' or 'owner'");
    },
  );

  (hasSessionAuth() ? it : it.skip)(
    "POST /api/v1/invites rejects existing members of the organization",
    async () => {
      const email = await loadCurrentUserEmail();
      const response = await signedRequest("POST", "/api/v1/invites", {
        auth: "session",
        json: { email, role: "member" },
      });

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      expect(errorSchema.parse(await response.json()).error).toBe(
        "User is already a member of this organization",
      );
    },
  );

  (hasSessionAuth() ? it : it.skip)(
    "POST /api/v1/invites creates an invite for owner sessions",
    async () => {
      const email = `acceptance+${randomUUID().slice(0, 8)}@example.com`;
      const response = await signedRequest("POST", "/api/v1/invites", {
        auth: "session",
        json: { email, role: "member" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      const parsed = inviteCreateSchema.parse(await response.json());
      expect(parsed.invite.email).toBe(email);
    },
  );
});

describe("/api/v1/invites/[inviteId]", () => {
  it("DELETE /api/v1/invites/[inviteId] rejects unauthenticated callers", async () => {
    const response = await request("DELETE", `/api/v1/invites/${randomUUID()}`);

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    expect(errorSchema.parse(await response.json()).error).toBe("Unauthorized");
  });

  (hasSessionAuth() ? it : it.skip)(
    "DELETE /api/v1/invites/[inviteId] returns Invite not found for unknown ids",
    async () => {
      const response = await signedRequest("DELETE", `/api/v1/invites/${randomUUID()}`, {
        auth: "session",
      });

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      expect(errorSchema.parse(await response.json()).error).toBe("Invite not found");
    },
  );

  (hasSessionAuth() ? it : it.skip)(
    "DELETE /api/v1/invites/[inviteId] cancels a freshly created invite",
    async () => {
      const email = `acceptance+${randomUUID().slice(0, 8)}@example.com`;
      const createResponse = await signedRequest("POST", "/api/v1/invites", {
        auth: "session",
        json: { email, role: "member" },
      });

      expect(createResponse.status).toBe(200);
      const created = inviteCreateSchema.parse(await createResponse.json());
      const deleteResponse = await signedRequest(
        "DELETE",
        `/api/v1/invites/${created.invite.id}`,
        {
          auth: "session",
        },
      );

      expect(deleteResponse.status).toBe(200);
      expect(deleteResponse.headers.get("content-type") ?? "").toContain("application/json");
      expect(await deleteResponse.json()).toEqual({ ok: true });
    },
  );
});

describe("/api/v1/invites/resolve", () => {
  it("GET /api/v1/invites/resolve rejects missing invite tokens", async () => {
    const response = await request("GET", "/api/v1/invites/resolve");

    expect([400, 429]).toContain(response.status);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    const payload = await response.json();
    if (response.status === 400) {
      expect(errorSchema.parse(payload).error).toBe("Token is required");
      return;
    }
    expect(rateLimitSchema.parse(payload).message).toBeTruthy();
  });

  it("GET /api/v1/invites/resolve returns not found for unknown invite tokens", async () => {
    const response = await request(
      "GET",
      `/api/v1/invites/resolve?token=${encodeURIComponent(`missing-${randomUUID()}`)}`,
    );

    expect([404, 429]).toContain(response.status);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    const payload = await response.json();
    if (response.status === 404) {
      expect(errorSchema.parse(payload).error).toBe("Invite not found");
      return;
    }
    expect(rateLimitSchema.parse(payload).message).toBeTruthy();
  });

  const inviteResolveToken = env("ACCEPTANCE_INVITE_TOKEN");
  (inviteResolveToken ? it : it.skip)(
    "GET /api/v1/invites/resolve returns invite metadata for a configured live token",
    async () => {
      const response = await request(
        "GET",
        `/api/v1/invites/resolve?token=${encodeURIComponent(inviteResolveToken!)}`,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      inviteResolveSchema.parse(await response.json());
    },
  );
});

describe("/api/v1/invites/accept", () => {
  it("POST /api/v1/invites/accept rejects unauthenticated callers", async () => {
    const response = await request("POST", "/api/v1/invites/accept", {
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ token: `missing-${randomUUID()}` }),
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
    "POST /api/v1/invites/accept rejects malformed JSON bodies",
    async () => {
      const response = await signedRequest("POST", "/api/v1/invites/accept", {
        auth: "session",
        headers: {
          "content-type": "application/json",
        },
        body: "{",
      });

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      expect(errorSchema.parse(await response.json()).error).toBe("Invalid request body");
    },
  );

  (hasSessionAuth() ? it : it.skip)(
    "POST /api/v1/invites/accept rejects missing invite tokens",
    async () => {
      const response = await signedRequest("POST", "/api/v1/invites/accept", {
        auth: "session",
        json: {},
      });

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      expect(errorSchema.parse(await response.json()).error).toBe("Token is required");
    },
  );

  (hasSessionAuth() ? it : it.skip)(
    "POST /api/v1/invites/accept rejects unknown invite tokens",
    async () => {
      const response = await signedRequest("POST", "/api/v1/invites/accept", {
        auth: "session",
        json: { token: `missing-${randomUUID()}` },
      });

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      expect(errorSchema.parse(await response.json()).error).toBe("Invite not found");
    },
  );

  const inviteAcceptToken = env("ACCEPTANCE_INVITE_TOKEN");
  (hasSessionAuth() && inviteAcceptToken ? it : it.skip)(
    "POST /api/v1/invites/accept accepts a configured live invite token",
    async () => {
      const response = await signedRequest("POST", "/api/v1/invites/accept", {
        auth: "session",
        json: { token: inviteAcceptToken },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      acceptedInviteSchema.parse(await response.json());
      expectSessionCookieShape(findSetCookie(response, "agent_relay_session"));
    },
  );

  const acceptedInviteToken = env("ACCEPTANCE_ACCEPTED_INVITE_TOKEN");
  (hasSessionAuth() && acceptedInviteToken ? it : it.skip)(
    "TODO: validate POST /api/v1/invites/accept already-accepted invite failures from seeded state",
    async () => {
      const response = await signedRequest("POST", "/api/v1/invites/accept", {
        auth: "session",
        json: { token: acceptedInviteToken },
      });

      expect(response.status).toBe(400);
      expect(errorSchema.parse(await response.json()).error).toBe("Invite has already been accepted");
    },
  );

  const canceledInviteToken = env("ACCEPTANCE_CANCELED_INVITE_TOKEN");
  (hasSessionAuth() && canceledInviteToken ? it : it.skip)(
    "TODO: validate POST /api/v1/invites/accept canceled invite failures from seeded state",
    async () => {
      const response = await signedRequest("POST", "/api/v1/invites/accept", {
        auth: "session",
        json: { token: canceledInviteToken },
      });

      expect(response.status).toBe(400);
      expect(errorSchema.parse(await response.json()).error).toBe("Invite has been canceled");
    },
  );

  const expiredInviteToken = env("ACCEPTANCE_EXPIRED_INVITE_TOKEN");
  (hasSessionAuth() && expiredInviteToken ? it : it.skip)(
    "TODO: validate POST /api/v1/invites/accept expired invite failures from seeded state",
    async () => {
      const response = await signedRequest("POST", "/api/v1/invites/accept", {
        auth: "session",
        json: { token: expiredInviteToken },
      });

      expect(response.status).toBe(400);
      expect(errorSchema.parse(await response.json()).error).toBe("Invite has expired");
    },
  );

  const wrongEmailInviteToken = env("ACCEPTANCE_WRONG_EMAIL_INVITE_TOKEN");
  (hasSessionAuth() && wrongEmailInviteToken ? it : it.skip)(
    "TODO: validate POST /api/v1/invites/accept wrong-email failures from seeded state",
    async () => {
      const response = await signedRequest("POST", "/api/v1/invites/accept", {
        auth: "session",
        json: { token: wrongEmailInviteToken },
      });

      expect(response.status).toBe(400);
      expect(errorSchema.parse(await response.json()).error).toBe(
        "This invite was sent to a different email address",
      );
    },
  );
});
