// @route POST /api/v1/workflows/prepare
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

const prepareSchema = z.object({
  runId: z.string().min(1),
  s3CodeKey: z.string().min(1),
  s3Credentials: z.object({
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
    sessionToken: z.string().min(1),
    bucket: z.string().min(1),
    prefix: z.string().min(1),
  }),
});

describe("/api/v1/workflows/prepare", () => {
  it("rejects unauthenticated prepare requests", async () => {
    const response = await requestApi("/api/v1/workflows/prepare", {
      method: "POST",
    });
    expectStatus(response, [401, 429]);

    if ((response.headers.get("content-type") ?? "").includes("application/json")) {
      if (response.status === 401) {
        errorResponseSchema.parse(await readJson(response));
      }
    }
  });

  (hasUserAuth() ? it : it.skip)(
    "returns upload credentials for an authenticated caller",
    async () => {
      const response = await requestApi("/api/v1/workflows/prepare", {
        method: "POST",
        auth: "user",
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      const parsed = prepareSchema.parse(await readJson(response));
      expect(parsed.s3CodeKey).toBe("code.tar.gz");
    },
  );
});
