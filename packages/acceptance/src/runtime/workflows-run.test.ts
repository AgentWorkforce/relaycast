// @route POST /api/v1/workflows/run
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  envJson,
  expectJsonError,
  hasUserAuth,
  readJson,
  requestApi,
} from "../helpers/runtime";

const errorResponseSchema = z.object({
  error: z.string().min(1).optional(),
  message: z.string().min(1).optional(),
}).passthrough();

const workflowRunResponseSchema = z.object({
  runId: z.string().min(1),
  status: z.string().min(1),
  sandboxId: z.string().nullable().optional(),
  dispatchType: z.string().optional(),
  dispatchedTo: z.string().optional(),
  assignmentId: z.string().optional(),
}).passthrough();

describe("/api/v1/workflows/run", () => {
  it("rejects unauthenticated workflow launches", async () => {
    const body = await expectJsonError("/api/v1/workflows/run", {
      method: "POST",
      json: {},
      allowedStatus: [401, 429],
    });

    const parsed = errorResponseSchema.parse(body);
    expect(parsed.error ?? parsed.message).toBeTruthy();
  });

  const runBody = envJson<unknown>("ACCEPTANCE_WORKFLOW_RUN_BODY");
  (runBody && hasUserAuth() ? it : it.skip)(
    "launches a workflow from the supplied fixture request",
    async () => {
      const response = await requestApi("/api/v1/workflows/run", {
        method: "POST",
        auth: "user",
        json: runBody,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      workflowRunResponseSchema.parse(await readJson(response));
    },
  );
});
