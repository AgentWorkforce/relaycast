import { NextRequest, NextResponse } from "next/server";
import { refreshApiTokenSession } from "@/lib/auth/api-token-store";
import { getConfiguredAppOrigin } from "@/lib/app-origin";
import { toAbsoluteAppUrl } from "@/lib/app-path";

const CLOUD_REFRESH_TOKEN_PREFIX = "cld_rt_";

function invalidGrantResponse() {
  return NextResponse.json(
    {
      error: "invalid_grant",
      message: "Invalid or expired refresh token",
    },
    { status: 403 },
  );
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { refreshToken?: string } | null;
  const refreshToken = body?.refreshToken?.trim();
  if (!refreshToken) {
    return NextResponse.json({ error: "Missing refreshToken" }, { status: 400 });
  }

  if (!refreshToken.startsWith(CLOUD_REFRESH_TOKEN_PREFIX)) {
    return invalidGrantResponse();
  }

  const issued = await refreshApiTokenSession(refreshToken);
  if (!issued) {
    return invalidGrantResponse();
  }

  return NextResponse.json({
    accessToken: issued.accessToken,
    accessTokenExpiresAt: issued.accessTokenExpiresAt,
    refreshToken: issued.refreshToken,
    refreshTokenExpiresAt: issued.refreshTokenExpiresAt,
    apiUrl: toAbsoluteAppUrl(getConfiguredAppOrigin(), "/").toString(),
    tokenType: "Bearer",
  });
}
