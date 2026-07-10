// @route GET /api/v1/workspaces/[workspaceId]/agents
// @route GET /api/v1/workspaces/[workspaceId]/agents/[agentId]
// @route GET /api/v1/workspaces/[workspaceId]/agents/[agentId]/cost
// @route GET /api/v1/workspaces/[workspaceId]/agents/[agentId]/events
// @route GET /api/v1/workspaces/[workspaceId]/agents/[agentId]/metrics
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createWorkspace,
  destroyWorkspace,
  errorSchema,
  expectJson,
  hasAcceptanceAuth,
  requestWithAuth,
  requestWithoutAuth,
  type WorkspaceHandle,
} from "./_helpers";

const agentListSchema = z.object({
  agents: z.array(z.object({
    agentId: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
  }).passthrough()),
  nextCursor: z.string().nullable().optional(),
}).passthrough();

describe("/api/v1/workspaces/[workspaceId]/agents contracts", () => {
  let workspace: WorkspaceHandle | null = null;

  beforeAll(async () => {
    if (hasAcceptanceAuth()) {
      workspace = await createWorkspace({ authenticated: true, namePrefix: "agents" });
    }
  });

  afterAll(async () => {
    await destroyWorkspace(workspace);
  });

  it("rejects unauthenticated workspace agent listing", async () => {
    const response = await requestWithoutAuth(
      "GET",
      "/api/v1/workspaces/00000000-0000-0000-0000-000000000000/agents",
    );

    expect([401, 429]).toContain(response.status);
    await expectJson(response, errorSchema);
  });

  (hasAcceptanceAuth() ? it : it.skip)("lists workspace agents and probes detail/cost/events/metrics routes", async () => {
    const listResponse = await requestWithAuth(
      "GET",
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/agents`,
    );

    expect([200, 503]).toContain(listResponse.status);
    if (listResponse.status !== 200) {
      await expectJson(listResponse, errorSchema);
      return;
    }

    const body = await expectJson(listResponse, agentListSchema);
    const agentId = body.agents[0]?.agentId ?? body.agents[0]?.id ?? "missing-agent";

    const routes = [
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/agents/${encodeURIComponent(agentId)}`,
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/agents/${encodeURIComponent(agentId)}/cost`,
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/agents/${encodeURIComponent(agentId)}/events`,
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/agents/${encodeURIComponent(agentId)}/metrics`,
    ];

    for (const route of routes) {
      const response = await requestWithAuth("GET", route);
      expect([200, 404, 503]).toContain(response.status);
      await expectJson(response, response.status === 200 ? z.unknown() : errorSchema);
    }
  });
});
