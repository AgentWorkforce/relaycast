// @route POST /api/v1/sandboxes
// @route GET /api/v1/sandboxes/[sandboxId]/terminal
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  expectStatus,
  hasUserAuth,
  readJson,
  requestApi,
} from "../helpers/runtime";

const errorResponseSchema = z.object({
  error: z.string().min(1),
}).passthrough();

const sandboxCreateSchema = z.object({
  sandboxId: z.string().min(1),
  brokerPort: z.number(),
  status: z.string().min(1),
});

const terminalSchema = z.object({
  wsUrl: z.string().min(1),
  httpUrl: z.string().min(1),
  apiKey: z.string().min(1),
  expiresAt: z.string().min(1),
});

describe("/api/v1/sandboxes", () => {
  it("rejects unauthenticated sandbox creation", async () => {
    const response = await requestApi("/api/v1/sandboxes", {
      method: "POST",
    });
    expectStatus(response, [401, 429]);

    if ((response.headers.get("content-type") ?? "").includes("application/json")) {
      if (response.status === 401) {
        errorResponseSchema.parse(await readJson(response));
      }
    }
  });

  (process.env.ACCEPTANCE_CREATE_SANDBOX === "1" && hasUserAuth() ? it : it.skip)(
    "creates a sandbox broker runtime",
    async () => {
      const response = await requestApi("/api/v1/sandboxes", {
        method: "POST",
        auth: "user",
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      sandboxCreateSchema.parse(await readJson(response));
    },
  );

  const sandboxId = process.env.ACCEPTANCE_SANDBOX_ID?.trim();
  (sandboxId && hasUserAuth() ? it : it.skip)(
    "returns terminal connection details for the configured sandbox",
    async () => {
      const response = await requestApi(
        `/api/v1/sandboxes/${sandboxId}/terminal`,
        { auth: "user" },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      terminalSchema.parse(await readJson(response));
    },
  );
});
