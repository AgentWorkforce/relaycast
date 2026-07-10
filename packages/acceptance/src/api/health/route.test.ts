// @route GET /api/health
import { z } from "zod";
import { describe, expect, it } from "vitest";

import { request } from "../../helpers/server";

const healthResponseSchema = z.object({
  status: z.literal("ok"),
  timestamp: z.string().datetime(),
  version: z.string().min(1),
});

describe("/api/health", () => {
  it("GET /api/health returns the contract health payload", async () => {
    const response = await request("GET", "/api/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = await response.json();
    const parsed = healthResponseSchema.parse(body);

    expect(parsed.status).toBe("ok");
  });
});
