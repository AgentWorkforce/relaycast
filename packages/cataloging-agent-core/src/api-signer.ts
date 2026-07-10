import type { CatalogingTokenClaims, CatalogingTokenSigner } from "./context.js";

const DEFAULT_RELAYAUTH_URL = "https://api.relayauth.dev";

async function callFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

async function relayAuthRequest<T>(
  baseUrl: string,
  apiKey: string,
  path: string,
  init: { method?: string; body?: unknown; headers?: HeadersInit } = {},
): Promise<T> {
  const url = new URL(path, baseUrl);
  const headers = new Headers(init.headers);
  headers.set("x-api-key", apiKey);

  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.body);
  }

  const response = await callFetch(url.toString(), {
    method: init.method,
    headers,
    body,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      detail
        ? `RelayAuth request failed (${response.status}) ${path}: ${detail}`
        : `RelayAuth request failed (${response.status}) ${path}`,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

function buildIdentityName(workspaceId: string, agentName: string): string {
  const safeWorkspace = workspaceId.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 32);
  const safeAgent = agentName.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 48);
  return `${safeAgent || "cataloging-agent"}-${safeWorkspace}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

export function createRelayauthApiSigner(input: {
  baseUrl?: string;
  apiKey: string;
}): CatalogingTokenSigner {
  const apiKey = input.apiKey.trim();
  if (!apiKey) {
    throw new Error("createRelayauthApiSigner: apiKey is required");
  }
  const baseUrl = normalizeBaseUrl(input.baseUrl?.trim() || DEFAULT_RELAYAUTH_URL);

  return async (claims: CatalogingTokenClaims) => {
    const identity = await relayAuthRequest<{ id: string }>(baseUrl, apiKey, "/v1/identities", {
      method: "POST",
      body: {
        name: buildIdentityName(claims.workspace_id, claims.agent_name),
        type: "agent",
        sponsorId: claims.agent_name,
        scopes: claims.scopes,
        metadata: {
          agentName: claims.agent_name,
          productId: "cataloging",
          relayfileWorkspaceId: claims.workspace_id,
          domain: claims.meta.domain,
        },
        workspaceId: claims.workspace_id,
      },
    });

    const now = Math.floor(Date.now() / 1000);
    const tokenPair = await relayAuthRequest<{ accessToken: string }>(
      baseUrl,
      apiKey,
      "/v1/tokens",
      {
        method: "POST",
        body: {
          identityId: identity.id,
          scopes: claims.scopes,
          audience: claims.aud,
          expiresIn: Math.max(1, claims.exp - now),
        },
      },
    );

    return tokenPair.accessToken;
  };
}
