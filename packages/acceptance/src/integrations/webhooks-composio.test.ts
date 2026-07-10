// @route GET /api/v1/webhooks/composio/connect/callback
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  env,
  expectStatus,
  requestApi,
} from "../helpers/runtime";
import { parseJson } from "./_helpers";

const composioErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string().min(1),
});

const composioSuccessSchema = z.object({
  ok: z.literal(true),
  workspaceId: z.string().min(1),
  provider: z.string().min(1),
  connectionId: z.string().min(1),
  providerConfigKey: z.string().min(1),
  syncTriggered: z.boolean(),
  syncs: z.array(z.string()),
});

const configuredSuccessRoute = env("ACCEPTANCE_COMPOSIO_CALLBACK_ROUTE");

describe("/api/v1/webhooks/composio/connect/callback", () => {
  it("rejects callback requests that omit state", async () => {
    const response = await requestApi("/api/v1/webhooks/composio/connect/callback");

    expect([400, 429]).toContain(response.status);
    if (response.status === 400) {
      const body = await parseJson(response, composioErrorSchema);
      expect(body.error).toBe("missing_state");
      return;
    }

    expect(await response.text()).toMatch(/\S/);
  });

  (configuredSuccessRoute ? it : it.skip)(
    "accepts the configured Composio callback route",
    async () => {
      const response = await requestApi(configuredSuccessRoute!);

      expectStatus(response, [200, 303]);
      if (response.status === 303) {
        expect(response.headers.get("location") ?? "").toContain("composioStatus=connected");
        return;
      }

      await parseJson(response, composioSuccessSchema);
    },
  );
});
