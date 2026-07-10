// @route POST /api/v1/webhooks/linear
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { requestApi } from "../helpers/runtime";
import { parseJson } from "./_helpers";

describe("/api/v1/webhooks/linear", () => {
  it("rejects an unsigned Linear webhook delivery", { timeout: 15_000 }, async () => {
    const response = await requestApi("/api/v1/webhooks/linear", {
      method: "POST",
      json: { action: "create", type: "Issue", data: { id: "x" } },
    });
    // No valid HMAC signature → 401 (the route fails closed; also 401 when the
    // signing secret is unset). 503 if the env can't resolve the secret at all.
    // 404 when PR CI runs against current prod before this route deploys.
    expect([401, 404, 503]).toContain(response.status);
    if (response.status !== 404) {
      await parseJson(response, z.unknown());
    }
  });
});
