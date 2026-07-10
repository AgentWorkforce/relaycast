// @route DELETE /api/v1/workspaces/[workspaceId]
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

const deletionSummarySchema = z.object({
  workspaceId: z.string().min(1),
  integrationsRevoked: z.number().int().nonnegative(),
  integrationsFailed: z.number().int().nonnegative(),
  relayfileObjectsDeleted: z.number().int().nonnegative(),
  githubCloneJobsDeleted: z.number().int().nonnegative(),
  integrationDisconnectTombstonesDeleted: z.number().int().nonnegative(),
  relayWorkspaceRowDeleted: z.boolean(),
  failures: z.array(
    z.object({
      phase: z.string().min(1),
      detail: z.string(),
    }).passthrough(),
  ),
}).passthrough();

const deleteResponseSchema = z.object({
  deleted: z.literal(true),
  summary: deletionSummarySchema,
}).passthrough();

describe("/api/v1/workspaces/[workspaceId] DELETE contracts", () => {
  // The happy-path test owns its own workspace and deletes it inline, so
  // there is no shared handle to tear down in afterAll. Guard-clause tests
  // below never reach the cascade (they 401 / 400 / 404 first).
  let strayWorkspace: WorkspaceHandle | null = null;

  beforeAll(() => {
    strayWorkspace = null;
  });

  afterAll(async () => {
    // Safety net in case the happy-path test bailed before deleting.
    await destroyWorkspace(strayWorkspace);
  });

  it("rejects unauthenticated workspace deletion", async () => {
    const response = await requestWithoutAuth(
      "DELETE",
      "/api/v1/workspaces/00000000-0000-0000-0000-000000000000",
      { json: { confirm: "00000000-0000-0000-0000-000000000000" } },
    );

    expect([401, 429]).toContain(response.status);
    await expectJson(response, response.status === 401 ? errorSchema : z.unknown());
  });

  (hasAcceptanceAuth() ? it : it.skip)(
    "rejects deletion when the confirmation token does not match",
    async () => {
      const workspace = await createWorkspace({
        authenticated: true,
        namePrefix: "delete-confirm",
      });
      strayWorkspace = workspace;

      const response = await requestWithAuth(
        "DELETE",
        `/api/v1/workspaces/${encodeURIComponent(workspace.workspaceId)}`,
        { json: { confirm: "not-the-workspace-id" } },
      );

      expect(response.status).toBe(400);
      await expectJson(response, errorSchema);

      // The workspace must still exist after a rejected confirmation.
      const stillThere = await requestWithAuth(
        "GET",
        `/api/v1/workspaces/${encodeURIComponent(workspace.workspaceId)}`,
      );
      expect(stillThere.status).toBe(200);

      // Clean up the workspace we provisioned for this guard test.
      const cleanup = await requestWithAuth(
        "DELETE",
        `/api/v1/workspaces/${encodeURIComponent(workspace.workspaceId)}`,
        { json: { confirm: workspace.workspaceId } },
      );
      expect([200, 404]).toContain(cleanup.status);
      strayWorkspace = null;
    },
  );

  (hasAcceptanceAuth() ? it : it.skip)(
    "returns 404 for an unknown/unowned workspace even with a matching confirm",
    async () => {
      const unknownId = "11111111-1111-1111-1111-111111111111";
      const response = await requestWithAuth(
        "DELETE",
        `/api/v1/workspaces/${encodeURIComponent(unknownId)}`,
        { json: { confirm: unknownId } },
      );

      expect(response.status).toBe(404);
      await expectJson(response, errorSchema);
    },
  );

  (hasAcceptanceAuth() ? it : it.skip)(
    "deletes a workspace and is idempotent on a second delete",
    async () => {
      const workspace = await createWorkspace({
        authenticated: true,
        namePrefix: "delete-happy",
      });
      strayWorkspace = workspace;

      const response = await requestWithAuth(
        "DELETE",
        `/api/v1/workspaces/${encodeURIComponent(workspace.workspaceId)}`,
        { json: { confirm: workspace.workspaceId } },
      );

      expect(response.status).toBe(200);
      const body = await expectJson(response, deleteResponseSchema);
      expect(body.summary.workspaceId).toBe(workspace.workspaceId);

      // The workspace must be gone afterwards.
      const lookup = await requestWithAuth(
        "GET",
        `/api/v1/workspaces/${encodeURIComponent(workspace.workspaceId)}`,
      );
      expect(lookup.status).toBe(404);

      // A second delete of the now-removed workspace must 404 (idempotent),
      // not 200 or 500.
      const second = await requestWithAuth(
        "DELETE",
        `/api/v1/workspaces/${encodeURIComponent(workspace.workspaceId)}`,
        { json: { confirm: workspace.workspaceId } },
      );
      expect(second.status).toBe(404);
      await expectJson(second, errorSchema);

      strayWorkspace = null;
    },
  );
});
