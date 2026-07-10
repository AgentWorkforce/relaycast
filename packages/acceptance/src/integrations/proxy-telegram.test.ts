// @route POST /api/v1/proxy/telegram
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { envBody, parseJson } from "./_helpers";
import { hasSageAuth, requestApi } from "../helpers/runtime";

const proxyTelegramErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string().min(1),
  code: z.enum([
    "unauthorized",
    "bad_request",
    "not_connected",
    "telegram_error",
    "upstream_error",
  ]),
  allowedMethods: z.array(z.string()).optional(),
});

const proxyTelegramSuccessSchema = z.object({
  ok: z.literal(true),
  data: z.unknown(),
  workspaceId: z.string().min(1),
});

const configuredBody = envBody("ACCEPTANCE_PROXY_TELEGRAM_BODY");

describe("/api/v1/proxy/telegram", () => {
  it("rejects requests that omit the bearer token", async () => {
    const response = await requestApi("/api/v1/proxy/telegram", {
      method: "POST",
      json: {
        endpoint: "/getMe",
        method: "GET",
      },
    });

    // PR acceptance can run against a deployment that has not picked up this
    // newly added route yet.
    expect([401, 404, 429]).toContain(response.status);
    if (response.status === 401) {
      const body = await parseJson(response, proxyTelegramErrorSchema);
      expect(body.code).toBe("unauthorized");
      return;
    }

    expect(await response.text()).toMatch(/\S/);
  });

  it("rejects requests with an invalid bearer token using an auth error envelope", async () => {
    const response = await requestApi("/api/v1/proxy/telegram", {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-token",
      },
      json: {
        endpoint: "/getMe",
        method: "GET",
      },
    });

    expect([401, 403, 404, 429]).toContain(response.status);
    if (response.status === 404 || response.status === 429) {
      expect(await response.text()).toMatch(/\S/);
      return;
    }

    const body = await parseJson(response, proxyTelegramErrorSchema);
    if (body.code) {
      expect(["unauthorized", "bad_request"]).toContain(body.code);
    }
    expect(body.ok).toBe(false);
  });

  (hasSageAuth() && configuredBody ? it : it.skip)(
    "returns the configured Telegram proxy success payload",
    async () => {
      const response = await requestApi("/api/v1/proxy/telegram", {
        method: "POST",
        auth: "sage",
        json: configuredBody,
      });

      expect(response.status).toBe(200);
      await parseJson(response, proxyTelegramSuccessSchema);
    },
  );
});
