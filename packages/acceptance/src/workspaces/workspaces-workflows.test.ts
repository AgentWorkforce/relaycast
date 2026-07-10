// @route POST /api/v1/workspaces/[workspaceId]/workflows/run
// @route GET /api/v1/workspaces/[workspaceId]/workflows/runs/[runId]
import type { Response as UndiciResponse } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { signedRequest } from "../../helpers/auth";
import { acceptanceEnv } from "../../helpers/env";
import {
  createWorkspace,
  destroyWorkspace,
  errorSchema,
  expectHeaderShape,
  expectJson,
  hasAcceptanceAuth,
  requestWithoutAuth,
  type WorkspaceHandle,
} from "./_helpers";

const workflowLaunchSchema = z.object({
  runId: z.string().min(1),
  status: z.string().min(1),
  sandboxId: z.string().nullable().optional(),
  dispatchType: z.string().min(1).optional(),
  dispatchedTo: z.string().min(1).optional(),
  assignmentId: z.string().min(1).optional(),
}).passthrough();

const workflowStatusSchema = z.object({
  runId: z.string().min(1),
  status: z.enum(["pending", "running", "success", "failure"]),
  output: z.unknown().optional(),
  error: z.string().min(1).optional(),
}).passthrough();

function hasWorkflowInvokeAuth(): boolean {
  return Boolean(acceptanceEnv().sessionCookie);
}

async function requestWithWorkflowSessionAuth(
  method: string,
  route: string,
  init: { json?: unknown } = {},
) {
  return signedRequest(method, route, {
    auth: "session",
    json: init.json,
  });
}

async function pollWorkflowStatus(
  workspaceId: string,
  runId: string,
): Promise<UndiciResponse> {
  let lastResponse: UndiciResponse | null = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await requestWithWorkflowSessionAuth(
      "GET",
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/workflows/runs/${encodeURIComponent(runId)}`,
    );
    if (response.status !== 404) {
      return response;
    }

    lastResponse = response;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  if (!lastResponse) {
    throw new Error("Workflow status poll did not issue a request");
  }

  return lastResponse;
}

describe("/api/v1/workspaces/[workspaceId]/workflows contracts", () => {
  let workspace: WorkspaceHandle | null = null;

  beforeAll(async () => {
    if (hasAcceptanceAuth()) {
      workspace = await createWorkspace({ authenticated: true, namePrefix: "workflow" });
    }
  });

  afterAll(async () => {
    await destroyWorkspace(workspace);
  });

  it("rejects unauthenticated workspace workflow invocation", async () => {
    const response = await requestWithoutAuth(
      "POST",
      "/api/v1/workspaces/00000000-0000-0000-0000-000000000000/workflows/run",
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "echo", args: {} }),
      },
    );

    expect([401, 429]).toContain(response.status);
    await expectJson(response, response.status === 401 ? errorSchema : z.unknown());
    expectHeaderShape(response);
  });

  it("rejects unauthenticated workspace workflow status reads", async () => {
    const response = await requestWithoutAuth(
      "GET",
      "/api/v1/workspaces/00000000-0000-0000-0000-000000000000/workflows/runs/11111111-1111-1111-1111-111111111111",
    );

    expect([401, 429]).toContain(response.status);
    await expectJson(response, response.status === 401 ? errorSchema : z.unknown());
    expectHeaderShape(response);
  });

  (hasWorkflowInvokeAuth() ? it : it.skip)(
    "returns documented validation and unknown-slug errors for workspace workflow invocation",
    async () => {
      const base = `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/workflows/run`;

      const invalidBodyResponse = await requestWithWorkflowSessionAuth("POST", base, {
        json: { args: {} },
      });
      expect(invalidBodyResponse.status).toBe(400);
      await expectJson(invalidBodyResponse, errorSchema);
      expectHeaderShape(invalidBodyResponse);

      const unknownSlugResponse = await requestWithWorkflowSessionAuth("POST", base, {
        json: { name: "acceptance-missing-workflow", args: { ping: true } },
      });
      expect(unknownSlugResponse.status).toBe(404);
      const unknownSlugBody = await expectJson(
        unknownSlugResponse,
        errorSchema.extend({
          code: z.literal("workflow_slug_not_found"),
          knownSlugs: z.array(z.string().min(1)),
        }),
      );
      expect(unknownSlugBody.knownSlugs).toContain("echo");
      expectHeaderShape(unknownSlugResponse);
    },
  );

  (hasWorkflowInvokeAuth() ? it : it.skip)(
    "launches the built-in echo workflow and reads its workspace-scoped status",
    { timeout: 30_000 },
    async () => {
      const launchResponse = await requestWithWorkflowSessionAuth(
        "POST",
        `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/workflows/run`,
        {
          json: { name: "echo", args: { source: "acceptance" } },
        },
      );

      expect(launchResponse.status).toBe(200);
      const launchBody = await expectJson(launchResponse, workflowLaunchSchema);
      expectHeaderShape(launchResponse);

      const statusResponse = await pollWorkflowStatus(
        workspace!.workspaceId,
        launchBody.runId,
      );

      expect(statusResponse.status).toBe(200);
      const statusBody = await expectJson(statusResponse, workflowStatusSchema);
      expect(statusBody.runId).toBe(launchBody.runId);
      expectHeaderShape(statusResponse);
    },
  );
});
