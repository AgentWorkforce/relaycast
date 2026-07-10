// @route GET /api/v1/agents/[agentId]/runs
// @route GET /api/v1/agents/[agentId]/runs/[runId]
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { acceptanceEnv } from "../helpers/env";
import { expectStatus, requestApi, readJson } from "../helpers/runtime";

const errorResponseSchema = z.object({
  error: z.string().min(1),
}).passthrough();

const RUNNING_AGAINST_PROD = acceptanceEnv().baseUrl === "https://agentrelay.com/cloud";

describe("/api/v1/agents/[agentId]/runs", () => {
  it("rejects unauthenticated run observability requests", async () => {
    const agentId = "00000000-0000-4000-8000-000000000001";
    const runId = "00000000-0000-4000-8000-000000000002";
    const responses = await Promise.all([
      requestApi(`/api/v1/agents/${agentId}/runs`),
      requestApi(`/api/v1/agents/${agentId}/runs/${runId}`),
    ]);

    for (const response of responses) {
      expectStatus(response, RUNNING_AGAINST_PROD ? [401, 404, 429] : [401, 429]);
      if (response.status === 401) {
        expect(response.headers.get("content-type") ?? "").toContain("application/json");
        errorResponseSchema.parse(await readJson(response));
      }
    }
  });
});
