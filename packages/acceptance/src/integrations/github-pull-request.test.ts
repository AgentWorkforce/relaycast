// @route POST /api/v1/github/pull-request
import { describe, expect, it } from "vitest";
import { requestApi } from "../helpers/runtime";
import { errorSchema, parseJson } from "./_helpers";

const RUNNING_AGAINST_PROD =
  process.env.ACCEPTANCE_BASE_URL?.replace(/\/+$/, "") ===
  "https://agentrelay.com/cloud";

describe("/api/v1/github/pull-request", () => {
  it("rejects requests without a bearer token", async () => {
    const response = await requestApi("/api/v1/github/pull-request", {
      method: "POST",
      json: {},
    });

    expect(RUNNING_AGAINST_PROD ? [401, 404] : [401]).toContain(response.status);
    if (response.status === 404) {
      return;
    }

    const body = await parseJson(response, errorSchema);
    expect(body.error).toBe("Unauthorized");
  });

  it("rejects invalid bearer tokens before parsing write payloads", async () => {
    const response = await requestApi("/api/v1/github/pull-request", {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-token",
      },
      json: {},
    });

    expect(RUNNING_AGAINST_PROD ? [401, 403, 404, 429] : [401, 403, 429]).toContain(
      response.status,
    );
    if (response.status === 429) {
      expect(await response.text()).toMatch(/\S/);
      return;
    }
    if (response.status === 404) {
      return;
    }

    const body = await parseJson(response, errorSchema);
    expect(["Unauthorized", "Forbidden"]).toContain(body.error);
  });
});
