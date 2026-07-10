export interface DaytonaAuthCredentials {
  apiKey?: string;
  jwtToken?: string;
  organizationId?: string;
}

export type ResolvedDaytonaAuthCredentials =
  | { apiKey: string }
  | { jwtToken: string; organizationId: string };

export function resolveDaytonaAuthCredentials(
  credentials: DaytonaAuthCredentials,
): ResolvedDaytonaAuthCredentials {
  const apiKey = credentials.apiKey?.trim();
  if (apiKey) {
    return { apiKey };
  }

  const jwtToken = credentials.jwtToken?.trim();
  if (!jwtToken) {
    throw new Error('Daytona auth is required in credential bundle');
  }

  const organizationId = credentials.organizationId?.trim();
  if (!organizationId) {
    throw new Error('DAYTONA_ORGANIZATION_ID is required when using Daytona JWT auth');
  }

  return { jwtToken, organizationId };
}

export function applyDaytonaAuthEnv(
  env: Record<string, string>,
  credentials: DaytonaAuthCredentials,
): void {
  const resolved = resolveDaytonaAuthCredentials(credentials);
  if ('apiKey' in resolved) {
    env.DAYTONA_API_KEY = resolved.apiKey;
    // Clear the JWT-mode env keys so a caller flipping from JWT to apiKey
    // auth doesn't leave stale credentials in the bag that downstream
    // consumers might read and prefer over the apiKey path.
    delete env.DAYTONA_JWT_TOKEN;
    delete env.DAYTONA_ORGANIZATION_ID;
    return;
  }

  env.DAYTONA_JWT_TOKEN = resolved.jwtToken;
  env.DAYTONA_ORGANIZATION_ID = resolved.organizationId;
  // Same logic in reverse: a JWT-auth caller should not see a lingering
  // DAYTONA_API_KEY from an earlier mode that would silently take
  // priority over the freshly-applied JWT.
  delete env.DAYTONA_API_KEY;
}
