// @route GET /api/v1/cloud-agents
// @route GET /api/v1/cloud-agents/[agentId]
// @route DELETE /api/v1/cloud-agents/[agentId]
// @route POST /api/v1/cloud-agents/[agentId]/activate
// @route POST /api/v1/workspaces/[workspaceId]/cloud-agents/[cloudAgentId]/box
// @route GET /api/v1/workspaces/[workspaceId]/cloud-agents/[cloudAgentId]/box
// @route PATCH /api/v1/workspaces/[workspaceId]/cloud-agents/[cloudAgentId]/box
// @route DELETE /api/v1/workspaces/[workspaceId]/cloud-agents/[cloudAgentId]/box
// @route GET /api/v1/workspaces/[workspaceId]/cloud-agents/[cloudAgentId]/box/events
// @route GET /api/v1/workspaces/[workspaceId]/agent-events
// @route GET /api/v1/workspaces/[workspaceId]/cloud-agents/[cloudAgentId]/events
// @route POST /api/v1/internal/cloud-agent-warm/step
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { acceptanceEnv } from "../helpers/env";
import {
  expectStatus,
  hasUserAuth,
  readJson,
  requestApi,
} from "../helpers/runtime";

const errorResponseSchema = z.object({
  error: z.string().min(1),
}).passthrough();

const cloudAgentListSchema = z.object({
  agents: z.array(z.unknown()),
});

const cloudAgentDetailSchema = z.object({
  agentId: z.string().min(1).optional(),
  id: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
}).passthrough();

const RUNNING_AGAINST_PROD = acceptanceEnv().baseUrl === "https://agentrelay.com/cloud";

describe("/api/v1/cloud-agents", () => {
  it("rejects unauthenticated cloud-agent listing", async () => {
    const response = await requestApi("/api/v1/cloud-agents");
    expectStatus(response, [401, 429]);

    if ((response.headers.get("content-type") ?? "").includes("application/json")) {
      if (response.status === 401) {
        errorResponseSchema.parse(await readJson(response));
      }
    }
  });

  (hasUserAuth() ? it : it.skip)(
    "lists cloud agents for the authenticated user/workspace",
    async () => {
      const response = await requestApi("/api/v1/cloud-agents", {
        auth: "user",
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      cloudAgentListSchema.parse(await readJson(response));
    },
  );

  const cloudAgentId = process.env.ACCEPTANCE_CLOUD_AGENT_ID?.trim();
  (cloudAgentId && hasUserAuth() ? it : it.skip)(
    "gets the configured cloud-agent detail record",
    async () => {
      const response = await requestApi(
        `/api/v1/cloud-agents/${cloudAgentId}`,
        { auth: "user" },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      cloudAgentDetailSchema.parse(await readJson(response));
    },
  );

  it("rejects unauthenticated cloud-agent activation", async () => {
    const response = await requestApi(
      "/api/v1/cloud-agents/00000000-0000-4000-8000-000000000003/activate",
      { method: "POST" },
    );
    expectStatus(response, [401, 429]);
    if (
      response.status === 401 &&
      (response.headers.get("content-type") ?? "").includes("application/json")
    ) {
      errorResponseSchema.parse(await readJson(response));
    }
  });

  (hasUserAuth() ? it : it.skip)(
    "returns not-found when activating a missing cloud agent",
    async () => {
      const response = await requestApi(
        "/api/v1/cloud-agents/00000000-0000-4000-8000-000000000003/activate",
        { method: "POST", auth: "user" },
      );
      expectStatus(response, [404]);
      errorResponseSchema.parse(await readJson(response));
    },
  );

  const deleteCloudAgentId = process.env.ACCEPTANCE_CLOUD_AGENT_DELETE_ID?.trim() ?? cloudAgentId;
  (deleteCloudAgentId && hasUserAuth() ? it : it.skip)(
    "deletes the configured cloud agent",
    async () => {
      const response = await requestApi(
        `/api/v1/cloud-agents/${deleteCloudAgentId}`,
        {
          method: "DELETE",
          auth: "user",
        },
      );

      expectStatus(response, [200, 404]);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      if (response.status === 404) {
        errorResponseSchema.parse(await readJson(response));
        return;
      }
      cloudAgentDetailSchema.parse(await readJson(response));
    },
  );

  const workspaceSourceRemote = process.env.ACCEPTANCE_CLOUD_AGENT_WORKSPACE_SOURCE_REMOTE?.trim();
  const workspaceSourceRef = process.env.ACCEPTANCE_CLOUD_AGENT_WORKSPACE_SOURCE_REF?.trim() || "main";
  const workspaceSourceCommit = process.env.ACCEPTANCE_CLOUD_AGENT_WORKSPACE_SOURCE_COMMIT?.trim();
  const modeE2eEnabled = process.env.ACCEPTANCE_CLOUD_AGENT_BOX_MODE_E2E === "1";
  const configuredWorkspaceId = acceptanceEnv().workspaceId;
  (modeE2eEnabled && cloudAgentId && workspaceSourceRemote && configuredWorkspaceId && hasUserAuth() ? it : it.skip)(
    "warms cloud-agent boxes in relayfile, git, and git-overlay workspace modes",
    async () => {
      const workspaceId = configuredWorkspaceId!;
      const basePath = `/api/v1/workspaces/${workspaceId}/cloud-agents/${cloudAgentId}/box`;
      const cases = [
        {
          label: "relayfile",
          body: { relayfileMountPaths: ["/workspace"] },
        },
        {
          label: "git",
          body: {
            relayfileMountPaths: ["/integrations/github"],
            workspaceSource: {
              kind: "git",
              remoteUrl: workspaceSourceRemote,
              ref: workspaceSourceRef,
              ...(workspaceSourceCommit ? { commit: workspaceSourceCommit } : {}),
              shallow: true,
              targetDir: "/workspace",
            },
          },
        },
        {
          label: "git-overlay",
          body: {
            relayfileMountPaths: ["/workspace", "/integrations/github"],
            workspaceSource: {
              kind: "git-overlay",
              remoteUrl: workspaceSourceRemote,
              ref: workspaceSourceRef,
              ...(workspaceSourceCommit ? { commit: workspaceSourceCommit } : {}),
              shallow: true,
              targetDir: "/workspace",
            },
          },
        },
      ] as const;

      for (const entry of cases) {
        const response = await requestApi(basePath, {
          method: "POST",
          auth: "user",
          json: entry.body,
        });
        expect(response.status, entry.label).toBe(201);
        const payload = z.object({
          sandboxId: z.string().min(1),
          relayfileToken: z.string().min(1),
          relayfileMountPath: z.literal("/workspace"),
          status: z.literal("ready"),
          execUrl: z.string().url(),
        }).passthrough().parse(await readJson(response));
        expect(payload.sandboxId, entry.label).toBeTruthy();

        const stop = await requestApi(basePath, {
          method: "DELETE",
          auth: "user",
        });
        expectStatus(stop, [200, 404, 409]);
      }
    },
    15 * 60_000,
  );

  it("rejects unauthenticated cloud-agent box operations", async () => {
    const basePath =
      "/api/v1/workspaces/00000000-0000-4000-8000-000000000001/cloud-agents/00000000-0000-4000-8000-000000000002/box";
    const operations = [
      requestApi(basePath, { method: "POST" }),
      requestApi(basePath),
      requestApi(basePath, {
        method: "PATCH",
        json: { relayfileMountPaths: ["/workspace"] },
      }),
      requestApi(basePath, { method: "DELETE" }),
      requestApi(`${basePath}/events`),
    ];

    for (const response of await Promise.all(operations)) {
      expectStatus(response, RUNNING_AGAINST_PROD ? [401, 404, 429] : [401, 429]);
      if (
        response.status === 401 &&
        (response.headers.get("content-type") ?? "").includes("application/json")
      ) {
        errorResponseSchema.parse(await readJson(response));
      }
    }
  });

  it("rejects unauthenticated agent event config access", async () => {
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const cloudAgentId = "00000000-0000-4000-8000-000000000002";
    const routes = [
      `/api/v1/workspaces/${workspaceId}/agent-events`,
      `/api/v1/workspaces/${workspaceId}/cloud-agents/${cloudAgentId}/events`,
    ];

    for (const route of routes) {
      const response = await requestApi(route);
      expectStatus(response, RUNNING_AGAINST_PROD ? [401, 404, 429] : [401, 429]);
      if (
        response.status === 401 &&
        (response.headers.get("content-type") ?? "").includes("application/json")
      ) {
        errorResponseSchema.parse(await readJson(response));
      }
    }
  });

  it("rejects unauthenticated internal cloud-agent warm step requests", async () => {
    const response = await requestApi("/api/v1/internal/cloud-agent-warm/step", {
      method: "POST",
      json: {
        jobId: "acceptance-warm-job",
        expectedStep: "ensure-sandbox",
      },
    });
    expectStatus(response, [401, 404, 429]);

    if (
      response.status === 401 &&
      (response.headers.get("content-type") ?? "").includes("application/json")
    ) {
      const body = errorResponseSchema.parse(await readJson(response));
      expect(body.error).toBe("unauthorized");
    }
  });
});
