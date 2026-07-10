// @route POST /api/v1/webhooks/nango
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { requestApi } from "../helpers/runtime";
import {
  errorSchema,
  hasWebhookSecret,
  webhookFixture,
  parseJson,
  webhookSecret,
} from "./_helpers";

const acceptedWebhookSchema = z.object({
  accepted: z.literal(true),
  type: z.string().min(1),
  ingress: z.literal("nango"),
});

function signNangoBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("/api/v1/webhooks/nango", () => {
  const secret = webhookSecret();
  const rawBody = webhookFixture("nango-auth.json");

  (hasWebhookSecret() ? it : it.skip)(
    "rejects an invalid webhook signature",
    async () => {
      const response = await requestApi("/api/v1/webhooks/nango", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-nango-hmac-sha256": "deadbeef",
        },
        body: rawBody,
      });

      expect(response.status).toBe(401);
      await parseJson(response, errorSchema);
    },
  );

  (hasWebhookSecret() && secret ? it : it.skip)(
    "accepts the signed redacted Nango fixture",
    async () => {
      const response = await requestApi("/api/v1/webhooks/nango", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-nango-hmac-sha256": signNangoBody(rawBody, secret!),
        },
        body: rawBody,
      });

      expect(response.status).toBe(200);
      const body = await parseJson(response, acceptedWebhookSchema);
      expect(body.type).toBe("auth");
    },
  );
});
