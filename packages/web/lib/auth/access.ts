// Internal-tester access gate.
//
// For now the cloud dashboard is limited to the internal tester group: anyone
// whose verified email is on one of these domains gets a session, everyone else
// is routed to the waitlist (see `app/api/auth/callback/google/route.ts`).
//
// This is intentionally a hard-coded constant rather than an env/SST secret:
// `process.env` is empty in the deployed Worker/Lambda runtime, so a config var
// would silently read as "no allowed domains" in prod and lock everyone out.
export const INTERNAL_ALLOWED_EMAIL_DOMAINS = ["agentrelay.com"] as const;

export function normalizeEmail(email: string | null | undefined): string | null {
  const trimmed = email?.trim().toLowerCase();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function emailDomain(email: string | null | undefined): string | null {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const at = normalized.lastIndexOf("@");
  if (at < 0 || at === normalized.length - 1) return null;
  return normalized.slice(at + 1);
}

/**
 * True when the email belongs to the internal tester group and should be
 * granted dashboard access. Everyone else goes to the waitlist.
 */
export function isInternalEmail(email: string | null | undefined): boolean {
  const domain = emailDomain(email);
  if (!domain) return false;
  return (INTERNAL_ALLOWED_EMAIL_DOMAINS as readonly string[]).includes(domain);
}
