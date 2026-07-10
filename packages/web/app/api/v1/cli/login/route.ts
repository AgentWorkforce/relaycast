import { NextRequest, NextResponse } from "next/server";
import {
  createApiTokenSession,
  OPERATOR_API_ACCESS_TOKEN_TTL_SECONDS,
  OPERATOR_API_REFRESH_TOKEN_TTL_SECONDS,
} from "@/lib/auth/api-token-store";
import {
  FOLLOW_USER_WORKSPACE_SCOPE,
  requireSessionAuth,
  resolveRequestAuth,
} from "@/lib/auth/request-auth";
import { getConfiguredAppOrigin } from "@/lib/app-origin";
import { toAbsoluteAppUrl } from "@/lib/app-path";
import { consumeRateLimit } from "@/lib/workers/rate-limit";

function isAllowedRedirectUri(value: string | null): value is string {
  if (!value) {
    return false;
  }

  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

function buildLoginReturnPath(requestUrl: URL): string {
  return `${requestUrl.pathname}${requestUrl.search}`;
}

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const redirectUri = requestUrl.searchParams.get("redirect_uri");
  const state = requestUrl.searchParams.get("state") ?? "";
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown";
  const rateLimit = consumeRateLimit(`cli-login:${ip}`, 30, 60_000);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil(rateLimit.retryAfterMs / 1000)),
        },
      },
    );
  }

  if (!isAllowedRedirectUri(redirectUri)) {
    return NextResponse.json(
      { error: "redirect_uri must point to localhost or 127.0.0.1" },
      { status: 400 },
    );
  }

  const auth = await resolveRequestAuth(request, { allowMissingWorkspace: true });
  if (!auth || !requireSessionAuth(auth)) {
    // Use the configured app origin so the entire OAuth flow (cookie set,
    // Google callback, state check) stays on the same domain.
    const origin = getConfiguredAppOrigin();
    const loginUrl = toAbsoluteAppUrl(origin, "/api/auth/google/start");
    loginUrl.searchParams.set("next", buildLoginReturnPath(requestUrl));
    return NextResponse.redirect(loginUrl);
  }

  const issued = await createApiTokenSession({
    subjectType: "cli",
    userId: auth.userId,
    workspaceId: auth.workspaceId,
    organizationId: auth.organizationId,
    scopes: ["cli:auth", FOLLOW_USER_WORKSPACE_SCOPE],
    accessTokenTtlSeconds: OPERATOR_API_ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlSeconds: OPERATOR_API_REFRESH_TOKEN_TTL_SECONDS,
  });

  const callbackUrl = new URL(redirectUri);
  callbackUrl.searchParams.set("state", state);
  callbackUrl.searchParams.set("access_token", issued.accessToken);
  callbackUrl.searchParams.set("refresh_token", issued.refreshToken);
  callbackUrl.searchParams.set("access_token_expires_at", issued.accessTokenExpiresAt);
  callbackUrl.searchParams.set("refresh_token_expires_at", issued.refreshTokenExpiresAt);
  callbackUrl.searchParams.set(
    "api_url",
    toAbsoluteAppUrl(getConfiguredAppOrigin(), "/").toString(),
  );

  return NextResponse.redirect(callbackUrl);
}
