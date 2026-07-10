// @route GET /api/v1/cli/login
// @route POST /api/v1/cli/auth
// @route POST /api/v1/cli/auth/complete

import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  forgedTokenHeader,
  issueCliLoginTokenSet,
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

const cliLoginRedirectSchema = z.object({
  state: z.string().min(1),
  accessToken: z.string().min(1),
  accessTokenExpiresAt: z.string().datetime(),
  refreshToken: z.string().min(1),
  refreshTokenExpiresAt: z.string().datetime(),
  apiUrl: z.string().url(),
});

const cliAuthBootstrapSchema = z.object({
  sessionId: z.string().min(1),
  ssh: z.object({
    host: z.string().min(1),
    port: z.number().int().positive(),
    user: z.string().min(1),
    password: z.string().min(1),
  }),
  remoteCommand: z.string().min(1),
  provider: z.string().min(1),
  expiresAt: z.string().datetime(),
});

const cliAuthCompletionSchema = z.object({
  success: z.boolean(),
  provider: z.string().min(1),
  credentialJson: z.string().min(1).optional(),
});

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function hasSessionAuth(): boolean {
  return Boolean(acceptanceEnv().sessionCookie);
}

describe("/api/v1/cli/login", () => {
  it("GET /api/v1/cli/login rejects non-localhost redirect targets", async () => {
    const response = await request(
      "GET",
      "/api/v1/cli/login?redirect_uri=https://example.com/callback&state=bad",
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    expect(errorSchema.parse(await response.json()).error).toBe(
      "redirect_uri must point to localhost or 127.0.0.1",
    );
  });

  it("GET /api/v1/cli/login redirects unauthenticated users into the Google start flow", async () => {
    const response = await request(
      "GET",
      "/api/v1/cli/login?redirect_uri=http://127.0.0.1:44123/callback&state=acceptance-state",
      {
        redirect: "manual",
      },
    );

    expect([307, 429]).toContain(response.status);

    if (response.status === 429) {
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      expect(rateLimitSchema.parse(await response.json()).message).toBeTruthy();
      return;
    }

    const location = response.headers.get("location");
    expect(location).toBeTruthy();
    expect(location).toContain("/api/auth/google/start");
    expect(location).toContain("next=");
  });

  (hasSessionAuth() ? it : it.skip)(
    "GET /api/v1/cli/login returns a localhost callback with access and refresh tokens",
    async () => {
      const issued = await issueCliLoginTokenSet();

      const parsed = cliLoginRedirectSchema.parse({
        state: issued.state,
        accessToken: issued.accessToken,
        accessTokenExpiresAt: issued.accessTokenExpiresAt,
        refreshToken: issued.refreshToken,
        refreshTokenExpiresAt: issued.refreshTokenExpiresAt,
        apiUrl: issued.apiUrl,
      });

      expect(issued.callbackUrl.origin).toBe("http://127.0.0.1:44123");
      expect(parsed.state).toBe(issued.state);
    },
  );
});

describe("/api/v1/cli/auth", () => {
  it("POST /api/v1/cli/auth rejects unauthenticated callers", async () => {
    const response = await request("POST", "/api/v1/cli/auth", {
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ provider: "anthropic" }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    expect(errorSchema.parse(await response.json()).error).toBe("Unauthorized");
  });

  (hasSessionAuth() ? it : it.skip)(
    "POST /api/v1/cli/auth rejects malformed JSON bodies",
    async () => {
      const response = await signedRequest("POST", "/api/v1/cli/auth", {
        auth: "session",
        headers: {
          "content-type": "application/json",
        },
        body: "{",
      });

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      expect(errorSchema.parse(await response.json()).error).toBe("Invalid JSON body");
    },
  );

  (hasSessionAuth() ? it : it.skip)(
    "POST /api/v1/cli/auth rejects missing providers",
    async () => {
      const response = await signedRequest("POST", "/api/v1/cli/auth", {
        auth: "session",
        json: {},
      });

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      expect(errorSchema.parse(await response.json()).error).toBe("Missing required field: provider");
    },
  );

  (hasSessionAuth() ? it : it.skip)(
    "POST /api/v1/cli/auth rejects unknown providers",
    async () => {
      const response = await signedRequest("POST", "/api/v1/cli/auth", {
        auth: "session",
        json: { provider: "definitely-not-a-real-provider" },
      });

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      expect(errorSchema.parse(await response.json()).error).toContain("Unknown provider:");
    },
  );

  const noCliScopeToken = env("ACCEPTANCE_BEARER_NO_CLI_AUTH_TOKEN");
  (noCliScopeToken ? it : it.skip)(
    "POST /api/v1/cli/auth rejects authenticated tokens without cli:auth scope",
    async () => {
      const response = await request("POST", "/api/v1/cli/auth", {
        headers: {
          ...forgedTokenHeader(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ provider: "anthropic" }),
      });

      expect(response.status).toBe(403);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      expect(errorSchema.parse(await response.json()).error).toBe("Forbidden");
    },
  );

  const bootstrapProvider = env("ACCEPTANCE_CLI_AUTH_PROVIDER");
  (hasSessionAuth() && bootstrapProvider ? it : it.skip)(
    "POST /api/v1/cli/auth returns sandbox bootstrap details for a configured provider",
    async () => {
      const response = await signedRequest("POST", "/api/v1/cli/auth", {
        auth: "session",
        json: { provider: bootstrapProvider },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      cliAuthBootstrapSchema.parse(await response.json());
    },
  );
});

describe("/api/v1/cli/auth/complete", () => {
  it("POST /api/v1/cli/auth/complete rejects unauthenticated callers", async () => {
    const response = await request("POST", "/api/v1/cli/auth/complete", {
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionId: "auth-missing" }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    expect(errorSchema.parse(await response.json()).error).toBe("Unauthorized");
  });

  const noCliScopeToken = env("ACCEPTANCE_BEARER_NO_CLI_AUTH_TOKEN");
  (noCliScopeToken ? it : it.skip)(
    "POST /api/v1/cli/auth/complete rejects authenticated tokens without cli:auth scope",
    async () => {
      const response = await request("POST", "/api/v1/cli/auth/complete", {
        headers: {
          ...forgedTokenHeader(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ sessionId: "auth-missing" }),
      });

      expect(response.status).toBe(403);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      expect(errorSchema.parse(await response.json()).error).toBe("Forbidden");
    },
  );

  (hasSessionAuth() ? it : it.skip)(
    "POST /api/v1/cli/auth/complete rejects malformed JSON bodies",
    async () => {
      const response = await signedRequest("POST", "/api/v1/cli/auth/complete", {
        auth: "session",
        headers: {
          "content-type": "application/json",
        },
        body: "{",
      });

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      expect(errorSchema.parse(await response.json()).error).toBe("Invalid JSON body");
    },
  );

  (hasSessionAuth() ? it : it.skip)(
    "POST /api/v1/cli/auth/complete rejects missing session ids",
    async () => {
      const response = await signedRequest("POST", "/api/v1/cli/auth/complete", {
        auth: "session",
        json: {},
      });

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      expect(errorSchema.parse(await response.json()).error).toBe("Missing required field: sessionId");
    },
  );

  (hasSessionAuth() ? it : it.skip)(
    "POST /api/v1/cli/auth/complete returns not found for unknown sessions",
    async () => {
      const response = await signedRequest("POST", "/api/v1/cli/auth/complete", {
        auth: "session",
        json: { sessionId: "auth-missing", success: false },
      });

      expect(response.status).toBe(404);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      expect(errorSchema.parse(await response.json()).error).toBe("Session not found or expired");
    },
  );

  const bootstrapProvider = env("ACCEPTANCE_CLI_AUTH_PROVIDER");
  (hasSessionAuth() && bootstrapProvider ? it : it.skip)(
    "POST /api/v1/cli/auth/complete finalizes a live sandbox auth session",
    async () => {
      const bootstrapResponse = await signedRequest("POST", "/api/v1/cli/auth", {
        auth: "session",
        json: { provider: bootstrapProvider },
      });

      expect(bootstrapResponse.status).toBe(200);
      const bootstrap = cliAuthBootstrapSchema.parse(await bootstrapResponse.json());

      const response = await signedRequest("POST", "/api/v1/cli/auth/complete", {
        auth: "session",
        json: { sessionId: bootstrap.sessionId, success: false },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");

      const parsed = cliAuthCompletionSchema.parse(await response.json());
      expect(parsed.provider).toBe(bootstrap.provider);
      expect(parsed.success).toBe(false);
    },
  );
});
