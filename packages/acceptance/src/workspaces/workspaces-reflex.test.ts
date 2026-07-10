// @route GET /api/v1/workspaces/[workspaceId]/reflex/patterns
// @route GET /api/v1/workspaces/[workspaceId]/reflex/outcomes
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { acceptanceEnv } from "../../helpers/env";
import { expectJson, requestWithoutAuth } from "./_helpers";

const errorSchema = z.object({
  error: z.string().min(1),
}).passthrough();

const RUNNING_AGAINST_PROD = acceptanceEnv().baseUrl === "https://agentrelay.com/cloud";

describe("/api/v1/workspaces/[workspaceId]/reflex contracts", () => {
  it("rejects unauthenticated GET /reflex/patterns", async () => {
    const response = await requestWithoutAuth(
      "GET",
      "/api/v1/workspaces/00000000-0000-0000-0000-000000000000/reflex/patterns",
    );

    expect(RUNNING_AGAINST_PROD ? [401, 404, 429] : [401, 429]).toContain(response.status);
    if (response.status === 401) {
      await expectJson(response, errorSchema);
    }
  });

  it("rejects unauthenticated GET /reflex/outcomes", async () => {
    const response = await requestWithoutAuth(
      "GET",
      "/api/v1/workspaces/00000000-0000-0000-0000-000000000000/reflex/outcomes",
    );

    expect(RUNNING_AGAINST_PROD ? [401, 404, 429] : [401, 429]).toContain(response.status);
    if (response.status === 401) {
      await expectJson(response, errorSchema);
    }
  });
});
