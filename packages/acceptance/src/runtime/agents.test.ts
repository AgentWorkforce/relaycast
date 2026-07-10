// @route GET /api/v1/agents
// @route GET /api/v1/agents/[agentId]
// @route DELETE /api/v1/agents/[agentId]
// @route POST /api/v1/agents/deploy
// @route POST /api/v1/agents/provision
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  envJson,
  expectErrorLike,
  expectStatus,
  hasUserAuth,
  readJson,
  requestApi,
} from "../helpers/runtime";

const errorResponseSchema = z.object({
  error: z.string().min(1),
}).passthrough();

const agentListSchema = z.object({
  agents: z.array(z.unknown()),
});

const deployedAgentSchema = z.object({
  agentId: z.string().min(1).optional(),
  id: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
}).passthrough();

const provisionResponseSchema = z.object({
  agents: z.array(z.unknown()),
}).passthrough();

describe("/api/v1/agents", () => {
  it("returns an unauthenticated or upstream-failure response without credentials", async () => {
    const response = await requestApi("/api/v1/agents");

    expectStatus(response, [401, 429, 500, 503]);
    if ((response.headers.get("content-type") ?? "").includes("application/json")) {
      expectErrorLike(await readJson<Record<string, unknown>>(response));
    } else {
      // Non-JSON bodies are upstream error pages (CloudFront / Lambda
      // shrouds, throttle HTML, etc.). We only care that *some* body was
      // returned — the precise text varies across the edge.
      const body = await response.text();
      expect(body.length).toBeGreaterThan(0);
    }
  });

  (hasUserAuth() ? it : it.skip)(
    "lists deployed agents",
    async () => {
      const response = await requestApi("/api/v1/agents", { auth: "user" });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      agentListSchema.parse(await readJson(response));
    },
  );

  const agentId = process.env.ACCEPTANCE_AGENT_ID?.trim();
  (agentId && hasUserAuth() ? it : it.skip)(
    "gets the configured deployed agent",
    async () => {
      const response = await requestApi(`/api/v1/agents/${agentId}`, {
        auth: "user",
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      deployedAgentSchema.parse(await readJson(response));
    },
  );

  const deleteAgentId = process.env.ACCEPTANCE_AGENT_DELETE_ID?.trim() ?? agentId;
  (deleteAgentId && hasUserAuth() ? it : it.skip)(
    "deletes the configured deployed agent",
    async () => {
      const response = await requestApi(`/api/v1/agents/${deleteAgentId}`, {
        method: "DELETE",
        auth: "user",
      });

      expectStatus(response, [200, 404]);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      if (response.status === 404) {
        errorResponseSchema.parse(await readJson(response));
        return;
      }
      deployedAgentSchema.parse(await readJson(response));
    },
  );

  const deployBody = envJson<unknown>("ACCEPTANCE_AGENT_DEPLOY_BODY");
  (deployBody && hasUserAuth() ? it : it.skip)(
    "deploys an agent entrypoint from the supplied body",
    async () => {
      const response = await requestApi("/api/v1/agents/deploy", {
        method: "POST",
        auth: "user",
        json: deployBody,
      });

      expect(response.status).toBe(201);
      deployedAgentSchema.parse(await readJson(response));
    },
  );

  const provisionBody = envJson<unknown>("ACCEPTANCE_AGENT_PROVISION_BODY");
  (provisionBody && hasUserAuth() ? it : it.skip)(
    "provisions agent access tokens from the supplied body",
    async () => {
      const response = await requestApi("/api/v1/agents/provision", {
        method: "POST",
        auth: "user",
        json: provisionBody,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      const body = provisionResponseSchema.parse(await readJson(response));
      expect(body.agents.length).toBeGreaterThan(0);
    },
  );
});
