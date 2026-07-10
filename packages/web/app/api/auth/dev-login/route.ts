import { NextResponse } from "next/server";
import { loginWithGoogleIdentity, getAuthContext } from "@/lib/auth/auth-api";
import { getAuthSessionSecret } from "@/lib/auth/secrets";
import { createSessionClaims, setSessionCookie } from "@/lib/auth/session";
import { getConfiguredAppOrigin } from "@/lib/app-origin";
import { toAbsoluteAppUrl } from "@/lib/app-path";

const DEV_USER = {
  // Use a syntactically valid email — `dev@localhost` is rejected by external
  // services that validate the domain (e.g. Nango's connect-session API returns
  // 400 "Invalid email address"), which blocks integration connects locally.
  providerUserId: "dev-local-user",
  email: "dev@example.com",
  name: "Dev User",
  avatarUrl: null,
};

export async function GET() {
  if (process.env.NEXT_PUBLIC_SST_STAGE !== "development") {
    return NextResponse.json({ error: "Not available" }, { status: 404 });
  }

  const userId = await loginWithGoogleIdentity(DEV_USER);
  const context = await getAuthContext(userId);
  const origin = getConfiguredAppOrigin();

  const response = NextResponse.redirect(toAbsoluteAppUrl(origin, "/dashboard"));
  setSessionCookie(
    response,
    createSessionClaims({
      userId: context.user.id,
      currentOrganizationId: context.currentOrganization.id,
      currentWorkspaceId: context.currentWorkspace.id,
    }),
    getAuthSessionSecret(),
  );

  return response;
}
