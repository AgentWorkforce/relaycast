import { optionalEnv, tryResourceValue } from "./env";
import { resolveRelayAuthConfig } from "./relayfile";

const DEFAULT_RELAYHISTORY_URL = "https://history.agentrelay.com";
const RELAYHISTORY_AUDIENCE = "relayhistory";
const RELAYHISTORY_ASSERTION_TTL_SECONDS = 60;
const RELAYHISTORY_ASSERTION_ENDPOINT = "/v1/tokens/relayhistory-assertion";
const RELAYHISTORY_SESSION_ENDPOINT = "/v1/cli/login";
const RELAYHISTORY_ASSERTION_API_KEY_ENV = "RELAYHISTORY_ASSERTION_RELAYAUTH_API_KEY";
// Disabled-marker placeholders. When the real key is not provisioned
// (relayhistory-cloud#10), the secret resolves to a non-empty sentinel so
// read-only `sst diff` (which seeds no secrets) and the non-empty boot check
// both pass. Per-environment variants all share the same suffix:
//   - "production-relayhistory-assertion-disabled" — SST Secret default
//     (infra/secrets.ts), used by the prod read-only diff.
//   - "preview-relayhistory-assertion-disabled"    — preview seed
//     (.github/scripts/seed-sst-secrets.sh).
//   - "<stage>-relayhistory-assertion-disabled"    — dev/staging GitHub
//     Environment placeholders.
// Treat any of them as "not configured" so the login bridge stays cleanly
// disabled across every stage instead of minting assertions with a junk key.
const RELAYHISTORY_ASSERTION_DISABLED_SUFFIX = "relayhistory-assertion-disabled";

function isRelayhistoryAssertionDisabledPlaceholder(value: string): boolean {
  return value === RELAYHISTORY_ASSERTION_DISABLED_SUFFIX
    || value.endsWith(`-${RELAYHISTORY_ASSERTION_DISABLED_SUFFIX}`);
}

export type RelayhistorySessionMode = "read" | "sync";

export type RelayhistorySessionRequest = {
  userId: string;
  orgId: string;
  workspaceId: string;
  label?: string;
  mode: RelayhistorySessionMode;
};

export type RelayhistorySessionResponse = {
  baseUrl: string;
  sessionId?: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  tokenType: "Bearer";
  scopes: string[];
  orgId: string;
  workspaceId: string;
};

type RelayAuthAssertionResponse = {
  accessToken?: unknown;
};

type RelayhistoryLoginResponse = {
  sessionId?: unknown;
  accessToken?: unknown;
  accessTokenExpiresAt?: unknown;
  refreshToken?: unknown;
  refreshTokenExpiresAt?: unknown;
  tokenType?: unknown;
  scopes?: unknown;
};

type RequestJsonOptions = {
  baseUrl: string;
  path: string;
  apiKey?: string;
  body: unknown;
};

export function resolveRelayhistoryUrl(): string {
  return stripTrailingSlash(
    optionalEnv("RELAYHISTORY_URL")
      ?? optionalEnv("RelayhistoryUrl")
      ?? DEFAULT_RELAYHISTORY_URL,
  );
}

export function resolveRelayhistoryAssertionApiKey(): string {
  // Treat a disabled-marker placeholder as absent *before* falling back, so a
  // real env override still wins when the SST Resource resolves to the
  // placeholder default (e.g. local dev against a prod-diff-style stage).
  return realKeyOrUndefined(tryResourceValue("RelayhistoryAssertionRelayauthApiKey"))
    ?? realKeyOrUndefined(optionalEnv(RELAYHISTORY_ASSERTION_API_KEY_ENV))
    ?? "";
}

function realKeyOrUndefined(value: string | undefined): string | undefined {
  // Trim first so a copy/paste with surrounding whitespace neither slips past
  // the placeholder check nor gets sent upstream as a junk key.
  const trimmed = value?.trim();
  if (!trimmed || isRelayhistoryAssertionDisabledPlaceholder(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function relayhistoryScopesForMode(mode: RelayhistorySessionMode): string[] {
  return mode === "sync" ? ["rth:read", "rth:sync"] : ["rth:read"];
}

export async function createRelayhistorySession(
  input: RelayhistorySessionRequest,
): Promise<RelayhistorySessionResponse> {
  const relayhistoryUrl = resolveRelayhistoryUrl();
  const { relayAuthUrl } = resolveRelayAuthConfig();
  const relayAuthApiKey = resolveRelayhistoryAssertionApiKey();
  if (!relayAuthApiKey.trim()) {
    throw new Error("Relayhistory assertion RelayAuth API key is not configured");
  }

  const scopes = relayhistoryScopesForMode(input.mode);
  const assertion = await mintRelayhistoryAssertion({
    relayAuthUrl,
    relayAuthApiKey,
    userId: input.userId,
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    scopes,
    mode: input.mode,
  });
  validateRelayhistoryAssertionClaims(assertion, {
    userId: input.userId,
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    scopes,
  });
  const session = await loginToRelayhistory({
    relayhistoryUrl,
    assertion,
    label: input.label,
  });

  return {
    ...session,
    baseUrl: relayhistoryUrl,
    orgId: input.orgId,
    workspaceId: input.workspaceId,
  };
}

async function mintRelayhistoryAssertion(input: {
  relayAuthUrl: string;
  relayAuthApiKey: string;
  userId: string;
  orgId: string;
  workspaceId: string;
  scopes: string[];
  mode: RelayhistorySessionMode;
}): Promise<string> {
  const token = await requestJson<RelayAuthAssertionResponse>({
    baseUrl: input.relayAuthUrl,
    path: RELAYHISTORY_ASSERTION_ENDPOINT,
    apiKey: input.relayAuthApiKey,
    body: {
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      sponsorId: input.userId,
      scopes: input.scopes,
      expiresIn: RELAYHISTORY_ASSERTION_TTL_SECONDS,
      metadata: {
        productId: "cloud",
        purpose: "relayhistory-login",
        cloudUserId: input.userId,
        cloudOrgId: input.orgId,
        cloudWorkspaceId: input.workspaceId,
        requestedMode: input.mode,
        grantedMode: input.mode,
      },
    },
  });

  if (typeof token.accessToken !== "string" || !token.accessToken.trim()) {
    throw new Error("RelayAuth token response did not include accessToken");
  }
  return token.accessToken;
}

async function loginToRelayhistory(input: {
  relayhistoryUrl: string;
  assertion: string;
  label?: string;
}): Promise<Omit<RelayhistorySessionResponse, "baseUrl" | "orgId" | "workspaceId">> {
  const response = await requestJson<RelayhistoryLoginResponse>({
    baseUrl: input.relayhistoryUrl,
    path: RELAYHISTORY_SESSION_ENDPOINT,
    body: {
      agentRelayToken: input.assertion,
      ...(input.label ? { label: input.label } : {}),
    },
  });

  if (
    typeof response.accessToken !== "string" ||
    typeof response.accessTokenExpiresAt !== "string" ||
    typeof response.refreshToken !== "string" ||
    typeof response.refreshTokenExpiresAt !== "string" ||
    response.tokenType !== "Bearer"
  ) {
    throw new Error("Relayhistory login response did not include expected session fields");
  }

  return {
    ...(typeof response.sessionId === "string" ? { sessionId: response.sessionId } : {}),
    accessToken: response.accessToken,
    accessTokenExpiresAt: response.accessTokenExpiresAt,
    refreshToken: response.refreshToken,
    refreshTokenExpiresAt: response.refreshTokenExpiresAt,
    tokenType: "Bearer",
    scopes: Array.isArray(response.scopes)
      ? response.scopes.filter((scope): scope is string => typeof scope === "string")
      : [],
  };
}

async function requestJson<T>(options: RequestJsonOptions): Promise<T> {
  const url = new URL(options.path, `${stripTrailingSlash(options.baseUrl)}/`);
  const headers = new Headers({ "content-type": "application/json" });
  if (options.apiKey) {
    headers.set("x-api-key", options.apiKey);
  }

  const response = await fetch(url.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify(options.body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      detail
        ? `Request failed (${response.status}) ${url.pathname}: ${detail.slice(0, 500)}`
        : `Request failed (${response.status}) ${url.pathname}`,
    );
  }
  return (await response.json()) as T;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function validateRelayhistoryAssertionClaims(
  token: string,
  expected: {
    userId: string;
    orgId: string;
    workspaceId: string;
    scopes: string[];
  },
): void {
  const claims = decodeJwtPayload(token);
  const aud = claims.aud;
  const scopes = Array.isArray(claims.scopes)
    ? claims.scopes.filter((scope): scope is string => typeof scope === "string")
    : [];
  const sortedScopes = [...new Set(scopes)].sort();
  const expectedScopes = [...new Set(expected.scopes)].sort();
  const hasExactExpectedScopes =
    sortedScopes.length === expectedScopes.length &&
    sortedScopes.every((scope, index) => scope === expectedScopes[index]);

  if (
    claims.org !== expected.orgId ||
    claims.wks !== expected.workspaceId ||
    claims.sponsorId !== expected.userId ||
    !audienceIncludes(aud, RELAYHISTORY_AUDIENCE) ||
    !hasExactExpectedScopes
  ) {
    throw new Error("RelayAuth assertion claims did not match Cloud auth context");
  }
}

function audienceIncludes(value: unknown, expected: string): boolean {
  return typeof value === "string"
    ? value === expected
    : Array.isArray(value) && value.includes(expected);
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const raw = token.trim();
  const jwt = stripRelayTokenPrefix(raw);
  const parts = jwt.split(".");
  if (parts.length !== 3 || !parts[1]) {
    throw new Error("RelayAuth assertion was not a JWT");
  }
  const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  try {
    const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid payload");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("RelayAuth assertion payload was invalid");
  }
}

function stripRelayTokenPrefix(value: string): string {
  const prefixes = ["relay_ag_", "relay_pa_", "relay_ws_", "relay_id_"];
  const prefix = prefixes.find((candidate) => value.startsWith(candidate));
  return prefix ? value.slice(prefix.length) : value;
}
