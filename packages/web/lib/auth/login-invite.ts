export const LOGIN_INVITE_COOKIE_NAME = "agent_relay_login_invite";
export const LOGIN_INVITE_TOKEN_PARAM = "invite_token";

export function normalizeLoginInviteToken(token: string | null | undefined): string | null {
  const normalized = token?.trim().toUpperCase();
  return normalized && normalized.length > 0 ? normalized : null;
}

export function readLoginInviteTokenParam(searchParams: URLSearchParams): string | null {
  return (
    normalizeLoginInviteToken(searchParams.get(LOGIN_INVITE_TOKEN_PARAM)) ??
    normalizeLoginInviteToken(searchParams.get("inviteToken")) ??
    normalizeLoginInviteToken(searchParams.get("invite"))
  );
}
