// @route GET /api/v1/workspaces
// @route POST /api/v1/workspaces
// @route POST /api/v1/workspaces/create
// @route GET /api/v1/workspaces/[workspaceId]
// @route GET /api/v1/workspaces/[workspaceId]/logs
// @route GET /api/v1/workspaces/[workspaceId]/memory
// @route POST /api/v1/workspaces/[workspaceId]/memory
// @route GET /api/v1/workspaces/[workspaceId]/runtime
// @route PUT /api/v1/workspaces/[workspaceId]/runtime
// @route GET /api/v1/workspaces/[workspaceId]/sync
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createWorkspace,
  destroyWorkspace,
  errorSchema,
  expectHeaderShape,
  expectJson,
  genericOkSchema,
  hasAcceptanceAuth,
  requestWithAuth,
  requestWithoutAuth,
  workspaceCreateSchema,
  workspaceListSchema,
  type WorkspaceHandle,
} from "./_helpers";

const memoryItemsSchema = z.object({
  items: z.array(z.object({
    id: z.string().min(1).optional(),
    content: z.string().min(0).optional(),
    tags: z.array(z.string()).optional(),
    createdAt: z.string().nullable().optional(),
  }).passthrough()),
}).passthrough();

const runtimeSchema = z.union([
  z.object({ id: z.literal("daytona") }).passthrough(),
  z.object({
    id: z.literal("worker"),
    config: z.object({ workerId: z.string().uuid() }).passthrough(),
  }).passthrough(),
]);

const syncSchema = z.object({
  workspaceId: z.string().uuid().or(z.string().min(1)),
  providers: z.array(z.object({
    provider: z.string().min(1),
    status: z.string().min(1),
  }).passthrough()),
}).passthrough();

const logsSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    workspace: z.string().min(1),
  }).passthrough(),
}).passthrough();

describe("/api/v1/workspaces CRUD contracts", () => {
  let workspace: WorkspaceHandle | null = null;

  beforeAll(async () => {
    if (hasAcceptanceAuth()) {
      workspace = await createWorkspace({ authenticated: true, namePrefix: "crud" });
    }
  });

  afterAll(async () => {
    await destroyWorkspace(workspace);
  });

  it("rejects unauthenticated workspace listing", async () => {
    const response = await requestWithoutAuth("GET", "/api/v1/workspaces");

    expect([401, 429]).toContain(response.status);
    await expectJson(response, response.status === 401 ? errorSchema : z.unknown());
    expectHeaderShape(response);
  });

  // POST /api/v1/workspaces/create against agentrelay.com is a real
  // write that creates a row in the production workspaces table. The
  // helpers/destroyWorkspace cleanup skips unauthenticated workspaces
  // (see _helpers.ts), so each PR run leaks one row. Gate this case
  // behind ACCEPTANCE_WRITES_OK=1 so PR CI exercises the contract via
  // the 400 / invalid-body case below without polluting prod state.
  // See Codex P1.4 on bundle PR #647.
  (process.env.ACCEPTANCE_WRITES_OK === "1" ? it : it.skip)(
    "creates an anonymous workspace through the alias route",
    async () => {
      const response = await requestWithoutAuth("POST", "/api/v1/workspaces/create", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "acceptance-anon-workspace" }),
      });

      expect([201, 429]).toContain(response.status);
      await expectJson(response, response.status === 201 ? workspaceCreateSchema : z.unknown());
      expectHeaderShape(response);
    },
  );

  it("rejects invalid workspace create bodies", async () => {
    const response = await requestWithoutAuth("POST", "/api/v1/workspaces", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: 42 }),
    });

    expect([400, 429]).toContain(response.status);
    await expectJson(response, response.status === 400 ? errorSchema : z.unknown());
  });

  (hasAcceptanceAuth() ? it : it.skip)("lists workspaces for the authenticated caller", async () => {
    const response = await requestWithAuth("GET", "/api/v1/workspaces");

    expect(response.status).toBe(200);
    const body = await expectJson(response, workspaceListSchema);
    expect(body.workspaces.length).toBeGreaterThan(0);
    expectHeaderShape(response);
  });

  (hasAcceptanceAuth() ? it : it.skip)("gets the provisioned workspace by id", async () => {
    const response = await requestWithAuth(
      "GET",
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}`,
    );

    expect(response.status).toBe(200);
    const body = await expectJson(response, workspaceCreateSchema.extend({
      permissions: z.object({
        ignored: z.array(z.string()),
        readonly: z.array(z.string()),
      }).passthrough().optional(),
    }));
    expect(body.workspaceId).toBe(workspace!.workspaceId);
  });

  (hasAcceptanceAuth() ? it : it.skip)("gets workspace runtime and rejects an invalid runtime update", async () => {
    const getResponse = await requestWithAuth(
      "GET",
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/runtime`,
    );

    expect(getResponse.status).toBe(200);
    await expectJson(getResponse, runtimeSchema);

    const putResponse = await requestWithAuth(
      "PUT",
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/runtime`,
      {
        json: { runtime: { id: "worker", config: { workerId: "not-a-uuid" } } },
      },
    );

    expect(putResponse.status).toBe(400);
    await expectJson(putResponse, errorSchema);
  });

  (hasAcceptanceAuth() ? it : it.skip)("returns workspace logs and sync JSON shapes", async () => {
    const logsResponse = await requestWithAuth(
      "GET",
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/logs`,
    );
    expect([200, 503]).toContain(logsResponse.status);
    if (logsResponse.status === 200) {
      await expectJson(logsResponse, logsSchema);
    } else {
      await expectJson(logsResponse, errorSchema);
    }

    const syncResponse = await requestWithAuth(
      "GET",
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/sync`,
    );
    expect([200, 500]).toContain(syncResponse.status);
    if (syncResponse.status === 200) {
      await expectJson(syncResponse, syncSchema);
    } else {
      await expectJson(syncResponse, errorSchema);
    }
  });

  (hasAcceptanceAuth() ? it : it.skip)("rejects invalid memory read and write requests before upstream recall/save", async () => {
    const getResponse = await requestWithAuth(
      "GET",
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/memory`,
    );

    expect([400, 403]).toContain(getResponse.status);
    await expectJson(getResponse, errorSchema);

    const postResponse = await requestWithAuth(
      "POST",
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/memory`,
      {
        json: { scope: "workspace", content: "" },
      },
    );

    expect([400, 403, 503]).toContain(postResponse.status);
    if (postResponse.status === 400 || postResponse.status === 403 || postResponse.status === 503) {
      await expectJson(postResponse, errorSchema);
    } else {
      await expectJson(postResponse, genericOkSchema);
    }
  });
});
