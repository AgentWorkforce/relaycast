// @route GET /api/v1/workspaces/[workspaceId]/deployments/[agentId]/runs
// @route GET /api/v1/workspaces/[workspaceId]/deployments/[agentId]/runs/[runId]
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

const runListSchema = z.object({
  agentId: z.string().min(1),
  totalTokens: z.number(),
  runs: z.array(z.unknown()),
}).passthrough();

const compactRunListSchema = z.object({
  agentId: z.string().min(1),
  origin: z.literal("hosted"),
  runs: z.array(z.unknown()),
}).passthrough();

describe("/api/v1/workspaces/[workspaceId]/deployments/[agentId]/runs contracts", () => {
  let workspace: WorkspaceHandle | null = null;

  beforeAll(async () => {
    if (hasAcceptanceAuth()) {
      workspace = await createWorkspace({ authenticated: true, namePrefix: "deploy-runs" });
    }
  });

  afterAll(async () => {
    await destroyWorkspace(workspace);
  });

  it("rejects unauthenticated run listing", async () => {
    const response = await requestWithoutAuth(
      "GET",
      "/api/v1/workspaces/00000000-0000-0000-0000-000000000000/deployments/agent/runs",
    );

    expect(response.status).toBe(401);
    await expectJson(response, errorSchema);
  });

  it("rejects unauthenticated run detail reads", async () => {
    const response = await requestWithoutAuth(
      "GET",
      "/api/v1/workspaces/00000000-0000-0000-0000-000000000000/deployments/agent/runs/run",
    );

    expect(response.status).toBe(401);
    await expectJson(response, errorSchema);
  });

  (hasAcceptanceAuth() ? it : it.skip)("lists deployment runs in ui and compact formats", async () => {
    const listResponse = await requestWithAuth(
      "GET",
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/deployments/missing-agent/runs`,
    );
    expect([200, 403]).toContain(listResponse.status);
    const listBody = await expectJson(
      listResponse,
      z.union([runListSchema, errorSchema]),
    );
    if (listResponse.status === 200) {
      expect(runListSchema.parse(listBody).runs).toEqual([]);
    }

    const compactResponse = await requestWithAuth(
      "GET",
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/deployments/missing-agent/runs?format=compact`,
    );
    expect([200, 403]).toContain(compactResponse.status);
    const compactBody = await expectJson(
      compactResponse,
      z.union([compactRunListSchema, errorSchema]),
    );
    if (compactResponse.status === 200) {
      expect(compactRunListSchema.parse(compactBody).runs).toEqual([]);
    }
  });

  (hasAcceptanceAuth() ? it : it.skip)("returns 404 for missing deployment run detail", async () => {
    const detailResponse = await requestWithAuth(
      "GET",
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/deployments/missing-agent/runs/missing-run`,
    );
    expect([403, 404]).toContain(detailResponse.status);
    await expectJson(detailResponse, errorSchema);

    const compactDetailResponse = await requestWithAuth(
      "GET",
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/deployments/missing-agent/runs/missing-run?format=compact`,
    );
    expect([403, 404]).toContain(compactDetailResponse.status);
    await expectJson(compactDetailResponse, errorSchema);
  });
});
