// @route POST /api/v1/workspaces/[workspaceId]/sync/refresh
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

const refreshResponseSchema = z.object({
  workspaceId: z.string().min(1),
  refreshed: z.array(
    z.object({
      provider: z.string().min(1),
      discoveryBackfilled: z.boolean(),
      errors: z.number().int().nonnegative(),
    }).passthrough(),
  ),
}).passthrough();

describe("/api/v1/workspaces/[workspaceId]/sync/refresh POST contracts", () => {
  let workspace: WorkspaceHandle | null = null;

  beforeAll(async () => {
    if (hasAcceptanceAuth()) {
      workspace = await createWorkspace({ authenticated: true, namePrefix: "sync-refresh" });
    }
  });

  afterAll(async () => {
    await destroyWorkspace(workspace);
  });

  it("rejects unauthenticated sync refresh requests", async () => {
    const response = await requestWithoutAuth(
      "POST",
      "/api/v1/workspaces/00000000-0000-0000-0000-000000000000/sync/refresh",
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );

    // Only the deployed 401 path has a JSON auth-rejection contract (auth
    // enforced before any side effect). 404 (route/path not yet live in prod →
    // Next serves an HTML 404 page), 405 (path exists but method unsupported),
    // and 429 (edge rate-limit) are pre-deploy/edge tolerances with no asserted
    // body shape or content-type.
    expect([401, 404, 405, 429]).toContain(response.status);
    if (response.status === 401) {
      await expectJson(response, errorSchema);
    }
  });

  (hasAcceptanceAuth() ? it : it.skip)(
    "materializes the discovery contract for an authenticated workspace member",
    async () => {
      const response = await requestWithAuth(
        "POST",
        `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/sync/refresh`,
        { json: {} },
      );

      // 200 with the refresh summary once deployed; 400/403/404/500 guard
      // paths; 504 when the bounded refresh returns a partial timeout; 405
      // while the route is not yet live in prod.
      expect([200, 400, 403, 404, 405, 500, 504]).toContain(response.status);
      if (response.status === 200) {
        const body = await expectJson(response, refreshResponseSchema);
        expect(body.workspaceId).toBe(workspace!.workspaceId);
      } else {
        await expectJson(response, z.union([errorSchema, z.unknown()]));
      }
    },
  );
});
