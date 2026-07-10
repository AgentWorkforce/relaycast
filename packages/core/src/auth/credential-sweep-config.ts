export function isCredentialSweepDisabled(
  value = process.env.DISABLE_CREDENTIAL_SWEEP,
): boolean {
  return value?.trim().toLowerCase() === "true";
}
