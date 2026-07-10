// @route POST /api/v1/notion/query
import { describe, expect, it } from "vitest";
import {
  hasSpecialistAuth,
  requestApi,
} from "../helpers/runtime";
import {
  envBody,
  errorSchema,
  jsonValueSchema,
  parseJson,
} from "./_helpers";

const configuredBody = envBody("ACCEPTANCE_NOTION_QUERY_BODY");

describe("/api/v1/notion/query", () => {
  it("rejects requests without a bearer token", async () => {
    const response = await requestApi("/api/v1/notion/query", {
      method: "POST",
      json: {},
    });

    expect([401, 429]).toContain(response.status);
    if (response.status === 401) {
      const body = await parseJson(response, errorSchema);
      expect(body.error).toBe("Unauthorized");
      return;
    }

    expect(await response.text()).toMatch(/\S/);
  });

  (hasSpecialistAuth() ? it : it.skip)(
    "rejects authenticated requests with an invalid request body",
    async () => {
      const response = await requestApi("/api/v1/notion/query", {
        method: "POST",
        auth: "specialist",
        json: {},
      });

      expect(response.status).toBe(400);
      const body = await parseJson(response, errorSchema);
      expect(body.error).toBe("Invalid request body.");
    },
  );

  it("rejects requests with an invalid bearer token", async () => {
    const response = await requestApi("/api/v1/notion/query", {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-token",
      },
      json: {},
    });

    // Prod currently rejects invalid bearer tokens as either unified 401 or
    // auth-layer 403 depending on which middleware handles the request first.
    expect([401, 403, 429]).toContain(response.status);
    if (response.status === 429) {
      expect(await response.text()).toMatch(/\S/);
      return;
    }

    const body = await parseJson(response, errorSchema);
    expect(["Unauthorized", "Forbidden"]).toContain(body.error);
  });

  (hasSpecialistAuth() ? it : it.skip)(
    "returns not_found when the workspace has no Notion integration",
    async () => {
      const response = await requestApi("/api/v1/notion/query", {
        method: "POST",
        auth: "specialist",
        json: {
          workspaceId: "00000000-0000-0000-0000-000000000000",
          operation: "listPages",
          params: {},
        },
      });

      expect(response.status).toBe(404);
      const body = await parseJson(response, errorSchema);
      expect(body.error).toBe("Notion workspace integration was not found.");
    },
  );

  (hasSpecialistAuth() && configuredBody ? it : it.skip)(
    "returns the configured Notion query response",
    async () => {
      const response = await requestApi("/api/v1/notion/query", {
        method: "POST",
        auth: "specialist",
        json: configuredBody,
      });

      expect(response.status).toBe(200);
      await parseJson(response, jsonValueSchema);
    },
  );
});
