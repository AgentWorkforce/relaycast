// @route POST /api/v1/github/query
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

const configuredBody = envBody("ACCEPTANCE_GITHUB_QUERY_BODY");

describe("/api/v1/github/query", () => {
  it("rejects requests without a bearer token", async () => {
    const response = await requestApi("/api/v1/github/query", {
      method: "POST",
      json: {},
    });

    expect(response.status).toBe(401);
    const body = await parseJson(response, errorSchema);
    expect(body.error).toBe("Unauthorized");
  });

  it("rejects requests with an invalid bearer token", async () => {
    const response = await requestApi("/api/v1/github/query", {
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
    "rejects authenticated requests with an invalid request body",
    async () => {
      const response = await requestApi("/api/v1/github/query", {
        method: "POST",
        auth: "specialist",
        json: {},
      });

      expect(response.status).toBe(400);
      const body = await parseJson(response, errorSchema);
      expect(body.error).toBe("Invalid request body.");
    },
  );

  (hasSpecialistAuth() ? it : it.skip)(
    "returns not_found when the workspace has no GitHub integration",
    async () => {
      const response = await requestApi("/api/v1/github/query", {
        method: "POST",
        auth: "specialist",
        json: {
          workspaceId: "00000000-0000-0000-0000-000000000000",
          operation: "listOrgs",
          params: {},
        },
      });

      expect(response.status).toBe(404);
      const body = await parseJson(response, errorSchema);
      expect(body.error).toBe("GitHub workspace integration was not found.");
    },
  );

  (hasSpecialistAuth() && configuredBody ? it : it.skip)(
    "returns the configured GitHub query response",
    async () => {
      const response = await requestApi("/api/v1/github/query", {
        method: "POST",
        auth: "specialist",
        json: configuredBody,
      });

      expect(response.status).toBe(200);
      if ((response.headers.get("content-type") ?? "").includes("application/json")) {
        await parseJson(response, jsonValueSchema);
      } else {
        expect(await response.text()).toMatch(/\S/);
      }
    },
  );
});
