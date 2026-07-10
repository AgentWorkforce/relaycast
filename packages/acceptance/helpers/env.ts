function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function readRequiredEnv(name: string): string {
  const value = readOptionalEnv(name);
  if (!value) {
    throw new Error(`Missing required acceptance env var: ${name}`);
  }
  return value;
}

export interface AcceptanceEnv {
  baseUrl: string;
  cliToken?: string;
  sessionCookie?: string;
  workspaceId?: string;
  userId?: string;
}

export function acceptanceEnv(): AcceptanceEnv {
  return {
    baseUrl: normalizeBaseUrl(readRequiredEnv("ACCEPTANCE_BASE_URL")),
    cliToken: readOptionalEnv("ACCEPTANCE_CLI_TOKEN"),
    sessionCookie: readOptionalEnv("ACCEPTANCE_SESSION_COOKIE"),
    workspaceId: readOptionalEnv("ACCEPTANCE_WORKSPACE_ID"),
    userId: readOptionalEnv("ACCEPTANCE_USER_ID"),
  };
}
