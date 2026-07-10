// @route POST /api/v1/deploy
// @route DELETE /api/v1/deploy/[agentId]
// @route POST /api/v1/deploy/[agentId]/redeploy
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  envJson,
  expectStatus,
  hasUserAuth,
  readJson,
  requestApi,
} from "../helpers/runtime";

const errorResponseSchema = z.object({
  error: z.string().min(1),
}).passthrough();

const deployResponseSchema = z.object({
  agentId: z.string().min(1),
  deploymentId: z.string().min(1),
}).passthrough();

const deleteOrRedeployResponseSchema = z.object({
  error: z.string().min(1).optional(),
}).passthrough();

describe("/api/v1/deploy", () => {
  it("returns an unauthenticated or upstream-failure response without credentials", async () => {
    const response = await requestApi("/api/v1/deploy", {
      method: "POST",
      json: {},
    });

    expectStatus(response, [401, 429, 500, 503]);
    if ((response.headers.get("content-type") ?? "").includes("application/json")) {
      errorResponseSchema.parse(await readJson(response));
    } else {
      // Non-JSON bodies are upstream error pages (CloudFront / Lambda
      // shrouds, throttle HTML, etc.). We only care that *some* body was
      // returned — the precise text varies across the edge.
      const body = await response.text();
      expect(body.length).toBeGreaterThan(0);
    }
  });

  const deployBody = envJson<unknown>("ACCEPTANCE_DEPLOY_BODY");
  (deployBody && hasUserAuth() ? it : it.skip)(
    "deploys from the legacy /deploy endpoint",
    async () => {
      const response = await requestApi("/api/v1/deploy", {
        method: "POST",
        auth: "user",
        json: deployBody,
      });

      expect(response.status).toBe(201);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      deployResponseSchema.parse(await readJson(response));
    },
  );

  const agentId = process.env.ACCEPTANCE_DEPLOY_AGENT_ID?.trim();
  (agentId && hasUserAuth() ? it : it.skip)(
    "gets the by-agent delete contract into a terminal response",
    async () => {
      const response = await requestApi(`/api/v1/deploy/${agentId}`, {
        method: "DELETE",
        auth: "user",
      });

      expectStatus(response, [200, 404]);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      deleteOrRedeployResponseSchema.parse(await readJson(response));
    },
  );

  const redeployAgentId = process.env.ACCEPTANCE_DEPLOY_REDEPLOY_AGENT_ID?.trim() ?? agentId;
  (redeployAgentId && hasUserAuth() ? it : it.skip)(
    "redeploys the configured agent",
    async () => {
      const response = await requestApi(
        `/api/v1/deploy/${redeployAgentId}/redeploy`,
        {
          method: "POST",
          auth: "user",
        },
      );

      expectStatus(response, [200, 404]);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      deleteOrRedeployResponseSchema.parse(await readJson(response));
    },
  );
});
