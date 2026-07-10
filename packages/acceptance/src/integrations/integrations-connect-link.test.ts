// @route POST /api/v1/integrations/connect-link
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  env,
  hasUserAuth,
  requestApi,
} from "../helpers/runtime";
import { errorSchema, parseJson } from "./_helpers";

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

const configuredWorkspaceId = env("ACCEPTANCE_WORKSPACE_ID");
const configuredProvider = env("ACCEPTANCE_CONNECT_PROVIDER") ?? "github";

describe("/api/v1/integrations/connect-link", () => {
  it("rejects unauthenticated connect-link requests", async () => {
    const response = await requestApi("/api/v1/integrations/connect-link", {
      method: "POST",
      json: {
        workspaceId: configuredWorkspaceId ?? "ws_test",
        provider: configuredProvider,
      },
    });

    expect(response.status).toBe(401);
    await parseJson(response, errorSchema);
  });

  (hasUserAuth() ? it : it.skip)(
    "rejects authenticated requests with an invalid request body",
    async () => {
      const response = await requestApi("/api/v1/integrations/connect-link", {
        method: "POST",
        auth: "user",
        headers: {
          "content-type": "application/json",
        },
        body: "[1,2,3]",
      });

      expect(response.status).toBe(400);
      const body = await parseJson(response, errorSchema);
      expect(body.error).toBe("Invalid request body");
    },
  );

  (hasUserAuth() ? it : it.skip)(
    "rejects authenticated requests with a missing workspace id",
    async () => {
      const response = await requestApi("/api/v1/integrations/connect-link", {
        method: "POST",
        auth: "user",
        json: {
          provider: configuredProvider,
        },
      });

      expect(response.status).toBe(400);
      const body = await parseJson(response, errorSchema);
      expect(body.error).toBe("workspaceId is required");
    },
  );

  (hasUserAuth() ? it : it.skip)(
    "rejects authenticated requests for an inaccessible workspace",
    async () => {
      const response = await requestApi("/api/v1/integrations/connect-link", {
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

  (hasUserAuth() && configuredWorkspaceId ? it : it.skip)(
    "rejects authenticated requests with an unsupported provider",
    async () => {
      const response = await requestApi("/api/v1/integrations/connect-link", {
        method: "POST",
        auth: "user",
        json: {
          workspaceId: configuredWorkspaceId,
          provider: "unsupported-provider",
        },
      });

      expect(response.status).toBe(400);
      const body = await parseJson(response, errorSchema);
      expect(body.error).toContain("provider or integration must be one of");
    },
  );

  (hasUserAuth() && configuredWorkspaceId ? it : it.skip)(
    "returns a provider connect-link payload for the configured workspace",
    async () => {
      const response = await requestApi("/api/v1/integrations/connect-link", {
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
});
