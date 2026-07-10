// @route POST /api/v1/workflows/callback
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  expectStatus,
  readJson,
  requestApi,
} from "../helpers/runtime";

const errorResponseSchema = z.object({
  error: z.string().min(1),
}).passthrough();

const callbackResponseSchema = z.object({
  runId: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
}).passthrough();

describe("/api/v1/workflows/callback", () => {
  it("rejects invalid callback bodies", async () => {
    const response = await requestApi("/api/v1/workflows/callback", {
      method: "POST",
      json: {},
    });
    expectStatus(response, [400, 429]);

    if ((response.headers.get("content-type") ?? "").includes("application/json")) {
      if (response.status === 400) {
        errorResponseSchema.parse(await readJson(response));
      }
    }
  });

  const callbackRunId = process.env.ACCEPTANCE_WORKFLOW_CALLBACK_RUN_ID?.trim();
  const callbackToken = process.env.ACCEPTANCE_WORKFLOW_CALLBACK_TOKEN?.trim();

  (callbackRunId ? it : it.skip)(
    "rejects callback submissions that omit the callback token",
    async () => {
      const response = await requestApi("/api/v1/workflows/callback", {
        method: "POST",
        json: {
          runId: callbackRunId,
          status: "running",
        },
      });

      expectStatus(response, [401]);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      errorResponseSchema.parse(await readJson(response));
    },
  );

  (callbackRunId ? it : it.skip)(
    "rejects callback submissions with the wrong token",
    async () => {
      const response = await requestApi("/api/v1/workflows/callback", {
        method: "POST",
        headers: { "x-callback-token": "wrong-token" },
        json: {
          runId: callbackRunId,
          status: "running",
        },
      });

      expectStatus(response, [401]);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      errorResponseSchema.parse(await readJson(response));
    },
  );

  (callbackRunId && callbackToken ? it : it.skip)(
    "accepts a callback submission with the configured token",
    async () => {
      const response = await requestApi("/api/v1/workflows/callback", {
        method: "POST",
        headers: { "x-callback-token": callbackToken },
        json: {
          runId: callbackRunId,
          status: "running",
        },
      });

      expectStatus(response, [200, 409]);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      const body = callbackResponseSchema.parse(await readJson(response));
      expect(body.runId ?? body.error).toBeTruthy();
    },
  );
});
