// @route POST /api/v1/workspaces/[workspaceId]/relayhistory/session
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { acceptanceEnv } from "../../helpers/env";
import { expectJson, requestWithoutAuth } from "./_helpers";

const errorSchema = z.object({
  error: z.string().min(1),
}).passthrough();

const RUNNING_AGAINST_PROD = acceptanceEnv().baseUrl === "https://agentrelay.com/cloud";

describe("/api/v1/workspaces/[workspaceId]/relayhistory/session contracts", () => {
  it("rejects unauthenticated relayhistory session minting", async () => {
    const response = await requestWithoutAuth(
      "POST",
      "/api/v1/workspaces/00000000-0000-0000-0000-000000000000/relayhistory/session",
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "read" }),
      },
    );

    // PR acceptance runs against current prod, where this PR-introduced route
    // can return the Next HTML 404 until the web deployment lands. All allowed
    // statuses are still rejections and must not include an rth session payload.
    expect(RUNNING_AGAINST_PROD ? [401, 404, 429] : [401, 429]).toContain(response.status);
    if (response.status === 401) {
      await expectJson(response, errorSchema);
      return;
    }

    const body = await response.text();
    expect(body).not.toContain("accessToken");
    expect(body).not.toContain("refreshToken");
    expect(body).not.toContain("rth_at_");
  });
});
