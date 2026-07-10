// @route POST /api/v1/proactive-runtime/continuations
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { expectStatus, readJson, requestApi } from "../helpers/runtime";

const errorResponseSchema = z
  .object({
    error: z.string().min(1),
  })
  .passthrough();

describe("/api/v1/proactive-runtime/continuations", () => {
  it("keeps continuation creation dormant by default", async () => {
    const response = await requestApi(
      "/api/v1/proactive-runtime/continuations",
      {
        method: "POST",
        json: {
          originTurnId: "acceptance-continuation-route-coverage",
          slackReplyPath:
            "/slack/channels/Cacceptance/messages/1710000000.000000/replies/1710000001.000000.json",
          userId: "Uacceptance",
        },
      },
    );

    expectStatus(response, [404, 429]);
    if (response.status === 404) {
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const body = errorResponseSchema.parse(await readJson(response));
        expect(body.error).toBe("continuations_disabled");
      } else {
        // Pre-deploy stages do not have the route yet and return the platform
        // 404 page. Once deployed, the default-off route returns JSON.
        const body = await response.text();
        expect(body.length).toBeGreaterThan(0);
      }
    }
  });
});
