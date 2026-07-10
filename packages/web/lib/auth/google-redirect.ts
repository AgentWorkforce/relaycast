import { stripAppBasePath, toAppPath } from "../app-path";
import { LOGIN_INVITE_TOKEN_PARAM, normalizeLoginInviteToken } from "./login-invite";

const DEFAULT_POST_AUTH_PATH = "/dashboard";

export type GoogleAuthHrefOptions = {
  loginInviteToken?: string | null;
};

export function normalizeGoogleAuthNextPath(
  path: string | null | undefined,
  fallback = DEFAULT_POST_AUTH_PATH,
): string {
  const stripped = stripAppBasePath(path);
  if (stripped.startsWith("?") || stripped.startsWith("#")) {
    return `/${stripped}`;
  }
  return stripped.startsWith("/") ? stripped : fallback;
}

export function buildGoogleAuthHref(
  nextPath = DEFAULT_POST_AUTH_PATH,
  options: GoogleAuthHrefOptions = {},
): string {
  const normalizedNextPath = normalizeGoogleAuthNextPath(nextPath, DEFAULT_POST_AUTH_PATH);
  const params = new URLSearchParams({ next: normalizedNextPath });
  const loginInviteToken = normalizeLoginInviteToken(options.loginInviteToken);
  if (loginInviteToken) {
    params.set(LOGIN_INVITE_TOKEN_PARAM, loginInviteToken);
  }
  return `${toAppPath("/api/auth/google/start")}?${params.toString()}`;
}
