export function loadDatabaseUrl(
  env?: Record<string, string | undefined>,
): string;

export function resolveDrizzleDatabaseUrl(
  env?: Record<string, string | undefined>,
): string;

export function toDirectEndpoint(connectionString: string): string;
