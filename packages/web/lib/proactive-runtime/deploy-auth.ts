import { eq } from "drizzle-orm";
import { relayWorkspaces } from "@/lib/db/schema";
import { getDb } from "@/lib/db";
import { optionalEnv } from "@/lib/env";
import { resolveAppWorkspaceByRelayWorkspaceId } from "@/lib/workspaces/relay-workspace-binding";
import type { NextRequest } from "next/server";
import { resolveRequestAuth, requireSessionAuth, type RequestAuth } from "@/lib/auth/request-auth";

const DEFAULT_RELAYAUTH_URL = "https://api.relayauth.dev";
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

type RelayWorkspaceClaims = {
  wks: string;
};

export type ProactiveDeployContext = {
  userId: string;
  relayWorkspaceId: string;
  workspaceToken: string;
  appWorkspaceId: string | null;
  organizationId: string | null;
  source: "session" | "relay-workspace-token";
};

function resolveRelayauthUrl(): string {
  return (
    optionalEnv("WEB_RELAYAUTH_URL")
    ?? optionalEnv("RELAYAUTH_URL")
    ?? optionalEnv("RelayauthUrl")
    ?? DEFAULT_RELAYAUTH_URL
  ).replace(/\/+$/, "");
}

function readBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization")?.trim();
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice("Bearer ".length).trim();
  return token || null;
}

function isRelayWorkspaceClaims(value: unknown): value is RelayWorkspaceClaims {
  return Boolean(
    value
    && typeof value === "object"
    && typeof (value as { wks?: unknown }).wks === "string"
    && (value as { wks: string }).wks.trim(),
  );
}

async function introspectWorkspaceToken(token: string): Promise<RelayWorkspaceClaims | null> {
  const normalizedToken = token.trim();
  if (!normalizedToken) {
    return null;
  }

  const baseUrl = resolveRelayauthUrl();
  const url = new URL("/v1/tokens/introspect", `${baseUrl}/`);
  url.searchParams.set("token", normalizedToken);

  const response = await fetch(url, {
    headers: {
      "x-api-key": normalizedToken,
    },
    signal: AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    return null;
  }

  const payload = await response.json().catch(() => null);
  return isRelayWorkspaceClaims(payload) ? payload : null;
}

async function resolveRelayWorkspaceOwner(relayWorkspaceId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ ownerUserId: relayWorkspaces.ownerUserId })
    .from(relayWorkspaces)
    .where(eq(relayWorkspaces.id, relayWorkspaceId))
    .limit(1);

  return row?.ownerUserId ?? null;
}

export async function requireSessionDeployContext(
  request: NextRequest,
): Promise<{ auth: RequestAuth & { source: "session" }; context: ProactiveDeployContext } | Response> {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!requireSessionAuth(auth)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  return {
    auth,
    context: {
      userId: auth.userId,
      relayWorkspaceId: "",
      workspaceToken: "",
      appWorkspaceId: auth.workspaceId,
      organizationId: auth.organizationId,
      source: "session",
    },
  };
}

export async function requireHostedDeployContext(
  request: NextRequest,
): Promise<ProactiveDeployContext | Response> {
  const workspaceToken = readBearerToken(request);
  if (!workspaceToken) {
    return Response.json({ error: "Workspace token required" }, { status: 401 });
  }

  const claims = await introspectWorkspaceToken(workspaceToken).catch(() => null);
  if (!claims?.wks) {
    return Response.json({ error: "Invalid workspace token" }, { status: 401 });
  }

  const relayWorkspaceId = claims.wks.trim();
  const ownerUserId = await resolveRelayWorkspaceOwner(relayWorkspaceId);
  if (!ownerUserId) {
    return Response.json({ error: "Workspace not found" }, { status: 404 });
  }

  const bound = await resolveAppWorkspaceByRelayWorkspaceId(relayWorkspaceId);
  return {
    userId: ownerUserId,
    relayWorkspaceId,
    workspaceToken,
    appWorkspaceId: bound.appWorkspaceId,
    organizationId: bound.organizationId,
    source: "relay-workspace-token",
  };
}
