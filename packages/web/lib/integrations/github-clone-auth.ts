import { timingSafeEqual } from "node:crypto";
import { Resource } from "sst";

type TokenResourceName = "SageCloudApiToken" | "SpecialistCloudApiToken";

type TokenResources = Partial<Record<TokenResourceName, { value?: string }>>;

const TOKEN_RESOURCE_NAMES: TokenResourceName[] = [
  "SageCloudApiToken",
  "SpecialistCloudApiToken",
];

const TOKEN_HEADER_NAMES = [
  "authorization",
  "SageCloudApiToken",
  "SpecialistCloudApiToken",
  "x-sage-cloud-api-token",
  "x-specialist-cloud-api-token",
] as const;

function getConfiguredToken(name: TokenResourceName): string | null {
  try {
    const resources = Resource as unknown as TokenResources;
    const resourceValue = resources[name]?.value?.trim();
    if (resourceValue) {
      return resourceValue;
    }
  } catch {
    // Local tests and scripts run outside the SST multiplexer; env fallback
    // below keeps those paths deterministic while deployed code uses Resource.
  }

  const envValue = process.env[name]?.trim();
  return envValue || null;
}

function getConfiguredTokens(): string[] {
  return TOKEN_RESOURCE_NAMES
    .map((name) => getConfiguredToken(name))
    .filter((value): value is string => Boolean(value));
}

function extractRequestTokens(request: Request): string[] {
  const tokens: string[] = [];

  for (const headerName of TOKEN_HEADER_NAMES) {
    const rawValue = request.headers.get(headerName)?.trim();
    if (!rawValue) {
      continue;
    }

    if (headerName === "authorization") {
      const bearerToken = rawValue.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
      if (bearerToken) {
        tokens.push(bearerToken);
      }
      continue;
    }

    tokens.push(rawValue);
  }

  return tokens;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.byteLength !== rightBuffer.byteLength) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function isAuthorizedGithubCloneRequest(request: Request): boolean {
  const configuredTokens = getConfiguredTokens();
  if (configuredTokens.length === 0) {
    return false;
  }

  return extractRequestTokens(request).some((candidate) =>
    configuredTokens.some((configured) => constantTimeEqual(candidate, configured)),
  );
}
