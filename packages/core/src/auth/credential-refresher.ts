import { parseCredentialExpiry } from "./credential-expiry.js";
import type { DaytonaCredential } from "./credential-store.js";

const ANTHROPIC_TOKEN_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
const OPENAI_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const XAI_TOKEN_ENDPOINT = "https://auth.x.ai/oauth2/token";
const DAYTONA_TOKEN_ENDPOINT = "https://daytonaio.us.auth0.com/oauth/token";
const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_ANTHROPIC_EXPIRES_IN_SECONDS = 28800;
const DEFAULT_XAI_EXPIRES_IN_SECONDS = 21600;
const DEFAULT_DAYTONA_EXPIRES_IN_SECONDS = 86400;

export interface RefreshResult {
  credentialJson: string;
  expiresAt: Date | null;
}

export type RefreshableCredentialProvider =
  | "anthropic"
  | "openai"
  | "xai"
  | "daytona";

interface AnthropicOauthCredential {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

interface AnthropicCredential {
  claudeAiOauth?: AnthropicOauthCredential;
  [key: string]: unknown;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

interface OpenAiTokens {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  account_id?: string;
  [key: string]: unknown;
}

interface OpenAiCredential {
  auth_mode?: string;
  tokens?: OpenAiTokens;
  last_refresh?: string;
  [key: string]: unknown;
}

interface TokenRefreshResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  [key: string]: unknown;
}

/**
 * xai (Grok CLI) `~/.grok/auth.json` shape: a map keyed by OIDC scope
 * (`"https://auth.x.ai::<client_id>"`) whose value holds the access token in
 * `key` plus `refresh_token` / `expires_at` (ISO) / `oidc_client_id`.
 * Refresh tokens are SINGLE-USE — auth.x.ai rotates them on every refresh —
 * so every successful refresh MUST be persisted or the stored credential dies.
 */
interface XaiScopeCredential {
  key?: string;
  refresh_token?: string;
  expires_at?: string;
  create_time?: string;
  oidc_client_id?: string;
  [key: string]: unknown;
}

type XaiCredential = Record<string, XaiScopeCredential>;

export async function refreshCredential(
  provider: RefreshableCredentialProvider,
  credentialJson: string,
): Promise<RefreshResult> {
  if (provider === "xai") {
    return refreshXaiCredential(credentialJson);
  }
  if (provider === "daytona") {
    return refreshDaytonaCredential(credentialJson);
  }
  const parsed = parseCredentialJson(credentialJson);

  const refreshToken = getRefreshToken(provider, parsed);
  const response = await requestTokenRefresh(provider, refreshToken);
  const updated = buildUpdatedCredential(provider, parsed, response);
  const nextCredentialJson = JSON.stringify(updated);

  return {
    credentialJson: nextCredentialJson,
    expiresAt: parseCredentialExpiry(nextCredentialJson),
  };
}

async function refreshXaiCredential(credentialJson: string): Promise<RefreshResult> {
  let parsed: XaiCredential;
  try {
    parsed = JSON.parse(credentialJson) as XaiCredential;
  } catch {
    throw new Error("Invalid credential JSON");
  }

  const entry = Object.entries(parsed).find(
    ([, value]) =>
      value && typeof value === "object" && typeof value.refresh_token === "string",
  );
  if (!entry) {
    throw new Error("Missing refresh token for xai");
  }
  const [scope, cred] = entry;

  const clientId =
    typeof cred.oidc_client_id === "string" && cred.oidc_client_id.length > 0
      ? cred.oidc_client_id
      : scope.split("::")[1];
  if (!clientId) {
    throw new Error("Missing OIDC client id in xai credential");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: cred.refresh_token as string,
    client_id: clientId,
  });
  const response = await fetch(XAI_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(
      `Token refresh failed for xai: HTTP ${response.status} — ${responseBody}`,
    );
  }
  const tokens = (await response.json()) as TokenRefreshResponse;
  if (typeof tokens.access_token !== "string" || tokens.access_token.length === 0) {
    throw new Error("Missing access_token in xai refresh response");
  }

  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + (tokens.expires_in ?? DEFAULT_XAI_EXPIRES_IN_SECONDS) * 1000,
  );
  const updated: XaiCredential = {
    ...parsed,
    [scope]: {
      ...cred,
      key: tokens.access_token,
      // auth.x.ai rotates refresh tokens; keep the old one only if the
      // response unexpectedly omits a new one.
      refresh_token: tokens.refresh_token ?? (cred.refresh_token as string),
      create_time: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    },
  };

  return {
    credentialJson: JSON.stringify(updated),
    expiresAt,
  };
}

async function refreshDaytonaCredential(
  credentialJson: string,
): Promise<RefreshResult> {
  let parsed: DaytonaCredential;
  try {
    parsed = JSON.parse(credentialJson) as DaytonaCredential;
  } catch {
    throw new Error("Invalid credential JSON");
  }

  if (parsed.provider !== "daytona") {
    throw new Error("Invalid provider for daytona credential");
  }
  if (typeof parsed.refreshToken !== "string" || parsed.refreshToken.length === 0) {
    throw new Error("Missing refresh token for daytona");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: requiredEnv("DAYTONA_AUTH0_CLIENT_ID"),
    client_secret: requiredEnv("DAYTONA_AUTH0_CLIENT_SECRET"),
    refresh_token: parsed.refreshToken,
  });
  const response = await fetch(DAYTONA_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(
      `Token refresh failed for daytona: HTTP ${response.status} — ${responseBody}`,
    );
  }

  const tokens = (await response.json()) as TokenRefreshResponse;
  if (typeof tokens.access_token !== "string" || tokens.access_token.length === 0) {
    throw new Error("Missing access_token in daytona refresh response");
  }

  const expiresAt = new Date(
    Date.now() +
      (tokens.expires_in ?? DEFAULT_DAYTONA_EXPIRES_IN_SECONDS) * 1000,
  );
  const updated: DaytonaCredential = {
    ...parsed,
    provider: "daytona",
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? parsed.refreshToken,
    expiresAt: expiresAt.toISOString(),
  };

  return {
    credentialJson: JSON.stringify(updated),
    expiresAt,
  };
}

function parseCredentialJson(
  credentialJson: string,
): AnthropicCredential | OpenAiCredential {
  try {
    return JSON.parse(credentialJson) as AnthropicCredential | OpenAiCredential;
  } catch {
    throw new Error("Invalid credential JSON");
  }
}

function getRefreshToken(
  provider: "anthropic" | "openai",
  parsed: AnthropicCredential | OpenAiCredential,
): string {
  if (provider === "anthropic") {
    const refreshToken = (parsed as AnthropicCredential).claudeAiOauth?.refreshToken;
    if (typeof refreshToken === "string" && refreshToken.length > 0) {
      return refreshToken;
    }
  } else {
    const refreshToken = (parsed as OpenAiCredential).tokens?.refresh_token;
    if (typeof refreshToken === "string" && refreshToken.length > 0) {
      return refreshToken;
    }
  }

  throw new Error(`Missing refresh token for ${provider}`);
}

async function requestTokenRefresh(
  provider: "anthropic" | "openai",
  refreshToken: string,
): Promise<TokenRefreshResponse> {
  const endpoint =
    provider === "anthropic" ? ANTHROPIC_TOKEN_ENDPOINT : OPENAI_TOKEN_ENDPOINT;
  const clientId =
    provider === "anthropic" ? ANTHROPIC_CLIENT_ID : OPENAI_CLIENT_ID;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(
      `Token refresh failed for ${provider}: HTTP ${response.status} — ${responseBody}`,
    );
  }

  return (await response.json()) as TokenRefreshResponse;
}

function buildUpdatedCredential(
  provider: "anthropic" | "openai",
  parsed: AnthropicCredential | OpenAiCredential,
  response: TokenRefreshResponse,
): AnthropicCredential | OpenAiCredential {
  if (provider === "anthropic") {
    const original = parsed as AnthropicCredential;
    if (typeof response.access_token !== "string" || response.access_token.length === 0) {
      throw new Error("Missing access_token in anthropic refresh response");
    }
    if (typeof response.refresh_token !== "string" || response.refresh_token.length === 0) {
      throw new Error("Missing refresh_token in anthropic refresh response");
    }

    return {
      ...original,
      claudeAiOauth: {
        ...original.claudeAiOauth,
        accessToken: response.access_token,
        refreshToken: response.refresh_token,
        expiresAt:
          Date.now() +
          (response.expires_in ?? DEFAULT_ANTHROPIC_EXPIRES_IN_SECONDS) * 1000,
      },
    };
  }

  const original = parsed as OpenAiCredential;
  const originalRefreshToken = original.tokens?.refresh_token;

  if (typeof response.access_token !== "string" || response.access_token.length === 0) {
    throw new Error("Missing access_token in openai refresh response");
  }
  if (typeof originalRefreshToken !== "string" || originalRefreshToken.length === 0) {
    throw new Error("Missing refresh token for openai");
  }

  return {
    ...original,
    tokens: {
      ...original.tokens,
      access_token: response.access_token,
      refresh_token: response.refresh_token ?? originalRefreshToken,
    },
    last_refresh: new Date().toISOString(),
  };
}
