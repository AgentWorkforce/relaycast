// @route POST /api/v1/webhooks/transcripts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { requestApi } from "../helpers/runtime";
import { parseJson } from "./_helpers";

describe("/api/v1/webhooks/transcripts", () => {
  it("rejects an unauthenticated transcripts ingest", { timeout: 15_000 }, async () => {
    const response = await requestApi("/api/v1/webhooks/transcripts", {
      method: "POST",
      json: { id: "x", transcript_text: "y", source: { recording_id: "z" } },
      noRetryStatuses: [503],
    });
    // No bearer → 401. 503 if the ingest token isn't configured in this env.
    // 404 when PR CI runs against current prod before this route deploys.
    expect([401, 404, 503]).toContain(response.status);
    if (response.status !== 404) {
      await parseJson(response, z.unknown());
    }
  });
});
