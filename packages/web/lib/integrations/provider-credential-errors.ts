export const ACTIVE_CREDENTIAL_CONSTRAINT =
  "provider_credentials_one_active_per_provider";

function readErrorField(error: unknown, field: string): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

export function isActiveCredentialConflict(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  let hasUniqueViolation = false;
  let namesActiveConstraint = false;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = readErrorField(current, "code");
    const constraint = readErrorField(current, "constraint");
    const message = current instanceof Error ? current.message : null;
    const detail = readErrorField(current, "detail");
    hasUniqueViolation ||= code === "23505";
    namesActiveConstraint ||=
      constraint === ACTIVE_CREDENTIAL_CONSTRAINT ||
      Boolean(message?.includes(ACTIVE_CREDENTIAL_CONSTRAINT)) ||
      Boolean(detail?.includes(ACTIVE_CREDENTIAL_CONSTRAINT));
    current = (current as { cause?: unknown }).cause;
  }
  return hasUniqueViolation && namesActiveConstraint;
}
