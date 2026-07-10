import { tryResourceValue } from "@/lib/env";

export const INSTALLATION_CENTRIC_GITHUB_ENABLED_ENV =
  "INSTALLATION_CENTRIC_GITHUB";
export const GITHUB_INSTALLATION_CENTRIC_ENABLED_RESOURCE =
  "GithubInstallationCentric";

export function isGithubInstallationCentricEnabled(): boolean {
  return truthyFlag(
    tryResourceValue(GITHUB_INSTALLATION_CENTRIC_ENABLED_RESOURCE) ??
      readProcessEnvString(INSTALLATION_CENTRIC_GITHUB_ENABLED_ENV),
  );
}

function truthyFlag(value: string | null | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "enabled"
  );
}

function readProcessEnvString(name: string): string | undefined {
  if (typeof process === "undefined") {
    return undefined;
  }
  return process.env[name];
}
