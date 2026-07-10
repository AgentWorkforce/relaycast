// @route GET /api/v1/webhooks/hookdeck
// @route POST /api/v1/webhooks/hookdeck
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { requestApi } from "../helpers/runtime";
import { loadFixture } from "../helpers/fixtures";
import {
  errorSchema,
  hasWebhookSecret,
  hmacBase64,
  hmacHex,
  webhookFixture,
  parseJson,
  webhookSecret,
} from "./_helpers";

const acceptedWebhookSchema = z.object({
  accepted: z.literal(true),
  type: z.string().min(1),
  ingress: z.literal("hookdeck"),
});

describe("/api/v1/webhooks/hookdeck", () => {
  const secret = webhookSecret();
  const rawBody = webhookFixture("hookdeck-forward.json");
  const dropboxChallenge = loadFixture<{ challenge: string }>(
    "webhooks/dropbox-challenge.json",
  ).challenge;

  (hasWebhookSecret() ? it : it.skip)(
    "echoes Dropbox verification challenges as text/plain",
    async () => {
      const response = await requestApi(
        `/api/v1/webhooks/hookdeck?challenge=${encodeURIComponent(dropboxChallenge)}`,
        { method: "GET" },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toMatch(/^text\/plain\b/i);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      await expect(response.text()).resolves.toBe(dropboxChallenge);
    },
  );

  (hasWebhookSecret() ? it : it.skip)(
    "returns 405 for GET without a Dropbox challenge",
    async () => {
      const response = await requestApi("/api/v1/webhooks/hookdeck", {
        method: "GET",
      });

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    },
  );

  (hasWebhookSecret() ? it : it.skip)(
    "rejects a Hookdeck webhook with bad signatures",
    async () => {
      const response = await requestApi("/api/v1/webhooks/hookdeck", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hookdeck-signature": "bad-signature",
          "x-nango-hmac-sha256": "deadbeef",
        },
        body: rawBody,
      });

      expect(response.status).toBe(401);
      await parseJson(response, errorSchema);
    },
  );

  (hasWebhookSecret() && secret ? it : it.skip)(
    "accepts the signed redacted Hookdeck fixture",
    async () => {
      const response = await requestApi("/api/v1/webhooks/hookdeck", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hookdeck-signature": hmacBase64(rawBody, secret!),
          "x-nango-hmac-sha256": hmacHex(rawBody, secret!),
        },
        body: rawBody,
      });

      expect(response.status).toBe(200);
      const body = await parseJson(response, acceptedWebhookSchema);
      expect(body.type).toBe("forward");
    },
  );
});
