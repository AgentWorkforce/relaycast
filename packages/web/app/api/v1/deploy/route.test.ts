import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import {
  CI_DEPLOYMENTS_READ_SCOPE,
  CI_DEPLOYMENTS_WRITE_SCOPE,
} from "@/lib/auth/api-token-types";
import { requireAuthScope, requireSessionAuth } from "@/lib/auth/request-auth";
import { createLegacyDeployRouteHandlers } from "./route";

// These tests exercise the auth gate against the REAL scope resolver
// (requireAuthScope / requireSessionAuth), so they verify that a long-lived
// CI token carrying the CI-only deploy scope is accepted by the deploy route
// the CLI uses — and that a token without it is still rejected.

function deployRequest() {
  return new NextRequest("http://localhost/api/v1/deploy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "agent.ts" }),
  });
}

function makeHandlers(authScopes: string[] | "session") {
  const auth =
    authScopes === "session"
      ? { userId: "u1", workspaceId: "w1", organizationId: "o1", source: "session" as const }
      : {
          userId: "u1",
          workspaceId: "w1",
          organizationId: "o1",
          source: "token" as const,
          subjectType: "ci" as const,
          scopes: authScopes,
        };
  const deployEntrypoint = vi.fn().mockResolvedValue({
    agentId: "a1",
    deploymentId: "d1",
    workspaceId: "w1",
    status: "deployed",
  });
  const { POST } = createLegacyDeployRouteHandlers({
    resolveRequestAuth: vi.fn().mockResolvedValue(auth),
    requireSessionAuth,
    requireAuthScope,
    deployEntrypoint,
  });
  return { POST, deployEntrypoint };
}

describe("POST /api/v1/deploy auth gate", () => {
  it("accepts a CI token scoped to CI deploy writes", async () => {
    const { POST, deployEntrypoint } = makeHandlers([
      CI_DEPLOYMENTS_READ_SCOPE,
      CI_DEPLOYMENTS_WRITE_SCOPE,
    ]);
    const res = await POST(deployRequest());
    expect(res.status).toBe(201);
    expect(deployEntrypoint).toHaveBeenCalledOnce();
  });

  it("still accepts a cli:auth token", async () => {
    const { POST } = makeHandlers(["cli:auth"]);
    const res = await POST(deployRequest());
    expect(res.status).toBe(201);
  });

  it("still accepts a browser session", async () => {
    const { POST } = makeHandlers("session");
    const res = await POST(deployRequest());
    expect(res.status).toBe(201);
  });

  it("rejects a token without deploy scope", async () => {
    const { POST, deployEntrypoint } = makeHandlers(["deployments:read"]);
    const res = await POST(deployRequest());
    expect(res.status).toBe(403);
    expect(deployEntrypoint).not.toHaveBeenCalled();
  });
});
