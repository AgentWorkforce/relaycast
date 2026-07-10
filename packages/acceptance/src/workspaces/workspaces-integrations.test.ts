// @route GET /api/v1/workspaces/[workspaceId]/integrations
// @route GET /api/v1/workspaces/[workspaceId]/integrations/[provider]/accessible-resources
// @route POST /api/v1/workspaces/[workspaceId]/integrations/[provider]/adopt
// @route GET /api/v1/workspaces/[workspaceId]/integrations/[provider]/channels
// @route POST /api/v1/workspaces/[workspaceId]/integrations/[provider]/channels
// @route GET /api/v1/workspaces/[workspaceId]/integrations/[provider]/channels/available
// @route GET /api/v1/workspaces/[workspaceId]/integrations/[provider]/options/[resource]
// @route GET /api/v1/workspaces/[workspaceId]/integrations/[provider]/resources/[resource]
// @route GET /api/v1/workspaces/[workspaceId]/integrations/[provider]/metadata
// @route PUT /api/v1/workspaces/[workspaceId]/integrations/[provider]/metadata
// @route GET /api/v1/workspaces/[workspaceId]/integrations/[provider]/status
// @route DELETE /api/v1/workspaces/[workspaceId]/integrations/[provider]/status
// @route POST /api/v1/workspaces/[workspaceId]/integrations/connect-session
// @route GET /api/v1/workspaces/[workspaceId]/integrations/github
// @route POST /api/v1/workspaces/[workspaceId]/integrations/github
// @route DELETE /api/v1/workspaces/[workspaceId]/integrations/github
// @route POST /api/v1/workspaces/[workspaceId]/integrations/github/reconcile
// @route POST /api/v1/workspaces/[workspaceId]/integrations/github/join
// @route POST /api/v1/workspaces/[workspaceId]/integrations/github/join/decision
// @route POST /api/v1/workspaces/[workspaceId]/integrations/github/link
// @route GET /api/v1/workspaces/[workspaceId]/integrations/gitlab
// @route POST /api/v1/workspaces/[workspaceId]/integrations/gitlab
// @route DELETE /api/v1/workspaces/[workspaceId]/integrations/gitlab
// @route GET /api/v1/workspaces/[workspaceId]/integrations/x
// @route POST /api/v1/workspaces/[workspaceId]/integrations/x
// @route DELETE /api/v1/workspaces/[workspaceId]/integrations/x
// @route GET /api/v1/workspaces/[workspaceId]/integrations/github/allowed-repos
// @route POST /api/v1/workspaces/[workspaceId]/integrations/github/allowed-repos
// @route GET /api/v1/workspaces/[workspaceId]/integrations/github/allowed-repos/[owner]/[repo]
// @route PATCH /api/v1/workspaces/[workspaceId]/integrations/github/allowed-repos/[owner]/[repo]
// @route DELETE /api/v1/workspaces/[workspaceId]/integrations/github/allowed-repos/[owner]/[repo]
// @route GET /api/v1/workspaces/[workspaceId]/integrations/linear
// @route POST /api/v1/workspaces/[workspaceId]/integrations/linear
// @route DELETE /api/v1/workspaces/[workspaceId]/integrations/linear
// @route GET /api/v1/workspaces/[workspaceId]/integrations/hubspot
// @route POST /api/v1/workspaces/[workspaceId]/integrations/hubspot
// @route DELETE /api/v1/workspaces/[workspaceId]/integrations/hubspot
// @route GET /api/v1/workspaces/[workspaceId]/integrations/notion
// @route POST /api/v1/workspaces/[workspaceId]/integrations/notion
// @route DELETE /api/v1/workspaces/[workspaceId]/integrations/notion
// @route GET /api/v1/workspaces/[workspaceId]/integrations/reddit
// @route POST /api/v1/workspaces/[workspaceId]/integrations/reddit
// @route DELETE /api/v1/workspaces/[workspaceId]/integrations/reddit
// @route GET /api/v1/workspaces/[workspaceId]/integrations/slack
// @route POST /api/v1/workspaces/[workspaceId]/integrations/slack
// @route DELETE /api/v1/workspaces/[workspaceId]/integrations/slack
// @route GET /api/v1/workspaces/[workspaceId]/integrations/telegram
// @route POST /api/v1/workspaces/[workspaceId]/integrations/telegram
// @route DELETE /api/v1/workspaces/[workspaceId]/integrations/telegram
// @route GET /api/v1/workspaces/[workspaceId]/integrations/slack-my-senior-dev
// @route POST /api/v1/workspaces/[workspaceId]/integrations/slack-my-senior-dev
// @route DELETE /api/v1/workspaces/[workspaceId]/integrations/slack-my-senior-dev
// @route GET /api/v1/workspaces/[workspaceId]/integrations/slack-nightcto
// @route POST /api/v1/workspaces/[workspaceId]/integrations/slack-nightcto
// @route DELETE /api/v1/workspaces/[workspaceId]/integrations/slack-nightcto
// @route GET /api/v1/workspaces/[workspaceId]/integrations/slack-sage
// @route POST /api/v1/workspaces/[workspaceId]/integrations/slack-sage
// @route DELETE /api/v1/workspaces/[workspaceId]/integrations/slack-sage
// @route GET /api/v1/workspaces/[workspaceId]/integrations/slack-sage/bot-channels
// @route GET /api/v1/workspaces/[workspaceId]/integrations/slack-sage/notify-channel
// @route PUT /api/v1/workspaces/[workspaceId]/integrations/slack-sage/notify-channel
// @route DELETE /api/v1/workspaces/[workspaceId]/integrations/slack-sage/notify-channel
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

const githubReconcileDetectionSchema = z.object({
  userLogin: z.string(),
  orgCount: z.number(),
  matches: z.array(z.object({
    installationId: z.string(),
    accountLogin: z.string(),
    accountType: z.string(),
    suspended: z.boolean(),
    alreadyConnected: z.boolean(),
  })),
  workspaceHasGithub: z.boolean(),
  fallthrough: z.literal("github-relay"),
}).passthrough();

const githubReconcileOauthRequiredSchema = errorSchema.extend({
  code: z.literal("oauth_required"),
});

describe("/api/v1/workspaces/[workspaceId]/integrations contracts", () => {
  let workspace: WorkspaceHandle | null = null;

  beforeAll(async () => {
    if (hasAcceptanceAuth()) {
      workspace = await createWorkspace({ authenticated: true, namePrefix: "integrations" });
    }
  });

  afterAll(async () => {
    await destroyWorkspace(workspace);
  });

  it("rejects unauthenticated integration access", { timeout: 45_000 }, async () => {
    const routes: Array<{ suffix: string; method?: string; allowedStatus: number[]; json: boolean }> = [
      { suffix: "/integrations", allowedStatus: [401, 429], json: true },
      { suffix: "/integrations/slack", allowedStatus: [401, 429], json: true },
      { suffix: "/integrations/github", allowedStatus: [401, 429], json: true },
      { suffix: "/integrations/github/reconcile", method: "POST", allowedStatus: [401, 429], json: true },
      {
        suffix: "/integrations/github/join",
        method: "POST",
        allowedStatus: RUNNING_AGAINST_PROD ? [401, 404, 429] : [401, 429],
        json: !RUNNING_AGAINST_PROD,
      },
      {
        suffix: "/integrations/github/join/decision",
        method: "POST",
        allowedStatus: RUNNING_AGAINST_PROD ? [401, 404, 429] : [401, 429],
        json: !RUNNING_AGAINST_PROD,
      },
      {
        suffix: "/integrations/github/link",
        method: "POST",
        allowedStatus: RUNNING_AGAINST_PROD ? [401, 404, 429] : [401, 429],
        json: !RUNNING_AGAINST_PROD,
      },
      { suffix: "/integrations/gitlab", allowedStatus: [401, 429], json: true },
      // PR CI runs this suite against current prod. The X workspace route is
      // introduced by this PR, so prod can return its HTML 404 until deploy.
      {
        suffix: "/integrations/x",
        allowedStatus: RUNNING_AGAINST_PROD ? [401, 404, 429] : [401, 429],
        json: !RUNNING_AGAINST_PROD,
      },
      { suffix: "/integrations/linear", allowedStatus: [401, 429], json: true },
      { suffix: "/integrations/notion", allowedStatus: [401, 429], json: true },
      // PR CI runs this suite against current prod. The Reddit workspace route
      // can return HTML 404 there until the web deployment lands.
      {
        suffix: "/integrations/reddit",
        allowedStatus: RUNNING_AGAINST_PROD ? [401, 404, 429] : [401, 429],
        json: !RUNNING_AGAINST_PROD,
      },
      {
        suffix: "/integrations/telegram",
        allowedStatus: RUNNING_AGAINST_PROD ? [401, 404, 429] : [401, 429],
        json: !RUNNING_AGAINST_PROD,
      },
    ];

    for (const { suffix, method = "GET", allowedStatus, json } of routes) {
      const response = await requestWithoutAuth(
        method,
        `/api/v1/workspaces/00000000-0000-0000-0000-000000000000${suffix}`,
      );
      expect(allowedStatus).toContain(response.status);
      if (json || response.status !== 404) {
        await expectJson(response, z.unknown());
      }
    }
  });

  (hasAcceptanceAuth() ? it : it.skip)("lists integrations and exercises provider-specific workspace routes", async () => {
    const base = `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/integrations`;

    const listResponse = await requestWithAuth("GET", base);
    expect([200, 500]).toContain(listResponse.status);
    await expectJson(listResponse, z.union([z.array(z.unknown()), errorSchema]));

    const providerRoutes = [
      `${base}/slack`,
      `${base}/github`,
      `${base}/gitlab`,
      `${base}/x`,
      `${base}/linear`,
      `${base}/notion`,
      `${base}/reddit`,
      `${base}/telegram`,
      `${base}/slack-my-senior-dev`,
      `${base}/slack-nightcto`,
      `${base}/slack-sage`,
    ];
    for (const route of providerRoutes) {
      for (const method of ["GET", "POST", "DELETE"] as const) {
        const response = await requestWithAuth(method, route, method === "POST" ? { json: {} } : undefined);
        expect([200, 400, 403, 404, 500]).toContain(response.status);
        await expectJson(response, z.unknown());
      }
    }

    const genericCalls: Array<[string, string, { json?: unknown }?]> = [
      [`${base}/slack/accessible-resources`, "GET"],
      [`${base}/slack/adopt`, "POST", { json: {} }],
      [`${base}/slack/channels`, "GET"],
      [`${base}/slack/channels`, "POST", { json: {} }],
      [`${base}/slack/channels/available`, "GET"],
      [`${base}/slack/metadata`, "GET"],
      [`${base}/slack/metadata`, "PUT", { json: {} }],
      [`${base}/slack/status`, "GET"],
      [`${base}/slack/status`, "DELETE"],
      [`${base}/connect-session`, "POST", { json: {} }],
      [`${base}/github/reconcile`, "POST", { json: {} }],
      [`${base}/github/allowed-repos`, "GET"],
      [`${base}/github/allowed-repos`, "POST", { json: {} }],
      [`${base}/github/allowed-repos/agentworkforce/relay`, "GET"],
      [`${base}/github/allowed-repos/agentworkforce/relay`, "PATCH", { json: {} }],
      [`${base}/github/allowed-repos/agentworkforce/relay`, "DELETE"],
      [`${base}/slack-sage/bot-channels`, "GET"],
      [`${base}/slack-sage/notify-channel`, "GET"],
      [`${base}/slack-sage/notify-channel`, "PUT", { json: {} }],
      [`${base}/slack-sage/notify-channel`, "DELETE"],
    ];

    for (const [route, method, init] of genericCalls) {
      const response = await requestWithAuth(method, route, init);
      expect([200, 400, 401, 403, 404, 409, 500, 502]).toContain(response.status);
      await expectJson(response, z.unknown());
    }

    // Onboarding option pickers. These trigger a provider Nango list-* action,
    // so without a connected integration they 404 (or 501 when the Nango
    // backend isn't configured in the acceptance env); an unsupported
    // (provider, resource) combo is a typed 400.
    const optionCalls: Array<[string, number[]]> = [
      [`${base}/slack/options/users`, [200, 400, 401, 403, 404, 500, 501, 502]],
      [`${base}/slack/options/channels`, [200, 400, 401, 403, 404, 500, 501, 502]],
      [`${base}/linear/options/teams`, [200, 400, 401, 403, 404, 500, 501, 502]],
      [`${base}/linear/options/projects`, [200, 400, 401, 403, 404, 500, 501, 502]],
      [`${base}/linear/options/labels`, [200, 400, 401, 403, 404, 500, 501, 502]],
      [`${base}/linear/options/assignees`, [200, 400, 401, 403, 404, 500, 501, 502]],
      // linear has no "channels" option list -> unsupported_resource (400).
      [`${base}/linear/options/channels`, [400, 401, 403, 404]],
    ];
    for (const [route, allowed] of optionCalls) {
      const response = await requestWithAuth("GET", route);
      expect(allowed).toContain(response.status);
      await expectJson(response, z.unknown());
    }
  });

  (hasAcceptanceAuth() ? it : it.skip)(
    "returns the GitHub reconcile detection contract or an actionable OAuth requirement",
    async () => {
      const route = `/api/v1/workspaces/${encodeURIComponent(workspace!.workspaceId)}/integrations/github/reconcile`;
      const response = await requestWithAuth("POST", route, { json: {} });

      expect([200, 409]).toContain(response.status);
      const body = await expectJson(
        response,
        z.union([githubReconcileDetectionSchema, githubReconcileOauthRequiredSchema]),
      );

      if (response.status === 200) {
        expect(body).toMatchObject({ fallthrough: "github-relay" });
      } else {
        expect(body).toMatchObject({ code: "oauth_required" });
      }
    },
  );
});
