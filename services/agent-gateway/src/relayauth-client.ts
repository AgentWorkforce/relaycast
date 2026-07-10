export type RelayAuthTokenClaims = {
  sub: string;
  org: string;
  wks: string;
  scopes: string[];
  sponsorId: string;
  sponsorChain: string[];
  token_type?: "access" | "refresh" | string;
  aud?: string[];
  exp?: number;
  iat?: number;
  jti?: string;
  meta?: Record<string, unknown>;
};

export type RelayAuthTokenIntrospection = {
  active: boolean;
  revoked: boolean;
  reason?: string;
  claims: RelayAuthTokenClaims | null;
};

export type RelayAuthTokenPair = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
  tokenType: string;
};

export type IssuedAgentToken = {
  identityId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
  tokenType: string;
};

export type RelayAuthEnv = {
  RELAYAUTH_URL: string;
  RELAY_AGENT_AUDIENCE?: string;
};

type RelayAuthIdentity = {
  id: string;
};

type RelayAuthRequestOptions = {
  method?: string;
  token?: string;
  apiKey?: string;
  body?: unknown;
};

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_AGENT_TOKEN_TTL_SECONDS = 60 * 60;
const RELAYFILE_AUDIENCE = "relayfile";
const RELAYFILE_READ_SCOPE_PREFIX = "relayfile:fs:read:";

export async function introspectWorkspaceToken(
  env: RelayAuthEnv,
  token: string,
): Promise<RelayAuthTokenClaims | null> {
  const normalizedToken = token.trim();
  if (!normalizedToken) {
    return null;
  }

  // Workspace tokens are validated against RelayAuth's stable introspection route.
  const response = await relayAuthFetch(
    env,
    `/v1/tokens/introspect?token=${encodeURIComponent(normalizedToken)}`,
    {
      apiKey: normalizedToken,
    },
  );

  if (response.status === 404) {
    throw new Error("relayauth introspection endpoint returned 404");
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      detail
        ? `relayauth introspection failed (${response.status}): ${detail}`
        : `relayauth introspection failed (${response.status})`,
    );
  }

  const payload = (await response.json()) as RelayAuthTokenClaims | null;
  return isRelayAuthTokenClaims(payload) ? payload : null;
}

export async function issueAgentToken(
  env: RelayAuthEnv,
  input: {
    workspaceToken: string;
    workspaceClaims: RelayAuthTokenClaims;
    agentId: string;
    agentName?: string;
    scopes?: string[];
    audience?: string[];
  },
): Promise<IssuedAgentToken> {
  const identity = await relayAuthRequest<RelayAuthIdentity>(env, "/v1/identities", {
    method: "POST",
    apiKey: input.workspaceToken,
    body: {
      name: buildIdentityName(input.workspaceClaims.wks, input.agentId, input.agentName),
      type: "agent",
      sponsorId: input.workspaceClaims.sub,
      scopes: dedupeScopes(input.scopes ?? input.workspaceClaims.scopes),
      metadata: {
        agentId: input.agentId,
        agentName: input.agentName ?? input.agentId,
        productId: "agent-gateway",
      },
      workspaceId: input.workspaceClaims.wks,
    },
  });

  const tokenPair = await relayAuthRequest<RelayAuthTokenPair>(env, "/v1/tokens/agent", {
    method: "POST",
    apiKey: input.workspaceToken,
    body: {
      agentId: identity.id,
      scopes: dedupeScopes(input.scopes ?? input.workspaceClaims.scopes),
      audience: dedupeAudience(
        input.audience ?? [env.RELAY_AGENT_AUDIENCE?.trim() || "agent-gateway"],
      ),
      expiresIn: DEFAULT_AGENT_TOKEN_TTL_SECONDS,
    },
  });

  return {
    identityId: identity.id,
    accessToken: tokenPair.accessToken,
    refreshToken: tokenPair.refreshToken,
    accessTokenExpiresAt: tokenPair.accessTokenExpiresAt,
    refreshTokenExpiresAt: tokenPair.refreshTokenExpiresAt,
    tokenType: tokenPair.tokenType,
  };
}

export async function refreshAgentToken(
  env: RelayAuthEnv,
  refreshToken: string,
): Promise<RelayAuthTokenPair> {
  return relayAuthRequest<RelayAuthTokenPair>(env, "/v1/tokens/refresh", {
    method: "POST",
    body: {
      refreshToken,
    },
  });
}

export async function introspectToken(
  env: RelayAuthEnv,
  token: string,
  authToken = token,
): Promise<RelayAuthTokenIntrospection | null> {
  const normalizedToken = token.trim();
  const normalizedAuthToken = authToken.trim();
  if (!normalizedToken || !normalizedAuthToken) {
    return null;
  }

  const response = await relayAuthFetch(
    env,
    `/v1/tokens/introspect?token=${encodeURIComponent(normalizedToken)}`,
    {
      token: normalizedAuthToken,
    },
  );
  if (response.status === 401 || response.status === 403) {
    return null;
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      detail
        ? `relayauth introspection failed (${response.status}): ${detail}`
        : `relayauth introspection failed (${response.status})`,
    );
  }

  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!payload || typeof payload.active !== "boolean" || typeof payload.revoked !== "boolean") {
    throw new Error("relayauth introspection returned an invalid payload");
  }

  return {
    active: payload.active,
    revoked: payload.revoked,
    reason: typeof payload.reason === "string" && payload.reason.trim()
      ? payload.reason
      : undefined,
    claims: isRelayAuthTokenClaims(payload.claims) ? payload.claims : null,
  };
}

export async function issueRelayfileAgentToken(
  env: RelayAuthEnv,
  input: {
    workspaceToken: string;
    workspaceId: string;
    agentName: string;
    scopes: readonly string[];
  },
): Promise<string> {
  const relayfileScopes = selectRelayfileReadScopes(input.scopes);
  if (relayfileScopes.length === 0) {
    throw new Error("workspace token does not grant relayfile read scopes");
  }

  const identity = await relayAuthRequest<RelayAuthIdentity>(env, "/v1/identities", {
    method: "POST",
    apiKey: input.workspaceToken,
    body: {
      name: buildIdentityName(input.workspaceId, input.agentName, input.agentName),
      type: "agent",
      sponsorId: input.agentName,
      scopes: relayfileScopes,
      metadata: {
        agentName: input.agentName,
        productId: "agent-gateway",
        relayfileWorkspaceId: input.workspaceId,
      },
      workspaceId: input.workspaceId,
    },
  });

  const tokenPair = await relayAuthRequest<RelayAuthTokenPair>(env, "/v1/tokens/agent", {
    method: "POST",
    apiKey: input.workspaceToken,
    body: {
      agentId: identity.id,
      scopes: relayfileScopes,
      audience: [RELAYFILE_AUDIENCE],
      expiresIn: DEFAULT_AGENT_TOKEN_TTL_SECONDS,
    },
  });

  if (!tokenPair.accessToken?.trim()) {
    throw new Error("relayauth relayfile token response did not include accessToken");
  }

  return tokenPair.accessToken;
}

export function selectRelayfileReadScopes(scopes: readonly string[]): string[] {
  return [...new Set(
    scopes
      .map((scope) => scope.trim())
      .filter((scope) => scope.startsWith(RELAYFILE_READ_SCOPE_PREFIX)),
  )];
}

async function relayAuthRequest<T>(
  env: RelayAuthEnv,
  path: string,
  options: RelayAuthRequestOptions,
): Promise<T> {
  const response = await relayAuthFetch(env, path, options);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      detail
        ? `relayauth request failed (${response.status}) ${path}: ${detail}`
        : `relayauth request failed (${response.status}) ${path}`,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function relayAuthFetch(
  env: RelayAuthEnv,
  path: string,
  options: RelayAuthRequestOptions,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_FETCH_TIMEOUT_MS);

  try {
    const url = new URL(path, normalizeBaseUrl(env.RELAYAUTH_URL));
    const headers = new Headers();

    if (options.token) {
      headers.set("authorization", `Bearer ${options.token}`);
    }
    if (options.apiKey) {
      // relayauth workspace tokens are API keys (`relay_ws_*`), not bearer JWTs.
      headers.set("x-api-key", options.apiKey);
    }

    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.body);
    }

    return await globalThis.fetch(url, {
      method: options.method,
      headers,
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function buildIdentityName(
  workspaceId: string,
  agentId: string,
  agentName?: string,
): string {
  const safeWorkspace = workspaceId.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 32);
  const safeAgent = (agentName ?? agentId)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .slice(0, 48);
  return `${safeAgent || "agent"}-${safeWorkspace}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

function dedupeScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
}

function dedupeAudience(audience: readonly string[]): string[] {
  return [...new Set(audience.map((entry) => entry.trim()).filter(Boolean))];
}

function isRelayAuthTokenClaims(value: unknown): value is RelayAuthTokenClaims {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { sub?: unknown }).sub === "string" &&
    typeof (value as { org?: unknown }).org === "string" &&
    typeof (value as { wks?: unknown }).wks === "string" &&
    typeof (value as { sponsorId?: unknown }).sponsorId === "string" &&
    Array.isArray((value as { sponsorChain?: unknown }).sponsorChain) &&
    Array.isArray((value as { scopes?: unknown }).scopes)
  );
}
