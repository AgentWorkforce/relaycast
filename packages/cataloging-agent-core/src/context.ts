import type { RelayFileClient } from "@relayfile/sdk";
import type { RelayAuthTokenClaims, TokenPair } from "@relayauth/sdk";

export interface CatalogingContext<TEnv = unknown> {
  workspaceId: string;
  domain: string;
  relayfile: RelayFileClient;
  relayfileUrl: string;
  relayfileToken: string;
  env: TEnv;
  now: Date;
  signal?: AbortSignal;
}

export type CatalogingTokenClaims = Partial<RelayAuthTokenClaims> & {
  workspace_id: string;
  wks: string;
  aud: string[];
  agent_name: string;
  scopes: string[];
  iat: number;
  exp: number;
  jti: string;
  meta: Record<string, string>;
};

export type CatalogingTokenSignerResult =
  | string
  | TokenPair
  | {
      accessToken?: string;
      token?: string;
      jwt?: string;
    };

export type CatalogingTokenSigner =
  | ((claims: CatalogingTokenClaims) => CatalogingTokenSignerResult | Promise<CatalogingTokenSignerResult>)
  | {
      sign(claims: CatalogingTokenClaims): CatalogingTokenSignerResult | Promise<CatalogingTokenSignerResult>;
    }
  | {
      mint(claims: CatalogingTokenClaims): CatalogingTokenSignerResult | Promise<CatalogingTokenSignerResult>;
    }
  | {
      issueToken(claims: CatalogingTokenClaims): CatalogingTokenSignerResult | Promise<CatalogingTokenSignerResult>;
    };

export interface MintCatalogingTokenOptions {
  domain?: string;
  scopes?: readonly string[];
  ttlSeconds?: number;
  now?: Date;
}

const DEFAULT_TOKEN_TTL_SECONDS = 60 * 60;
// Relayfile's auth middleware does exact-match scope checks (`fs:read` /
// `fs:write`) — no prefix or path qualifier handling. Tokens minted with
// `relayfile:fs:read:*` get a successful signature/audience verify but fail
// the per-route scope gate, so every read/write 403s.
const DEFAULT_SCOPES = ["fs:read", "fs:write"];

export async function mintCatalogingToken(
  relayauthSigner: CatalogingTokenSigner,
  workspaceId: string,
  options: MintCatalogingTokenOptions = {},
): Promise<string> {
  const domain = normalizeTokenPart(options.domain ?? signerDomain(relayauthSigner) ?? "default");
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const agentName = `cataloging-agent-${domain}`;
  const claims: CatalogingTokenClaims = {
    sub: agentName,
    org: workspaceId,
    wks: workspaceId,
    workspace_id: workspaceId,
    agent_name: agentName,
    sponsorId: agentName,
    sponsorChain: [agentName],
    token_type: "access",
    iss: "cataloging-agent-core",
    aud: ["relayfile"],
    scopes: [...new Set(options.scopes ?? DEFAULT_SCOPES)],
    iat: nowSeconds,
    nbf: nowSeconds,
    exp: nowSeconds + Math.max(1, Math.floor(options.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS)),
    jti: `cataloging-${crypto.randomUUID()}`,
    meta: {
      domain,
      workspaceId,
    },
  };

  return extractToken(await callSigner(relayauthSigner, claims));
}

async function callSigner(
  signer: CatalogingTokenSigner,
  claims: CatalogingTokenClaims,
): Promise<CatalogingTokenSignerResult> {
  if (typeof signer === "function") {
    return signer(claims);
  }
  if ("sign" in signer && typeof signer.sign === "function") {
    return signer.sign(claims);
  }
  if ("mint" in signer && typeof signer.mint === "function") {
    return signer.mint(claims);
  }
  if ("issueToken" in signer && typeof signer.issueToken === "function") {
    return signer.issueToken(claims);
  }
  throw new Error("relayauthSigner must be a function or expose sign(), mint(), or issueToken()");
}

function extractToken(result: CatalogingTokenSignerResult): string {
  if (typeof result === "string") {
    return result;
  }
  const fallback = result as { token?: string; jwt?: string };
  const token = result.accessToken ?? fallback.token ?? fallback.jwt;
  if (!token) {
    throw new Error("relayauthSigner did not return an access token");
  }
  return token;
}

function signerDomain(signer: CatalogingTokenSigner): string | undefined {
  if (typeof signer === "function") {
    return readString((signer as { domain?: unknown }).domain);
  }
  return readString((signer as { domain?: unknown }).domain);
}

function normalizeTokenPart(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "default";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
