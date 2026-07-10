// @route GET /api/v1/workspaces/[workspaceId]/deployments
// @route POST /api/v1/workspaces/[workspaceId]/deployments
// @route DELETE /api/v1/workspaces/[workspaceId]/deployments/[agentId]
// @route POST /api/v1/workspaces/[workspaceId]/deployments/[agentId]/ticks
// @route POST /api/v1/workspaces/[workspaceId]/deployments/[agentId]/usage
// @route POST /api/v1/workspaces/[workspaceId]/fs/import
// @route POST /api/v1/workspaces/[workspaceId]/ops/[opId]/replay
// @route POST /api/v1/workspaces/[workspaceId]/provider-credentials/byok
// @route POST /api/v1/workspaces/[workspaceId]/provider-credentials/setup-token
// @route GET /api/v1/workspaces/[workspaceId]/provider-credentials/managed
// @route POST /api/v1/workspaces/[workspaceId]/provider-credentials/managed
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
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

const deploymentListSchema = z.object({
  agents: z.array(z.unknown()),
  nextCursor: z.string().nullable().optional(),
}).passthrough();

describe("/api/v1/workspaces/[workspaceId]/deployments contracts", () => {
  let workspace: WorkspaceHandle | null = null;

  beforeAll(async () => {
    if (hasAcceptanceAuth()) {
      workspace = await createWorkspace({ authenticated: true, namePrefix: "deploy" });
    }
  });

  afterAll(async () => {
    await destroyWorkspace(workspace);
  });

  it("rejects unauthenticated deployment listing", async () => {
    const response = await requestWithoutAuth(
      "GET",
      "/api/v1/workspaces/00000000-0000-0000-0000-000000000000/deployments",
    );

    expect(response.status).toBe(401);
    await expectJson(response, errorSchema);
  });

  it("requires deployment webhook tokens for ticks and usage", async () => {
    const usageResponse = await requestWithoutAuth(
      "POST",
      "/api/v1/workspaces/00000000-0000-0000-0000-000000000000/deployments/agent/usage",
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect([401, 429]).toContain(usageResponse.status);
    await expectJson(usageResponse, usageResponse.status === 401 ? errorSchema : z.unknown());

    const tickResponse = await requestWithoutAuth(
      "POST",
      "/api/v1/workspaces/00000000-0000-0000-0000-000000000000/deployments/agent/ticks",
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect([401, 429]).toContain(tickResponse.status);
    await expectJson(tickResponse, tickResponse.status === 401 ? errorSchema : z.unknown());
  });

  (hasAcceptanceAuth() ? it : it.skip)("lists deployments and exercises deployment-adjacent admin routes", async () => {
    const listResponse = await requestWithAuth(
      "GET",
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/deployments`,
    );
    expect([200, 403]).toContain(listResponse.status);
    await expectJson(
      listResponse,
      z.union([deploymentListSchema, errorSchema]),
    );

    const createResponse = await requestWithAuth(
      "POST",
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/deployments`,
      { json: {} },
    );
    expect([400, 409, 500]).toContain(createResponse.status);
    await expectJson(createResponse, z.unknown());

    const deleteResponse = await requestWithAuth(
      "DELETE",
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/deployments/missing-agent`,
    );
    expect([403, 404, 500]).toContain(deleteResponse.status);
    await expectJson(deleteResponse, z.unknown());

    const byokResponse = await requestWithAuth(
      "POST",
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/provider-credentials/byok`,
      { json: {} },
    );
    expect([400, 502]).toContain(byokResponse.status);
    await expectJson(byokResponse, z.unknown());

    const setupTokenResponse = await requestWithAuth(
      "POST",
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/provider-credentials/setup-token`,
      { json: {} },
    );
    expect([400, 502]).toContain(setupTokenResponse.status);
    await expectJson(setupTokenResponse, z.unknown());

    for (const method of ["GET", "POST"] as const) {
      const managedResponse = await requestWithAuth(
        method,
        `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/provider-credentials/managed`,
        method === "POST" ? { json: {} } : undefined,
      );
      expect([400, 503]).toContain(managedResponse.status);
      await expectJson(managedResponse, z.unknown());
    }

    const importResponse = await requestWithAuth(
      "POST",
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/fs/import`,
      {
        headers: { "content-type": "application/json" },
        body: gzipSync(Buffer.from("not-a-tar-archive")),
      },
    );
    expect([400, 415, 500]).toContain(importResponse.status);
    await expectJson(importResponse, errorSchema);

    const replayResponse = await requestWithAuth(
      "POST",
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/ops/test-op/replay`,
    );
    expect([404, 500, 503]).toContain(replayResponse.status);
    await expectJson(replayResponse, errorSchema);
  });
});
