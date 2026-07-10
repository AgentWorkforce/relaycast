// @route GET /api/v1/workspaces/[workspaceId]/secrets
// @route POST /api/v1/workspaces/[workspaceId]/secrets
// @route GET /api/v1/workspaces/[workspaceId]/secrets/[secretName]
// @route DELETE /api/v1/workspaces/[workspaceId]/secrets/[secretName]
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

const secretRecordSchema = z.object({
  name: z.string().min(1),
}).passthrough();

const secretListSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    items: z.array(secretRecordSchema),
  }).passthrough(),
}).passthrough();

describe("/api/v1/workspaces/[workspaceId]/secrets contracts", () => {
  let workspace: WorkspaceHandle | null = null;
  const secretName = `acceptance_secret_${Date.now()}`;

  beforeAll(async () => {
    if (hasAcceptanceAuth()) {
      workspace = await createWorkspace({ authenticated: true, namePrefix: "secrets" });
    }
  });

  afterAll(async () => {
    await destroyWorkspace(workspace);
  });

  it("rejects unauthenticated secret listing", async () => {
    const response = await requestWithoutAuth(
      "GET",
      "/api/v1/workspaces/00000000-0000-0000-0000-000000000000/secrets",
    );

    expect(response.status).toBe(401);
    await expectJson(response, errorSchema);
  });

  (hasAcceptanceAuth() ? it : it.skip)("lists, writes, reads, and deletes workspace secrets", async () => {
    const listResponse = await requestWithAuth(
      "GET",
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/secrets`,
    );
    expect([200, 503]).toContain(listResponse.status);
    if (listResponse.status === 200) {
      await expectJson(listResponse, secretListSchema);
    } else {
      await expectJson(listResponse, errorSchema);
      return;
    }

    const createResponse = await requestWithAuth(
      "POST",
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/secrets`,
      {
        json: { name: secretName, value: "value", envVar: "ACCEPTANCE_SECRET" },
      },
    );
    expect([201, 400, 503]).toContain(createResponse.status);
    if (createResponse.status !== 201) {
      await expectJson(createResponse, errorSchema);
      return;
    }
    await expectJson(createResponse, secretRecordSchema);

    const getResponse = await requestWithAuth(
      "GET",
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/secrets/${encodeURIComponent(secretName)}`,
    );
    expect([200, 404, 503]).toContain(getResponse.status);
    if (getResponse.status === 200) {
      await expectJson(getResponse, secretRecordSchema);
    } else {
      await expectJson(getResponse, errorSchema);
    }

    const deleteResponse = await requestWithAuth(
      "DELETE",
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/secrets/${encodeURIComponent(secretName)}`,
    );
    expect([200, 404, 503]).toContain(deleteResponse.status);
    if (deleteResponse.status === 200) {
      await expectJson(deleteResponse, secretRecordSchema);
    } else {
      await expectJson(deleteResponse, errorSchema);
    }
  });

  (hasAcceptanceAuth() ? it : it.skip)("rejects invalid secret create bodies", async () => {
    const response = await requestWithAuth(
      "POST",
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/secrets`,
      {
        json: { name: "", value: "" },
      },
    );

    expect(response.status).toBe(400);
    await expectJson(response, errorSchema);
  });
});
