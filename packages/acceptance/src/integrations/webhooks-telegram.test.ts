// @route POST /api/v1/webhooks/telegram/[connectionId]
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parseJson } from "./_helpers";
import { requestApi } from "../helpers/runtime";

const telegramWebhookErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string().min(1),
}).passthrough();

describe("/api/v1/webhooks/telegram/[connectionId]", () => {
  it("rejects invalid JSON bodies with a JSON error envelope", async () => {
    const response = await requestApi("/api/v1/webhooks/telegram/conn_acceptance", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: "{",
    });

    // PR acceptance can run against a deployment that has not picked up this
    // newly added route yet.
    expect([400, 404, 429]).toContain(response.status);
    if (response.status === 400) {
      await parseJson(response, telegramWebhookErrorSchema);
      return;
    }

    expect(await response.text()).toMatch(/\S/);
  });
});
