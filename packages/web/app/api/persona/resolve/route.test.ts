import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import {
  PersonaResolveAuthRequiredError,
  PersonaResolveGithubAuthError,
} from "@/lib/proactive-runtime/persona-resolve";
import { createPersonaResolveRouteHandlers } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("https://app.test/api/persona/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/persona/resolve", () => {
  it("threads session auth into private GitHub fallback resolution", async () => {
    const resolvePersonaFromUrl = vi.fn(async () => ({
      persona: null,
      agent: null,
      bundle: null,
      summary: {
        id: "demo",
        name: "Demo",
        slug: "demo",
        description: "Demo",
        harness: null,
        useSubscription: false,
        integrations: [],
        inputs: [],
        triggers: [],
      },
    }));
    const { POST } = createPersonaResolveRouteHandlers({
      resolveRequestAuth: vi.fn(async () => ({
        userId: "user-1",
        workspaceId: "workspace-1",
        organizationId: "org-1",
        source: "session" as const,
      })),
      resolvePersonaFromUrl,
    });

    const response = await POST(request({
      url: "https://github.com/AgentWorkforce/agents/blob/main/review/persona.ts",
    }));

    expect(response.status).toBe(200);
    expect(resolvePersonaFromUrl).toHaveBeenCalledWith({
      url: "https://github.com/AgentWorkforce/agents/blob/main/review/persona.ts",
      auth: {
        userId: "user-1",
        workspaceId: "workspace-1",
      },
    });
  });

  it("does not forward non-session token auth into the private GitHub credential path", async () => {
    const resolvePersonaFromUrl = vi.fn(async () => ({
      persona: null,
      agent: null,
      bundle: null,
      summary: {
        id: "demo",
        name: "Demo",
        slug: "demo",
        description: "Demo",
        harness: null,
        useSubscription: false,
        integrations: [],
        inputs: [],
        triggers: [],
      },
    }));
    const { POST } = createPersonaResolveRouteHandlers({
      // A low-scope API token resolveRequestAuth accepts must not be able to
      // mint workspace GitHub clone credentials through this resolver.
      resolveRequestAuth: vi.fn(async () => ({
        userId: "token-user",
        workspaceId: "token-workspace",
        organizationId: "org-1",
        source: "token" as const,
        scopes: ["workflow:runs:read"],
      })),
      resolvePersonaFromUrl,
    });

    const response = await POST(request({
      url: "https://github.com/AgentWorkforce/private-repo/blob/main/persona.ts",
    }));

    expect(response.status).toBe(200);
    expect(resolvePersonaFromUrl).toHaveBeenCalledWith({
      url: "https://github.com/AgentWorkforce/private-repo/blob/main/persona.ts",
    });
  });

  it("returns 401 when a private GitHub repo needs auth and no session is available", async () => {
    const { POST } = createPersonaResolveRouteHandlers({
      resolveRequestAuth: vi.fn(async () => null),
      resolvePersonaFromUrl: vi.fn(async () => {
        throw new PersonaResolveAuthRequiredError({
          originalUrl: "https://github.com/AgentWorkforce/agents/blob/main/review/persona.ts",
          rawUrl: "https://raw.githubusercontent.com/AgentWorkforce/agents/main/review/persona.ts",
          owner: "AgentWorkforce",
          repo: "agents",
          ref: "main",
          filePath: "review/persona.ts",
        });
      }),
    });

    const response = await POST(request({
      url: "https://github.com/AgentWorkforce/agents/blob/main/review/persona.ts",
    }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: expect.stringContaining("GitHub authentication is required"),
    });
  });

  it("returns 403 when the workspace GitHub installation cannot read the repo", async () => {
    const { POST } = createPersonaResolveRouteHandlers({
      resolveRequestAuth: vi.fn(async () => ({
        userId: "user-1",
        workspaceId: "workspace-1",
        organizationId: "org-1",
        source: "session" as const,
      })),
      resolvePersonaFromUrl: vi.fn(async () => {
        throw new PersonaResolveGithubAuthError("No GitHub integration credential can read AgentWorkforce/private-repo.");
      }),
    });

    const response = await POST(request({
      url: "https://github.com/AgentWorkforce/private-repo/blob/main/persona.ts",
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "No GitHub integration credential can read AgentWorkforce/private-repo.",
    });
  });
});
