// @route GET /api/v1/workspaces/[workspaceId]/dlq
// @route DELETE /api/v1/workspaces/[workspaceId]/dlq
// @route GET /api/v1/workspaces/[workspaceId]/dlq/[eventId]
// @route POST /api/v1/workspaces/[workspaceId]/dlq/[eventId]/replay
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

const dlqListSchema = z.object({
  items: z.array(z.unknown()).optional(),
}).passthrough();

describe("/api/v1/workspaces/[workspaceId]/dlq contracts", () => {
  let workspace: WorkspaceHandle | null = null;

  beforeAll(async () => {
    if (hasAcceptanceAuth()) {
      workspace = await createWorkspace({ authenticated: true, namePrefix: "dlq" });
    }
  });

  afterAll(async () => {
    await destroyWorkspace(workspace);
  });

  it("rejects unauthenticated DLQ access", async () => {
    const response = await requestWithoutAuth(
      "GET",
      "/api/v1/workspaces/00000000-0000-0000-0000-000000000000/dlq",
    );

    expect(response.status).toBe(401);
    await expectJson(response, errorSchema);
  });

  (hasAcceptanceAuth() ? it : it.skip)("lists and purges the workspace DLQ", async () => {
    const listResponse = await requestWithAuth(
      "GET",
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/dlq`,
    );
    expect([200, 503]).toContain(listResponse.status);
    if (listResponse.status === 200) {
      await expectJson(listResponse, dlqListSchema);
    } else {
      await expectJson(listResponse, errorSchema);
    }

    const purgeResponse = await requestWithAuth(
      "DELETE",
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/dlq`,
    );
    expect([200, 503]).toContain(purgeResponse.status);
    if (purgeResponse.status === 200) {
      await expectJson(purgeResponse, z.unknown());
    } else {
      await expectJson(purgeResponse, errorSchema);
    }
  });

  (hasAcceptanceAuth() ? it : it.skip)("gets and replays an individual DLQ event", async () => {
    const detailResponse = await requestWithAuth(
      "GET",
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/dlq/test-event`,
    );
    expect([200, 404, 503]).toContain(detailResponse.status);
    if (detailResponse.status === 200) {
      await expectJson(detailResponse, z.unknown());
    } else {
      await expectJson(detailResponse, errorSchema);
    }

    const replayResponse = await requestWithAuth(
      "POST",
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/dlq/test-event/replay`,
    );
    expect([200, 404, 503]).toContain(replayResponse.status);
    if (replayResponse.status === 200) {
      await expectJson(replayResponse, z.unknown());
    } else {
      await expectJson(replayResponse, errorSchema);
    }
  });
});
