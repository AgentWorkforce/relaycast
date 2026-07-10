// @route POST /api/v1/workspaces/[workspaceId]/model-proxy-token
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { acceptanceEnv } from "../../helpers/env";
import { expectJson, requestWithoutAuth } from "./_helpers";

const RUNNING_AGAINST_PROD = acceptanceEnv().baseUrl === "https://agentrelay.com/cloud";

describe("/api/v1/workspaces/[workspaceId]/model-proxy-token contracts", () => {
  it("rejects unauthenticated model-proxy-token mint", { timeout: 15_000 }, async () => {
    const response = await requestWithoutAuth(
      "POST",
      "/api/v1/workspaces/00000000-0000-0000-0000-000000000000/model-proxy-token",
    );
    // New route: PR CI runs against current prod, which can return its HTML 404
    // until the web deploy lands. Everywhere else it must reject auth (401) or
    // rate-limit (429).
    const allowedStatus = RUNNING_AGAINST_PROD ? [401, 404, 429] : [401, 429];
    expect(allowedStatus).toContain(response.status);
    if (response.status !== 404) {
      await expectJson(response, z.unknown());
    }
  });
});
