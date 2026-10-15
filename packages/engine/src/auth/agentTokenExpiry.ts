/** Run-facing agent access is short-lived; one hour is the policy hard cap. */
export const AGENT_TOKEN_TTL_MS = 15 * 60_000;
export const AGENT_TOKEN_MAX_TTL_MS = 60 * 60_000;

export function agentTokenExpiresAt(now = new Date()): Date {
  // SQLite stores timestamp-mode integers in seconds. Return the same instant
  // the verifier will read back, never a rounded-up promise to the caller.
  const bounded = now.getTime() + Math.min(AGENT_TOKEN_TTL_MS, AGENT_TOKEN_MAX_TTL_MS);
  return new Date(Math.floor(bounded / 1_000) * 1_000);
}

export function isAgentTokenExpired(
  agent: { tokenExpiresAt?: Date | null },
  now = new Date(),
): boolean {
  if (agent.tokenExpiresAt == null) return false;
  const expiresAt = agent.tokenExpiresAt.getTime();
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime();
}
