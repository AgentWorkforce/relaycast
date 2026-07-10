// @route POST /api/v1/workspaces/[workspaceId]/sandboxes
// @route POST /api/v1/workspaces/[workspaceId]/runtime-credentials
// @route DELETE /api/v1/workspaces/[workspaceId]/sandboxes/[sandboxId]
// @route POST /api/v1/workspaces/[workspaceId]/sandboxes/[sandboxId]/exec
// @route PUT /api/v1/workspaces/[workspaceId]/sandboxes/[sandboxId]/files
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { acceptanceEnv } from "../../helpers/env";
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

const RUNNING_AGAINST_PROD = acceptanceEnv().baseUrl === "https://agentrelay.com/cloud";

describe("/api/v1/workspaces/[workspaceId]/sandboxes contracts", () => {
  let workspace: WorkspaceHandle | null = null;

  beforeAll(async () => {
    if (hasAcceptanceAuth()) {
      workspace = await createWorkspace({ authenticated: true, namePrefix: "sandboxes" });
    }
  });

  afterAll(async () => {
    await destroyWorkspace(workspace);
  });

  it("rejects unauthenticated sandbox create/exec/files/delete calls", async () => {
    const base = "/api/v1/workspaces/00000000-0000-0000-0000-000000000000/sandboxes/missing";

    const createResponse = await requestWithoutAuth(
      "POST",
      "/api/v1/workspaces/00000000-0000-0000-0000-000000000000/sandboxes",
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect([401, 429]).toContain(createResponse.status);
    await expectJson(createResponse, createResponse.status === 401 ? errorSchema : z.unknown());

    const runtimeCredentialsResponse = await requestWithoutAuth(
      "POST",
      "/api/v1/workspaces/00000000-0000-0000-0000-000000000000/runtime-credentials",
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    // PR CI runs against current prod, where this PR-introduced route can
    // return the Next HTML 404 until the web deployment lands.
    expect(RUNNING_AGAINST_PROD ? [401, 404, 429] : [401, 429]).toContain(
      runtimeCredentialsResponse.status,
    );
    if (runtimeCredentialsResponse.status !== 404) {
      await expectJson(
        runtimeCredentialsResponse,
        runtimeCredentialsResponse.status === 401 ? errorSchema : z.unknown(),
      );
    }

    const execResponse = await requestWithoutAuth("POST", `${base}/exec`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect([401, 429]).toContain(execResponse.status);
    await expectJson(execResponse, execResponse.status === 401 ? errorSchema : z.unknown());

    const filesResponse = await requestWithoutAuth("PUT", `${base}/files`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect([401, 429]).toContain(filesResponse.status);
    await expectJson(filesResponse, filesResponse.status === 401 ? errorSchema : z.unknown());

    const deleteResponse = await requestWithoutAuth("DELETE", base);
    expect([401, 429]).toContain(deleteResponse.status);
    await expectJson(deleteResponse, deleteResponse.status === 401 ? errorSchema : z.unknown());
  });

  (hasAcceptanceAuth() ? it : it.skip)("rejects invalid sandbox create payloads for an owned workspace", async () => {
    const response = await requestWithAuth(
      "POST",
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/sandboxes`,
      { json: {} },
    );

    expect(response.status).toBe(400);
    await expectJson(response, errorSchema);
  });
});
