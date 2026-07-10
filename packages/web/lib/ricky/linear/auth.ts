import { NextRequest } from "next/server";
import { getAuthSessionSecret } from "@/lib/auth/secrets";
import { createSessionClaims, encodeSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { getAuthContext } from "@/lib/auth/store";
import type { RequestAuth } from "@/lib/auth/request-auth";
import { rickyLinearStore, type RickyLinearUserLink } from "./store";

export type RickyLinearSessionAuth = RequestAuth & { source: "session" };

export async function resolveRickyLinearCloudUser(input: {
  linearOrgId: string;
  linearUserId: string;
}): Promise<{ auth: RickyLinearSessionAuth; link: RickyLinearUserLink } | null> {
  const link = await rickyLinearStore.findActiveUserLink(input);
  if (!link) return null;

  const context = await getAuthContext(link.cloudUserId, link.workspaceId);
  if (context.currentWorkspace.id !== link.workspaceId) {
    return null;
  }

  return {
    link,
    auth: {
      userId: context.user.id,
      workspaceId: context.currentWorkspace.id,
      organizationId: context.currentOrganization.id,
      source: "session",
      context,
    },
  };
}

export function createDelegatedCloudRequest(input: {
  url: string;
  method?: string;
  auth: RequestAuth & { source: "session" };
  body?: unknown;
}): NextRequest {
  const secret = getAuthSessionSecret();
  const token = encodeSessionToken(
    createSessionClaims({
      userId: input.auth.userId,
      currentOrganizationId: input.auth.organizationId,
      currentWorkspaceId: input.auth.workspaceId,
    }),
    secret,
  );
  const headers = new Headers({
    Cookie: `${SESSION_COOKIE_NAME}=${token}`,
  });
  if (input.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  return new NextRequest(input.url, {
    method: input.method ?? "POST",
    headers,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
}
