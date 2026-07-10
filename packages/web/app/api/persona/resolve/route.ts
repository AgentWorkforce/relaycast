import { NextRequest, NextResponse } from "next/server";

import {
  PersonaResolveAuthRequiredError,
  PersonaResolveGithubAuthError,
  resolvePersonaFromUrl,
  type PersonaResolveResponse,
} from "@/lib/proactive-runtime/persona-resolve";
import { requireSessionAuth, resolveRequestAuth } from "@/lib/auth/request-auth";

export const runtime = "nodejs";

type PersonaResolveRequestBody = {
  url?: unknown;
};

export type { PersonaResolveResponse };

export type PersonaResolveRouteDeps = {
  resolveRequestAuth: typeof resolveRequestAuth;
  resolvePersonaFromUrl: typeof resolvePersonaFromUrl;
};

const defaultDeps: PersonaResolveRouteDeps = {
  resolveRequestAuth,
  resolvePersonaFromUrl,
};

export function createPersonaResolveRouteHandlers(deps: PersonaResolveRouteDeps = defaultDeps) {
  async function POST(request: NextRequest) {
    const body = await request.json().catch((): PersonaResolveRequestBody | null => null);
    const url = body && typeof body === "object" && typeof body.url === "string" ? body.url.trim() : "";

    if (!url) {
      return NextResponse.json({ error: "url is required" }, { status: 400 });
    }

    const auth = await deps.resolveRequestAuth(request);
    // Only forward auth onto the private-repo credential path for interactive
    // session callers. Low-scope API/relayfile tokens that resolveRequestAuth
    // accepts must not be able to mint workspace GitHub clone credentials and
    // read private persona code through this resolver.
    const sessionAuth = requireSessionAuth(auth) ? auth : null;
    try {
      const response = await deps.resolvePersonaFromUrl({
        url,
        ...(sessionAuth
          ? { auth: { userId: sessionAuth.userId, workspaceId: sessionAuth.workspaceId } }
          : {}),
      });
      return NextResponse.json(response satisfies PersonaResolveResponse);
    } catch (error) {
      if (error instanceof PersonaResolveAuthRequiredError) {
        return NextResponse.json({ error: error.message }, { status: 401 });
      }
      if (error instanceof PersonaResolveGithubAuthError) {
        return NextResponse.json({ error: error.message }, { status: 403 });
      }
      throw error;
    }
  }

  return { POST };
}

export const { POST } = createPersonaResolveRouteHandlers();
