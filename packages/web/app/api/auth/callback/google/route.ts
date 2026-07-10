import { NextRequest, NextResponse } from "next/server";
import { Resource } from "sst";
import { getAuthContext, loginWithGoogleIdentity } from "@/lib/auth/auth-api";
import { getConfiguredAppOrigin } from "@/lib/app-origin";
import { toAbsoluteAppUrl } from "@/lib/app-path";
import { getAuthSessionSecret } from "@/lib/auth/secrets";
import { normalizeGoogleAuthNextPath } from "@/lib/auth/google-redirect";
import { createSessionClaims, setSessionCookie } from "@/lib/auth/session";
import { exchangeGoogleCode, fetchGoogleUserInfo } from "@/lib/auth/google";
import { acceptPendingInvitesForEmail } from "@/lib/invites/invite-store";
import { isInternalEmail } from "@/lib/auth/access";
import { LOGIN_INVITE_COOKIE_NAME } from "@/lib/auth/login-invite";
import { isValidLoginInviteToken } from "@/lib/auth/login-invite.server";
import { addToWaitlist, setWaitlistEmailCookie } from "@/lib/waitlist/store";

const STATE_COOKIE_NAME = "agent_relay_google_state";
const NEXT_COOKIE_NAME = "agent_relay_post_auth_next";

function normalizeNextPath(nextPath: string | undefined): string {
  return normalizeGoogleAuthNextPath(nextPath, "/dashboard");
}

export async function GET(request: NextRequest) {
  const clientId = Resource.GoogleClientId.value;
  const clientSecret = Resource.GoogleClientSecret.value;
  if (!clientId || !clientSecret) {
    return NextResponse.json({ error: "Google auth is not configured" }, { status: 500 });
  }

  const url = new URL(request.url);
  const origin = getConfiguredAppOrigin();
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = request.cookies.get(STATE_COOKIE_NAME)?.value;
  const nextPath = normalizeNextPath(request.cookies.get(NEXT_COOKIE_NAME)?.value);
  const hasValidLoginInvite = isValidLoginInviteToken(
    request.cookies.get(LOGIN_INVITE_COOKIE_NAME)?.value,
  );

  if (!code || !state || !expectedState || state !== expectedState) {
    return NextResponse.redirect(toAbsoluteAppUrl(origin, "/?authError=state"));
  }

  try {
    const redirectUri = toAbsoluteAppUrl(origin, "/api/auth/callback/google").toString();
    const accessToken = await exchangeGoogleCode({
      code,
      clientId,
      clientSecret,
      redirectUri,
    });

    const googleUser = await fetchGoogleUserInfo(accessToken);

    // For now the dashboard is limited to the internal tester group. External
    // users can also enter with a short-lived login invite token from the
    // OAuth start step. Everyone else is added to the waitlist and routed to
    // /waitlist instead of getting a session — no user/org record is created.
    if (!isInternalEmail(googleUser.email) && !hasValidLoginInvite) {
      if (googleUser.email) {
        try {
          await addToWaitlist(googleUser.email, "google-oauth");
        } catch (waitlistError) {
          console.error("Failed to record waitlist signup:", waitlistError);
        }
      }
      const waitlistResponse = NextResponse.redirect(toAbsoluteAppUrl(origin, "/waitlist"));
      if (googleUser.email) {
        setWaitlistEmailCookie(waitlistResponse, googleUser.email);
      }
      waitlistResponse.cookies.delete(STATE_COOKIE_NAME);
      waitlistResponse.cookies.delete(NEXT_COOKIE_NAME);
      waitlistResponse.cookies.delete(LOGIN_INVITE_COOKIE_NAME);
      return waitlistResponse;
    }

    const userId = await loginWithGoogleIdentity(googleUser);

    // Auto-accept any pending org invites for this email
    if (googleUser.email) {
      try {
        await acceptPendingInvitesForEmail(googleUser.email, userId);
      } catch {
        // Non-critical — don't block login
      }
    }

    const refreshedContext = await getAuthContext(userId);

    const response = NextResponse.redirect(toAbsoluteAppUrl(origin, nextPath));
    setSessionCookie(
      response,
      createSessionClaims({
        userId: refreshedContext.user.id,
        currentOrganizationId: refreshedContext.currentOrganization.id,
        currentWorkspaceId: refreshedContext.currentWorkspace.id,
      }),
      getAuthSessionSecret(),
    );
    response.cookies.delete(STATE_COOKIE_NAME);
    response.cookies.delete(NEXT_COOKIE_NAME);
    response.cookies.delete(LOGIN_INVITE_COOKIE_NAME);
    return response;
  } catch (error) {
    console.error("Google auth callback failed:", error);
    if (error instanceof Error && error.message.includes('relation "auth_identities" does not exist')) {
      return NextResponse.redirect(toAbsoluteAppUrl(origin, "/?authError=schema"));
    }
    return NextResponse.redirect(toAbsoluteAppUrl(origin, "/?authError=google"));
  }
}
