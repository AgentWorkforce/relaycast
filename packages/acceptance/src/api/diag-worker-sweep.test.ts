// @route GET /api/%5Fdiag/worker-sweep
import { z } from "zod";
import { describe, expect, it } from "vitest";

import { request } from "../../helpers/server";

const RUNNING_AGAINST_PROD =
  process.env.ACCEPTANCE_BASE_URL?.replace(/\/+$/, "") ===
  "https://agentrelay.com/cloud";

const sweepSchema = z.object({
  meta: z.object({
    ts: z.string().min(1),
    runtime: z.string().min(1),
  }).passthrough(),
  sweep: z.record(z.string(), z.unknown()),
}).passthrough();

describe("diagnostic worker sweep route", () => {
  it("returns a diagnostic sweep payload when deployed", async () => {
    const response = await request("GET", "/api/%5Fdiag/worker-sweep");

    expect(RUNNING_AGAINST_PROD ? [200, 404] : [200]).toContain(response.status);
    if (response.status === 200) {
      expect(response.headers.get("content-type")).toContain("application/json");
      sweepSchema.parse(await response.json());
    }
  });
});
