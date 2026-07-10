// @route POST /api/v1/auth/token/refresh
// @route POST /api/v1/auth/token/revoke
// @route GET /api/v1/auth/whoami
// @route GET /api/v1/me/integrations

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  issueCliLoginTokenSet,
  loadCliToken,
} from "../../helpers/auth";
import { acceptanceEnv } from "../../helpers/env";
import { request } from "../../helpers/server";

const errorSchema = z.object({
  error: z.string().min(1),
  message: z.string().min(1).optional(),
});

const rateLimitSchema = z.object({
  Reason: z.string().min(1),
  Type: z.string().min(1),
  message: z.string().min(1),
});

const tokenRefreshSchema = z.object({
  accessToken: z.string().min(1),
  accessTokenExpiresAt: z.string().datetime(),
  refreshToken: z.string().min(1),
  refreshTokenExpiresAt: z.string().datetime(),
  apiUrl: z.string().url(),
  tokenType: z.literal("Bearer"),
});

const revokeSchema = z.object({
  revoked: z.literal(true),
});

const whoamiSchema = z.object({
  authenticated: z.literal(true),
  source: z.enum(["session", "token", "service", "relayfile"]),
  subjectType: z.string().nullable(),
  scopes: z.array(z.string()),
  user: z.object({
    id: z.string().min(1),
    email: z.string().email().nullable().optional(),
    name: z.string().nullable().optional(),
    avatarUrl: z.string().url().nullable().optional(),
  }),
  currentOrganization: z.object({
    id: z.string().min(1),
  }).passthrough(),
  currentWorkspace: z.object({
    id: z.string().min(1),
  }).passthrough(),
}).passthrough();

const integrationListEntrySchema = z.object({
  provider: z.string().min(1),
  providerConfigKey: z.string().min(1).nullable(),
  status: z.string().min(1),
  connectionId: z.string().min(1).optional(),
}).passthrough();

const RUNNING_AGAINST_PROD = acceptanceEnv().baseUrl === "https://agentrelay.com/cloud";

function hasSessionAuth(): boolean {
  return Boolean(acceptanceEnv().sessionCookie);
}

describe("/api/v1/auth/token/refresh", () => {
  it("POST /api/v1/auth/token/refresh rejects missing refresh tokens", async () => {
    const response = await request("POST", "/api/v1/auth/token/refresh", {
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect([400, 429]).toContain(response.status);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    const payload = await response.json();
    if (response.status === 400) {
      expect(errorSchema.parse(payload).error).toBe("Missing refreshToken");
      return;
    }
    expect(rateLimitSchema.parse(payload).message).toBeTruthy();
  });

  it("POST /api/v1/auth/token/refresh rejects invalid refresh tokens", async () => {
    const response = await request("POST", "/api/v1/auth/token/refresh", {
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ refreshToken: `missing-${randomUUID()}` }),
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");

    const parsed = errorSchema.parse(await response.json());
    expect(parsed.error).toBe("invalid_grant");
    expect(parsed.message).toBe("Invalid or expired refresh token");
  });

  (hasSessionAuth() ? it : it.skip)(
    "POST /api/v1/auth/token/refresh rotates a live CLI refresh token",
    async () => {
      const issued = await issueCliLoginTokenSet();
      const response = await request("POST", "/api/v1/auth/token/refresh", {
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ refreshToken: issued.refreshToken }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");

      const parsed = tokenRefreshSchema.parse(await response.json());
      expect(parsed.tokenType).toBe("Bearer");
      expect(parsed.apiUrl).toBe(issued.apiUrl);
    },
  );
});

describe("/api/v1/auth/token/revoke", () => {
  it("POST /api/v1/auth/token/revoke rejects missing tokens", async () => {
    const response = await request("POST", "/api/v1/auth/token/revoke", {
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    expect(errorSchema.parse(await response.json()).error).toBe("Missing token");
  });

  it("POST /api/v1/auth/token/revoke returns not found for unknown tokens", async () => {
    const response = await request("POST", "/api/v1/auth/token/revoke", {
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ token: `missing-${randomUUID()}` }),
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    expect(errorSchema.parse(await response.json()).error).toBe("Token not found");
  });

  (hasSessionAuth() ? it : it.skip)(
    "POST /api/v1/auth/token/revoke revokes a live CLI token",
    async () => {
      const issued = await issueCliLoginTokenSet();
      const response = await request("POST", "/api/v1/auth/token/revoke", {
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ token: issued.refreshToken }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      revokeSchema.parse(await response.json());
    },
  );
});

describe("/api/v1/auth/whoami", () => {
  it("GET /api/v1/auth/whoami rejects unauthenticated callers", async () => {
    const response = await request("GET", "/api/v1/auth/whoami");

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    expect(errorSchema.parse(await response.json()).error).toBe("Unauthorized");
  });

  (hasSessionAuth() || acceptanceEnv().cliToken ? it : it.skip)(
    "GET /api/v1/auth/whoami returns the CLI bearer-token identity context",
    async () => {
      const token = hasSessionAuth()
        ? (await issueCliLoginTokenSet()).accessToken
        : loadCliToken();
      const response = await request("GET", "/api/v1/auth/whoami", {
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");

      const parsed = whoamiSchema.parse(await response.json());
      expect(parsed.authenticated).toBe(true);
      expect(parsed.source).toBe("token");
      expect(parsed.scopes).toContain("cli:auth");
      expect(parsed.user.id).toBeTruthy();
    },
  );
});

describe("/api/v1/me/integrations", () => {
  it("GET /api/v1/me/integrations rejects unauthenticated callers", async () => {
    const response = await request("GET", "/api/v1/me/integrations");

    if (RUNNING_AGAINST_PROD && response.status === 404) {
      return;
    }

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    expect(errorSchema.parse(await response.json()).error).toBe("Unauthorized");
  });

  (hasSessionAuth() || acceptanceEnv().cliToken ? it : it.skip)(
    "GET /api/v1/me/integrations lists deployer-user integrations for CLI auth",
    async () => {
      const token = hasSessionAuth()
        ? (await issueCliLoginTokenSet()).accessToken
        : loadCliToken();
      const response = await request("GET", "/api/v1/me/integrations", {
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      if (RUNNING_AGAINST_PROD && response.status === 404) {
        return;
      }

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      z.array(integrationListEntrySchema).parse(await response.json());
    },
  );
});
