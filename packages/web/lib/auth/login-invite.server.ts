import "server-only";

import { normalizeLoginInviteToken } from "./login-invite";

const LOGIN_INVITE_TOKENS = ["RELAY-2026"] as const;

export function isValidLoginInviteToken(token: string | null | undefined): boolean {
  const normalized = normalizeLoginInviteToken(token);
  return normalized !== null && (LOGIN_INVITE_TOKENS as readonly string[]).includes(normalized);
}

