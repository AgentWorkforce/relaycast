import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "agent_relay_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export type SessionClaims = {
  userId: string;
  currentOrganizationId: string;
  currentWorkspaceId: string;
  iat: number;
  exp: number;
};

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function createSessionClaims(input: {
  userId: string;
  currentOrganizationId: string;
  currentWorkspaceId: string;
}): SessionClaims {
  const issuedAt = Math.floor(Date.now() / 1000);
  return {
    ...input,
    iat: issuedAt,
    exp: issuedAt + SESSION_TTL_SECONDS,
  };
}

export function encodeSessionToken(claims: SessionClaims, secret: string): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signature = sign(`${header}.${payload}`, secret);
  return `${header}.${payload}.${signature}`;
}

export function decodeSessionToken(token: string, secret: string): SessionClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [header, payload, signature] = parts;
  const expected = sign(`${header}.${payload}`, secret);
  const provided = Buffer.from(signature);
  const computed = Buffer.from(expected);
  if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) {
    return null;
  }

  try {
    const parsed = JSON.parse(base64UrlDecode(payload)) as Partial<SessionClaims>;
    if (
      typeof parsed.userId !== "string" ||
      typeof parsed.currentOrganizationId !== "string" ||
      typeof parsed.currentWorkspaceId !== "string" ||
      typeof parsed.iat !== "number" ||
      typeof parsed.exp !== "number"
    ) {
      return null;
    }

    if (parsed.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }

    return parsed as SessionClaims;
  } catch {
    return null;
  }
}
