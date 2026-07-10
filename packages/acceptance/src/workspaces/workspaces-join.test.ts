// @route POST /api/v1/workspaces/[workspaceId]/join
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createWorkspace,
  destroyWorkspace,
  errorSchema,
  expectHeaderShape,
  expectJson,
  requestWithoutAuth,
  type WorkspaceHandle,
} from "./_helpers";

const joinResponseSchema = z.object({
  workspaceId: z.string().min(1),
  token: z.string().min(1),
  tokenIssuedAt: z.string().min(1),
  tokenExpiresAt: z.string().min(1),
  suggestedRefreshAt: z.string().min(1),
  relayfileUrl: z.string().url(),
  wsUrl: z.string().url(),
  relaycastApiKey: z.string().min(1),
  scopes: z.array(z.string()),
  relaycastBaseUrl: z.string().url().optional(),
}).passthrough();

// The whole suite depends on creating an anonymous workspace in
// beforeAll (which leaks a row in prod — _helpers.ts cleanup skips
// unauthenticated workspaces). Gate behind ACCEPTANCE_WRITES_OK=1.
// See Codex P1.4 on bundle PR #647.
const ALLOW_WRITES = process.env.ACCEPTANCE_WRITES_OK === "1";

(ALLOW_WRITES ? describe : describe.skip)("/api/v1/workspaces/[workspaceId]/join contracts", () => {
  let workspace: WorkspaceHandle | null = null;

  beforeAll(async () => {
    workspace = await createWorkspace({ authenticated: false, namePrefix: "join" });
  }, 20_000);

  afterAll(async () => {
    await destroyWorkspace(workspace);
  });

  it("joins an anonymous workspace and returns relayfile-friendly access fields", { timeout: 15_000 }, async () => {
    const response = await requestWithoutAuth(
      "POST",
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/join`,
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentName: "agentworkforce-cli",
          permissions: { readonly: ["/tmp"], ignored: ["/node_modules"] },
          scopes: ["relayfile:fs:read:*"],
        }),
      },
    );

    expect(response.status).toBe(200);
    const body = await expectJson(response, joinResponseSchema);
    expect(body.workspaceId).toBe(workspace!.workspaceId);
    expect(body.scopes).toContain("relayfile:fs:read:*");
    expectHeaderShape(response);
  });

  it("rejects malformed join bodies", async () => {
    const response = await requestWithoutAuth(
      "POST",
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/join`,
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentName: "" }),
      },
    );

    expect([400, 429]).toContain(response.status);
    await expectJson(response, response.status === 400 ? errorSchema : z.unknown());
  });

  it("ignores forged bearer credentials on an anonymous workspace (contract: anon join is open)", async () => {
    // Anonymous workspaces are designed to accept unauthenticated join
    // requests — the bearer header is optional for them. A forged bearer
    // should be ignored (not used to upgrade or downgrade), and the join
    // should succeed exactly as it would without one. If a workspace is
    // ever changed to require auth, this assertion will flip to 401 and
    // the test needs an update.
    const response = await requestWithoutAuth(
      "POST",
      `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/join`,
      {
        headers: {
          authorization: "Bearer forged-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ agentName: "agentworkforce-cli" }),
      },
    );

    expect([200, 429]).toContain(response.status);
    if (response.status === 200) {
      const body = await expectJson(response, joinResponseSchema);
      expect(body.workspaceId).toBe(workspace!.workspaceId);
    }
  });

  it("returns not found for an invalid workspace id", async () => {
    const response = await requestWithoutAuth(
      "POST",
      "/api/v1/workspaces/not-a-workspace/join",
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentName: "agentworkforce-cli" }),
      },
    );

    expect(response.status).toBe(404);
    await expectJson(response, errorSchema);
  });
});
