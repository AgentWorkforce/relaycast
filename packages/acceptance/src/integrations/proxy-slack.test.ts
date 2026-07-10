// @route POST /api/v1/proxy/slack
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  hasSageAuth,
  requestApi,
} from "../helpers/runtime";
import {
  envBody,
  parseJson,
} from "./_helpers";

const proxySlackErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string().min(1),
  code: z.enum([
    "unauthorized",
    "forbidden",
    "rate_limited",
    "not_found",
    "slack_error",
    "upstream_error",
    "bad_request",
  ]).optional(),
  retryAfterMs: z.number().optional(),
});

const proxySlackSuccessSchema = z.object({
  ok: z.literal(true),
  data: z.unknown(),
  workspaceId: z.string().min(1),
});

const configuredBody = envBody("ACCEPTANCE_PROXY_SLACK_BODY");

describe("/api/v1/proxy/slack", () => {
  it("rejects requests that omit the bearer token", async () => {
    const response = await requestApi("/api/v1/proxy/slack", {
      method: "POST",
      json: {
        workspaceId: "00000000-0000-0000-0000-000000000000",
        endpoint: "/auth.test",
        method: "GET",
      },
    });

    expect([401, 429]).toContain(response.status);
    if (response.status === 401) {
      const body = await parseJson(response, proxySlackErrorSchema);
      expect(body.code).toBe("unauthorized");
      return;
    }

    expect(await response.text()).toMatch(/\S/);
  });

  it("rejects requests with an invalid bearer token using an auth error envelope", async () => {
    const response = await requestApi("/api/v1/proxy/slack", {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-token",
      },
      json: {
        workspaceId: "00000000-0000-0000-0000-000000000000",
        endpoint: "/auth.test",
        method: "GET",
      },
    });

    // Prod currently rejects invalid bearer tokens as either unified 401 or
    // auth-layer 403 depending on which middleware handles the request first.
    expect([401, 403, 429]).toContain(response.status);
    if (response.status === 429) {
      expect(await response.text()).toMatch(/\S/);
      return;
    }

    const body = await parseJson(response, proxySlackErrorSchema);
    if (body.code) {
      expect(["unauthorized", "forbidden"]).toContain(body.code);
    }
    expect(["Unauthorized", "Forbidden", "Invalid bearer token"]).toContain(body.error);
    expect(body.ok).toBe(false);
  });

  (hasSageAuth() && configuredBody ? it : it.skip)(
    "returns the configured Slack proxy success payload",
    async () => {
      const response = await requestApi("/api/v1/proxy/slack", {
        method: "POST",
        auth: "sage",
        json: configuredBody,
      });

      expect(response.status).toBe(200);
      await parseJson(response, proxySlackSuccessSchema);
    },
  );
});
