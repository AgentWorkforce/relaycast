// @route POST /api/v1/integrations/nango/connect-link
// @route POST /api/v1/nango/connect-link
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  env,
  hasUserAuth,
  requestApi,
} from "../helpers/runtime";
import { errorSchema, parseJson } from "./_helpers";

const connectLinkRouteAliases = [
  "/api/v1/integrations/nango/connect-link",
  "/api/v1/nango/connect-link",
] as const;

const configuredWorkspaceId = env("ACCEPTANCE_WORKSPACE_ID");
const configuredProvider = env("ACCEPTANCE_NANGO_PROVIDER") ?? "github";
const connectLinkSchema = z.object({
  provider: z.string().min(1),
  backend: z.string().min(1),
  backendIntegrationId: z.string().min(1),
  providerConfigKey: z.string().min(1),
  workspaceId: z.string().min(1),
  token: z.string().min(1),
  sessionToken: z.string().min(1),
  expiresAt: z.string().min(1),
  connectionId: z.string().min(1),
  connectUrl: z.string().url(),
  connectLink: z.string().url(),
  url: z.string().url(),
  providers: z.array(z.object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    backend: z.string().min(1),
    backendIntegrationId: z.string().min(1),
    providerConfigKey: z.string().min(1),
    backendMetadata: z.record(z.string(), z.unknown()),
    vfsRoot: z.string().min(1),
  })),
});

describe("Nango connect-link aliases", () => {
  for (const route of connectLinkRouteAliases) {
    it(`rejects unauthenticated POST ${route}`, async () => {
      const response = await requestApi(route, {
        method: "POST",
        json: {
          workspaceId: configuredWorkspaceId ?? "ws_test",
          provider: configuredProvider,
        },
      });

      expect([401, 429]).toContain(response.status);
      if (response.status === 401) {
        await parseJson(response, errorSchema);
        return;
      }

      expect(await response.text()).toMatch(/\S/);
    });

    (hasUserAuth() ? it : it.skip)(
      `rejects an invalid JSON body for ${route}`,
      async () => {
        const response = await requestApi(route, {
          method: "POST",
          auth: "user",
          headers: {
            "content-type": "application/json",
          },
          body: "{\"workspaceId\":",
        });

        expect(response.status).toBe(400);
        const body = await parseJson(response, errorSchema);
        expect(body.error).toBe("Invalid request body");
      },
    );

    (hasUserAuth() && configuredWorkspaceId ? it : it.skip)(
      `returns a connect-link payload from ${route}`,
      async () => {
        const response = await requestApi(route, {
          method: "POST",
          auth: "user",
          json: {
            workspaceId: configuredWorkspaceId,
            provider: configuredProvider,
          },
        });

        expect(response.status).toBe(200);
        const body = await parseJson(response, connectLinkSchema);
        expect(body.provider).toBe(configuredProvider);
        expect(body.workspaceId).toBe(configuredWorkspaceId);
      },
    );

    (hasUserAuth() ? it : it.skip)(
      `rejects an inaccessible workspace for ${route}`,
      async () => {
        const response = await requestApi(route, {
          method: "POST",
          auth: "user",
          json: {
            workspaceId: "00000000-0000-0000-0000-000000000000",
            provider: configuredProvider,
          },
        });

        expect(response.status).toBe(403);
        const body = await parseJson(response, errorSchema);
        expect(body.error).toBe("Forbidden");
      },
    );
  }
});
