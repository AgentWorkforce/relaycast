// @route POST /api/v1/slack/relay-outbound
import { z } from "zod";
import { describe, expect, it } from "vitest";

import { requestApi } from "../helpers/runtime";

const RUNNING_AGAINST_PROD =
  process.env.ACCEPTANCE_BASE_URL?.replace(/\/+$/, "") ===
  "https://agentrelay.com/cloud";

const errorSchema = z.object({
  error: z.string().min(1),
}).passthrough();

describe("Slack relay outbound route contract", () => {
  it("rejects malformed relaycast outbound events", async () => {
    const response = await requestApi("/api/v1/slack/relay-outbound", {
      method: "POST",
      json: {},
    });

    expect(RUNNING_AGAINST_PROD ? [400, 404] : [400]).toContain(response.status);
    if (response.status === 400) {
      expect(response.headers.get("content-type")).toContain("application/json");
      errorSchema.parse(await response.json());
    }
  });
});
