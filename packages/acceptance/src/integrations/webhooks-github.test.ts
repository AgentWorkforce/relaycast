// @route POST /api/v1/webhooks/github
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

const githubIgnoredSchema = z.object({
  ignored: z.literal(true),
});

const githubQueuedSchema = z.object({
  status: z.string().min(1),
  id: z.string().min(1),
  path: z.string().min(1),
  workspaceId: z.string().min(1),
});

const githubWebhookSchema = z.union([githubIgnoredSchema, githubQueuedSchema]);

function signGithubBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("/api/v1/webhooks/github", () => {
  const secret = webhookSecret();
  const rawBody = webhookFixture("github-installation.json");

  (hasWebhookSecret() ? it : it.skip)(
    "rejects a GitHub webhook with a bad signature",
    async () => {
      const response = await requestApi("/api/v1/webhooks/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": "sha256=deadbeef",
        },
        body: rawBody,
      });

      expect(response.status).toBe(401);
      await parseJson(response, errorSchema);
    },
  );

  (hasWebhookSecret() && secret ? it : it.skip)(
    "accepts the signed redacted GitHub fixture",
    async () => {
      const response = await requestApi("/api/v1/webhooks/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": `sha256=${signGithubBody(rawBody, secret!)}`,
          "x-github-event": "installation",
          "x-github-delivery": "delivery-[REDACTED:8]",
        },
        body: rawBody,
      });

      expect([200, 202]).toContain(response.status);
      await parseJson(response, githubWebhookSchema);
    },
  );
});
